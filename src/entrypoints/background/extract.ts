import { DESCRIPTOR_CAP, INDEX_CAP, TEXT_CAP, type PageIndex } from "@/lib/page-index";
import { send } from "./cdp";

/**
 * Runs inside the page via `Runtime.evaluate`, so it must be entirely
 * self-contained — no imports, no closure over anything in this module.
 * It is stringified and injected.
 */
function extractPage(indexCap: number, textCap: number, descriptorCap: number) {
  const MAX_LABEL = 40;

  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox",
    "menuitemradio", "option", "switch", "textbox", "combobox", "searchbox",
    "slider", "spinbutton", "treeitem", "listbox",
  ]);

  const TAG_ROLE: Record<string, string> = {
    a: "link", button: "button", select: "combobox", textarea: "textbox",
    summary: "button", details: "group",
  };

  const INPUT_ROLE: Record<string, string> = {
    checkbox: "checkbox", radio: "radio", submit: "button", button: "button",
    reset: "button", image: "button", search: "searchbox", range: "slider",
    number: "spinbutton", file: "button",
  };

  interface Candidate {
    el: Element;
    doc: Document;
    offX: number;
    offY: number;
    frame: string;
    order: number;
  }

  const candidates: Candidate[] = [];
  let order = 0;

  /** Attributes and tags only: no layout, no style. Runs on every node. */
  function isInteractiveByMarkup(el: Element): boolean {
    const tag = el.tagName.toLowerCase();

    if (tag === "a") return el.hasAttribute("href");
    if (tag === "button" || tag === "select" || tag === "textarea" || tag === "summary") {
      return true;
    }
    if (tag === "input") return (el as HTMLInputElement).type !== "hidden";

    const role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) return true;

    if (el.hasAttribute("onclick")) return true;
    if (el.hasAttribute("contenteditable")) return true;

    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && Number(tabindex) >= 0) return true;

    return false;
  }

  /**
   * The div-as-button pattern modern sites are built from. Needs computed
   * style, which is the expensive call here, so it is gated on a leaf node
   * with a plausible amount of text — `textContent` rather than `innerText`,
   * because `innerText` forces layout.
   */
  function mightBeStyledButton(el: Element): boolean {
    if (el.children.length > 0) return false;
    const text = el.textContent;
    if (!text) return false;
    const len = text.trim().length;
    return len > 0 && len < 120;
  }

  function isVisible(el: Element, style: CSSStyleDeclaration, rect: DOMRect): boolean {
    if (rect.width < 2 || rect.height < 2) return false;
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (Number(style.opacity) === 0) return false;
    if (el.hasAttribute("inert")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    return true;
  }

  /** Descends through shadow roots so the hit test sees what the user sees. */
  function deepElementFromPoint(doc: Document, x: number, y: number): Element | null {
    let hit = doc.elementFromPoint(x, y);
    let guard = 0;
    while (hit && hit.shadowRoot && guard++ < 12) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  /**
   * The single most valuable filter: an element whose own centre belongs to
   * something else is covered, and clicking it would hit a cookie banner or a
   * modal instead. Without this the agent looks stupid for reasons that have
   * nothing to do with the model.
   */
  function isTopmost(el: Element, doc: Document, rect: DOMRect): boolean {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const view = doc.defaultView;
    if (!view) return false;
    if (cx < 0 || cy < 0 || cx > view.innerWidth || cy > view.innerHeight) {
      // Off-screen elements cannot be hit-tested; keep them and let the caller
      // mark them out of viewport.
      return true;
    }

    const hit = deepElementFromPoint(doc, cx, cy);
    if (!hit) return false;
    if (hit === el) return true;
    if (el.contains(hit)) return true;
    // A wrapper painted over its own child is still the same control.
    if (hit.contains(el)) return true;

    // Shadow boundaries break contains(); compare the composed path instead.
    const path = (hit as Element & { getRootNode(): Node }).getRootNode();
    if (path instanceof ShadowRoot && path.host === el) return true;

    return false;
  }

  function labelFor(el: Element): string {
    const attr = (n: string) => el.getAttribute(n)?.trim() ?? "";

    let label = attr("aria-label");

    if (!label) {
      const by = attr("aria-labelledby");
      if (by) {
        label = by
          .split(/\s+/)
          .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
      }
    }

    if (!label) {
      const text = (el as HTMLElement).innerText ?? el.textContent ?? "";
      label = text.replace(/\s+/g, " ").trim();
    }

    if (!label && el instanceof HTMLInputElement) label = el.value.trim();
    if (!label) label = attr("placeholder");
    if (!label) label = attr("title");
    if (!label) label = attr("alt");
    if (!label) label = attr("name");

    label = label.replace(/\s+/g, " ").trim();

    // The × on a popup is the single most useful control on the page and the
    // one most likely to arrive unlabelled: an icon-only button whose text is a
    // glyph, or nothing at all. Listed as `button ""` the model cannot know
    // what it does, so it fights the overlay instead of closing it.
    if (!label || /^[×✕✖⨯xX✗✘＋+]$/.test(label)) {
      const hints = [
        el.className && typeof el.className === "string" ? el.className : "",
        el.id,
        attr("data-testid"),
        attr("data-test"),
        attr("data-dismiss"),
        attr("aria-label"),
        el.querySelector("svg > title")?.textContent ?? "",
      ].join(" ");

      if (/close|dismiss|cross|modal__x|popup-close|btn-close/i.test(hints)) return "Close";
      if (label) return "Close";
    }

    return label.length > MAX_LABEL ? label.slice(0, MAX_LABEL - 1) + "…" : label;
  }

  /**
   * Whether this element lives inside a modal dialog.
   *
   * Worth a token: it tells the model that what it can see is an overlay and
   * that everything else on the page is behind it, which is otherwise only
   * inferrable from the index having gone strangely short.
   */
  function inDialog(el: Element): boolean {
    let node: Element | null = el;
    let guard = 0;

    while (node && guard++ < 25) {
      const role = node.getAttribute?.("role") ?? "";
      if (
        node.tagName === "DIALOG" ||
        node.getAttribute?.("aria-modal") === "true" ||
        role === "dialog" ||
        role === "alertdialog"
      ) {
        return true;
      }
      const parent: Node | null =
        node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null;
      node = parent instanceof Element ? parent : null;
    }
    return false;
  }

  function roleFor(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.toLowerCase();

    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el as HTMLInputElement).type;
      return INPUT_ROLE[type] ?? "textbox";
    }
    return TAG_ROLE[tag] ?? tag;
  }

  function noteFor(el: Element): string {
    const bits: string[] = [];
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox" || el.type === "radio") {
        bits.push(el.checked ? "checked" : "unchecked");
      }
      if (el.type && !["text", "checkbox", "radio"].includes(el.type)) {
        bits.push(el.type);
      }
    }
    if (el instanceof HTMLSelectElement) {
      const selected = el.selectedOptions[0];
      if (selected) bits.push(`= ${selected.text.slice(0, 20)}`);
    }
    if ((el as HTMLButtonElement).disabled) bits.push("disabled");
    if (inDialog(el)) bits.push("in dialog");
    if (el.getAttribute("aria-expanded")) {
      bits.push(el.getAttribute("aria-expanded") === "true" ? "expanded" : "collapsed");
    }
    return bits.join(" ");
  }

  // ---- Descriptors: who an element is, for matching it again later ----

  const TESTID_ATTRS = ["data-testid", "data-test", "data-qa", "data-cy"];

  /**
   * Ids a framework minted rather than a person wrote. They change on every
   * build or render, and a false id match is worse than no id at all.
   * React's useId has been `:r1:`, `«r1»` and `_r_1_` across versions; a bare
   * numeric segment is a render counter (`a-autoid-18-announce`, `mat-input-3`);
   * `mwDBU` is a MediaWiki Parsoid node id.
   */
  const GENERATED_ID =
    /[0-9a-f]{8,}|\d{4,}|:r[0-9a-z]*:|«r[0-9a-z]*»|_r_[0-9a-z]*_|(^|[-_:.])\d+($|[-_:.])|^mw[\w-]{2,5}$|^(mui-|ember|radix-|headlessui-)/i;

  /** Roles whose name comes from what the user typed or picked, never their content. */
  const FIELD_ROLES = new Set([
    "textbox", "searchbox", "combobox", "listbox", "slider", "spinbutton",
  ]);

  const LANDMARK_TAG: Record<string, string> = {
    nav: "nav", main: "main", header: "header", footer: "footer", aside: "aside",
    form: "form", search: "search", dialog: "dialog", section: "section",
  };
  const LANDMARK_ROLE: Record<string, string> = {
    navigation: "nav", main: "main", banner: "header", contentinfo: "footer",
    complementary: "aside", form: "form", search: "search", dialog: "dialog",
    alertdialog: "dialog", region: "section",
  };

  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
  const squashSpace = (s: string) => s.replace(/\s+/g, " ").trim();

  /** `Cart (3)` → `cart`, `Inbox 12` → `inbox`. A bare trailing number needs a space before it, so `Chandrayaan-3` survives. */
  function normText(s: string): string {
    return squashSpace(s.normalize("NFKC").toLowerCase())
      .replace(/\s*[([]\s*\d+\+?\s*[)\]]$|\s+\d+\+?$/, "")
      .trim();
  }

  /** Crosses a shadow boundary where `parentElement` stops. */
  function parentOf(node: Element): Element | null {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode() as ShadowRoot;
    return root && root.host ? root.host : null;
  }

  function byIds(el: Element, ids: string): string {
    const root = el.getRootNode() as Document | ShadowRoot;
    return squashSpace(
      ids
        .split(/\s+/)
        .map((id) => {
          const target = root.getElementById ? root.getElementById(id) : null;
          return target?.textContent ?? el.ownerDocument.getElementById(id)?.textContent ?? "";
        })
        .join(" "),
    );
  }

  function contentText(el: Element): string {
    const text = squashSpace((el as HTMLElement).innerText ?? el.textContent ?? "");
    if (text) return text;
    // An icon-only control is named by what it contains.
    const inner = el.querySelector("[aria-label], img[alt]:not([alt='']), svg title, [title]");
    if (!inner) return "";
    return squashSpace(
      inner.getAttribute("aria-label") ??
        inner.getAttribute("alt") ??
        inner.getAttribute("title") ??
        inner.textContent ??
        "",
    );
  }

  /**
   * The accessible name, in the order the accname spec and HTML-AAM apply it,
   * trimmed to the sources that decide the overwhelming majority of real
   * controls. A library would do this properly but cannot be injected.
   */
  function accName(el: Element, role: string): string {
    const attr = (n: string) => squashSpace(el.getAttribute(n) ?? "");
    const tag = el.tagName.toLowerCase();

    const by = attr("aria-labelledby");
    if (by) {
      const text = byIds(el, by);
      if (text) return text;
    }
    if (attr("aria-label")) return attr("aria-label");

    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length > 0) {
      const text = squashSpace(
        Array.from(labels)
          .map((l) => (l as HTMLElement).innerText ?? l.textContent ?? "")
          .join(" "),
      );
      if (text) return text;
    }

    const type = tag === "input" ? ((el as HTMLInputElement).type || "text") : "";
    if ((tag === "img" || tag === "area" || type === "image") && attr("alt")) return attr("alt");
    if (type === "submit" || type === "button" || type === "reset") {
      if (attr("value")) return attr("value");
    }

    const isField = tag === "input" || tag === "select" || tag === "textarea" || FIELD_ROLES.has(role);
    if (!isField) {
      const text = contentText(el);
      if (text) return text;
    }

    if (attr("title")) return attr("title");
    if (attr("placeholder")) return attr("placeholder");
    return attr("aria-placeholder");
  }

  function stableFor(el: Element): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of TESTID_ATTRS) {
      const v = el.getAttribute(key);
      if (v) out[key] = v;
    }
    const name = el.getAttribute("name");
    if (name && !GENERATED_ID.test(name)) out.name = name;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "button") {
      out.type = ((el as HTMLInputElement).type || "").toLowerCase();
    }
    if (el.id && !GENERATED_ID.test(el.id)) out.id = el.id;
    return out;
  }

  /** The kind of landmark this node is, or "" if it is not one. */
  function landmarkKind(node: Element): string {
    const role = (node.getAttribute("role") ?? "").split(/\s+/)[0]!.toLowerCase();
    const tag = node.tagName.toLowerCase();
    const kind = (role && LANDMARK_ROLE[role]) || (!role ? LANDMARK_TAG[tag] : "") || "";
    if (!kind && node.getAttribute("aria-modal") === "true") return "dialog";
    if (!kind) return "";

    const labelled = node.hasAttribute("aria-label") || node.hasAttribute("aria-labelledby");
    // A section is only a landmark once it is named.
    if (kind === "section" && !labelled) return "";
    // A header or footer inside an article is part of that article, not the site.
    if ((tag === "header" || tag === "footer") && !role) {
      const scope = node.parentElement?.closest("article, aside, main, nav, section");
      if (scope) return "";
    }
    return kind;
  }

  function landmarkLabel(node: Element, kind: string): string {
    let label = squashSpace(node.getAttribute("aria-label") ?? "");
    const by = node.getAttribute("aria-labelledby");
    if (!label && by) label = byIds(node, by);
    if (!label && kind === "dialog") {
      label = squashSpace(node.querySelector("h1, h2, h3, h4, h5, h6")?.textContent ?? "");
    }
    return clip(normText(label), 40);
  }

  // Hundreds of candidates share the same few ancestors, so both ancestor
  // walks are cached per node rather than repeated per element.
  const chainCache = new Map<Element, string[]>();

  function landmarkChain(node: Element | null): string[] {
    if (!node) return [];
    let chain = chainCache.get(node);
    if (!chain) {
      const above = landmarkChain(parentOf(node));
      const kind = landmarkKind(node);
      if (kind) {
        const label = landmarkLabel(node, kind);
        chain = [...above, label ? `${kind}:${label}` : kind];
      } else {
        chain = above;
      }
      chainCache.set(node, chain);
    }
    return chain;
  }

  function landmarksFor(el: Element): string[] {
    return landmarkChain(parentOf(el)).slice();
  }

  const headingCache = new Map<Document, Element[]>();

  /** The last heading at or before this element in document order. */
  function headingFor(el: Element): string {
    let anchor: Element = el;
    let guard = 0;
    while (guard++ < 12) {
      const root = anchor.getRootNode() as ShadowRoot;
      if (!root || !root.host) break;
      anchor = root.host;
    }

    const doc = anchor.ownerDocument;
    let headings = headingCache.get(doc);
    if (!headings) {
      headings = Array.from(doc.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]"));
      headingCache.set(doc, headings);
    }

    const FOLLOWING = 4;
    const CONTAINED_BY = 16;
    let lo = 0;
    let hi = headings.length - 1;
    let found: Element | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const h = headings[mid]!;
      const pos = h.compareDocumentPosition(anchor);
      if (h === anchor || pos & FOLLOWING || pos & CONTAINED_BY) {
        found = h;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found ? clip(squashSpace(found.textContent ?? ""), 80) : "";
  }

  const shapeCache = new Map<Element, string>();

  /** A node's tag and its children's tags: what repeated items share and wrappers do not. */
  function shapeOf(node: Element): string {
    let s = shapeCache.get(node);
    if (s === undefined) {
      const kids = Array.from(node.children).slice(0, 12).map((c) => c.tagName);
      s = `${node.tagName}>${kids.join(",")}`;
      shapeCache.set(node, s);
    }
    return s;
  }

  /** The nearest ancestor that sits among two or more siblings of the same shape. */
  function repeatedItem(el: Element): Element | null {
    let node: Element | null = el.parentElement;
    let guard = 0;
    while (node && guard++ < 10) {
      const tag = node.tagName.toLowerCase();
      if (tag === "body" || tag === "html" || tag === "main") return null;
      const parent = node.parentElement;
      if (!parent) return null;
      const shape = shapeOf(node);
      let same = 0;
      for (const sibling of Array.from(parent.children)) {
        if (sibling.tagName === node.tagName && shapeOf(sibling) === shape) same++;
        if (same >= 3) return node;
      }
      node = parent;
    }
    return null;
  }

  const ordinalCache = new Map<Element, { nth: number; count: number }>();

  /** nth-of-type among same-tag siblings, computed once per parent. */
  function ordinalOf(node: Element): { nth: number; count: number } {
    const cached = ordinalCache.get(node);
    if (cached) return cached;
    const parent = node.parentElement;
    if (!parent) return { nth: 1, count: 1 };

    const totals = new Map<string, number>();
    const kids = Array.from(parent.children);
    for (const kid of kids) totals.set(kid.tagName, (totals.get(kid.tagName) ?? 0) + 1);
    const seen = new Map<string, number>();
    for (const kid of kids) {
      const nth = (seen.get(kid.tagName) ?? 0) + 1;
      seen.set(kid.tagName, nth);
      ordinalCache.set(kid, { nth, count: totals.get(kid.tagName)! });
    }
    return ordinalCache.get(node)!;
  }

  function segmentOf(node: Element, force: boolean): string {
    const tag = node.tagName.toLowerCase();
    const { nth, count } = ordinalOf(node);
    // A wrapper with same-tag siblings is kept anyway: its ordinal is what
    // tells the third result card from the fourth. Lone wrappers still vanish,
    // so injecting one does not change the path.
    const anonymous =
      (tag === "div" || tag === "span") &&
      count < 2 &&
      !node.hasAttribute("role") &&
      !node.hasAttribute("aria-label") &&
      !node.hasAttribute("aria-labelledby") &&
      !TESTID_ATTRS.some((a) => node.hasAttribute(a)) &&
      !landmarkKind(node);
    if (anonymous && !force) return "";
    return count > 1 ? `${tag}[${nth}]` : tag;
  }

  const pathCache = new Map<Element, string>();

  function ancestorPath(node: Element | null): string {
    if (!node) return "";
    const tag = node.tagName.toLowerCase();
    if (tag === "body" || tag === "html") return "";
    let path = pathCache.get(node);
    if (path === undefined) {
      const above = ancestorPath(parentOf(node));
      const own = segmentOf(node, false);
      path = own ? (above ? `${above}>${own}` : own) : above;
      pathCache.set(node, path);
    }
    return path;
  }

  function pathFor(el: Element): string {
    const above = ancestorPath(parentOf(el));
    const own = segmentOf(el, true);
    return above ? `${above}>${own}` : own;
  }

  const round2 = (n: number) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

  function sizeBucket(w: number, h: number): "xs" | "s" | "m" | "l" | "xl" {
    const area = w * h;
    if (area < 400) return "xs";
    if (area < 2500) return "s";
    if (area < 10000) return "m";
    if (area < 40000) return "l";
    return "xl";
  }

  /** Walks a root, piercing shadow roots and same-origin iframes. */
  /**
   * The readable text around where the page is currently looking.
   *
   * `body.innerText` sliced from the top is the wrong excerpt on any long
   * document: scroll to a table halfway down an article and the model is still
   * reading the lead paragraph, so it answers from the wrong part of the page or
   * scrolls forever looking for what it was already shown.
   *
   * Blocks are measured once, in one batch, so this costs a single layout pass
   * rather than a reflow per node — the trap that made the indexer slow on large
   * pages. The node list is capped for the same reason.
   */
  function viewportText(cap: number): { text: string; total: number } {
    const BLOCKS = "p,li,h1,h2,h3,h4,h5,h6,td,th,dd,dt,blockquote,figcaption,pre,summary";
    const clean = (s: string) => s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    const whole = clean((document.body as HTMLElement | null)?.innerText ?? "");
    if (whole.length <= cap) return { text: whole, total: whole.length };

    const nodes = Array.from(document.querySelectorAll(BLOCKS)).slice(0, 800);
    const blocks: { top: number; text: string }[] = [];
    for (const node of nodes) {
      const body = (node as HTMLElement).innerText;
      if (!body) continue;
      const trimmed = clean(body);
      if (trimmed.length < 2) continue;
      blocks.push({ top: node.getBoundingClientRect().top + window.scrollY, text: trimmed });
    }
    if (blocks.length === 0) return { text: whole.slice(0, cap), total: whole.length };

    blocks.sort((a, b) => a.top - b.top);

    // Grow outwards from whichever block the viewport is centred on, so the
    // excerpt keeps its reading order and always includes what is on screen.
    const focus = window.scrollY + window.innerHeight / 2;
    const gap = (i: number) => Math.abs((blocks[i]?.top ?? 0) - focus);
    let nearest = 0;
    for (let i = 1; i < blocks.length; i++) if (gap(i) < gap(nearest)) nearest = i;

    let lo = nearest;
    let hi = nearest;
    let size = blocks[nearest]?.text.length ?? 0;
    while (size < cap && (lo > 0 || hi < blocks.length - 1)) {
      const takeBelow = lo === 0 || (hi < blocks.length - 1 && gap(hi + 1) <= gap(lo - 1));
      const next = takeBelow ? blocks[++hi] : blocks[--lo];
      size += (next?.text.length ?? 0) + 1;
    }

    const excerpt = blocks.slice(lo, hi + 1).map((b) => b.text).join("\n").slice(0, cap);
    return { text: lo > 0 ? `…\n${excerpt}` : excerpt, total: whole.length };
  }

  function collect(root: Document | ShadowRoot, doc: Document, offX: number, offY: number, frame: string, depth: number) {
    if (depth > 6) return;

    const walker = doc.createTreeWalker(root as unknown as Node, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode() as Element | null;

    while (node) {
      const el = node;
      node = walker.nextNode() as Element | null;

      // tiny-brow's own overlay must never appear in its own index.
      if (el.hasAttribute("data-tiny-brow")) continue;

      const tag = el.tagName.toLowerCase();

      if (tag === "iframe") {
        try {
          const inner = (el as HTMLIFrameElement).contentDocument;
          if (inner?.body) {
            const r = el.getBoundingClientRect();
            collect(inner, inner, offX + r.left, offY + r.top, frame ? `${frame}>iframe` : "iframe", depth + 1);
          }
        } catch {
          // Cross-origin. Nothing to do; the frame is opaque to us.
        }
        continue;
      }

      if (el.shadowRoot) {
        collect(el.shadowRoot, doc, offX, offY, frame, depth + 1);
      }

      const byMarkup = isInteractiveByMarkup(el);
      if (!byMarkup && !mightBeStyledButton(el)) continue;

      let style: CSSStyleDeclaration;
      try {
        style = (doc.defaultView ?? window).getComputedStyle(el);
      } catch {
        continue;
      }

      if (!byMarkup && style.cursor !== "pointer") continue;

      const rect = el.getBoundingClientRect();
      if (!isVisible(el, style, rect)) continue;
      if (!isTopmost(el, doc, rect)) continue;

      candidates.push({ el, doc, offX, offY, frame, order: order++ });
    }
  }

  const started = performance.now();
  collect(document, document, 0, 0, "", 0);

  // Deduplication: a link wrapping a button wrapping a span produces three
  // entries for one thing. Keep the outermost when the boxes coincide.
  const candidateEls = new Set(candidates.map((c) => c.el));

  const chosen = candidates.filter((c) => {
    const rect = c.el.getBoundingClientRect();
    const area = rect.width * rect.height;
    let parent: Element | null = c.el.parentElement;
    let guard = 0;

    while (parent && guard++ < 20) {
      if (candidateEls.has(parent)) {
        const pr = parent.getBoundingClientRect();
        const parentArea = pr.width * pr.height;
        if (parentArea > 0 && area / parentArea >= 0.85) return false;
      }
      parent = parent.parentElement;
    }
    return true;
  });

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const all = chosen.map((c) => {
    // `el` is stripped before returning — Element is not serialisable — but it
    // is carried this far so the survivors can be stashed for the overlay.
    const r = c.el.getBoundingClientRect();
    const x = Math.round(r.left + c.offX);
    const y = Math.round(r.top + c.offY);
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    return {
      i: 0,
      tag: c.el.tagName.toLowerCase(),
      role: roleFor(c.el),
      label: labelFor(c.el),
      x, y, w, h,
      inViewport: y + h > 0 && y < vh && x + w > 0 && x < vw,
      frame: c.frame,
      note: noteFor(c.el),
      order: c.order,
      el: c.el,
    };
  });

  // Viewport-visible first, then document order. Stable both ways, so two runs
  // on an unchanged page produce byte-identical output.
  const ranked = all
    .slice()
    .sort((a, b) =>
      a.inViewport === b.inViewport ? a.order - b.order : a.inViewport ? -1 : 1,
    )
    .slice(0, indexCap)
    .sort((a, b) => a.order - b.order);

  const elements = ranked.map((e, i) => {
    const { order: _order, el: _el, ...rest } = e;
    return { ...rest, i };
  });

  // Descriptors cover candidates the model never sees too: the element a
  // replay is looking for is often past the cap on a long results page.
  const shown = new Map(ranked.map((e, i) => [e.el, i]));
  const docEl = document.documentElement;
  const docW = Math.max(1, docEl ? docEl.scrollWidth : vw);
  const docH = Math.max(1, docEl ? docEl.scrollHeight : vh);

  const descriptors = all
    .slice()
    .sort((a, b) =>
      a.inViewport === b.inViewport ? a.order - b.order : a.inViewport ? -1 : 1,
    )
    .slice(0, descriptorCap)
    .sort((a, b) => a.order - b.order)
    .map((e) => {
      const name = clip(accName(e.el, e.role), 120);
      const heading = headingFor(e.el);
      const itemEl = repeatedItem(e.el);
      const item = itemEl
        ? clip(squashSpace((itemEl as HTMLElement).innerText ?? itemEl.textContent ?? ""), 80)
        : "";
      const cx = e.x + e.w / 2;
      const cy = e.y + e.h / 2;
      return {
        i: shown.has(e.el) ? shown.get(e.el)! : null,
        tag: e.tag,
        role: e.role,
        name,
        nameNorm: normText(name),
        stable: stableFor(e.el),
        landmarks: landmarksFor(e.el),
        context: { heading, headingNorm: normText(heading), item, itemNorm: normText(item) },
        geom: {
          docX: round2((cx + window.scrollX) / docW),
          docY: round2((cy + window.scrollY) / docH),
          vpX: round2(cx / vw),
          vpY: round2(cy / vh),
          size: sizeBucket(e.w, e.h),
        },
        pathNorm: pathFor(e.el),
        frame: e.frame,
      };
    });

  // Stashed in the page so the overlay can re-measure live rects on scroll.
  // Element references cannot cross the CDP boundary, so anything that needs
  // them has to run in this same world.
  const store = (window as unknown as Record<string, any>).__tinyBrow ?? {};
  store.els = ranked.map((e) => e.el);
  store.meta = elements.map((e) => ({ i: e.i, role: e.role, label: e.label }));
  (window as unknown as Record<string, any>).__tinyBrow = store;

  // Falls back rather than throws: a page whose layout defeats the measuring
  // pass should read worse, not stop the agent from seeing it at all.
  let excerpt: { text: string; total: number };
  try {
    excerpt = viewportText(textCap);
  } catch {
    const flat = ((document.body as HTMLElement | null)?.innerText ?? "").trim();
    excerpt = { text: flat.slice(0, textCap), total: flat.length };
  }

  return {
    url: location.href,
    title: document.title,
    elements,
    descriptors,
    totalFound: all.length,
    viewport: {
      w: vw,
      h: vh,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      docH: Math.round(document.documentElement.scrollHeight),
    },
    text: excerpt.text,
    textChars: excerpt.total,
    tookMs: Math.round(performance.now() - started),
  };
}

interface EvaluateResult {
  result: { value?: PageIndex };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

export async function buildIndex(tabId: number): Promise<PageIndex> {
  const expression = `(${extractPage.toString()})(${INDEX_CAP}, ${TEXT_CAP}, ${DESCRIPTOR_CAP})`;

  const { result, exceptionDetails } = await send<EvaluateResult>(
    tabId,
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: false },
  );

  if (exceptionDetails) {
    throw new Error(
      `Indexer threw in the page: ${
        exceptionDetails.exception?.description ?? exceptionDetails.text
      }`,
    );
  }
  if (!result?.value) {
    throw new Error("Indexer returned nothing — the page may have navigated mid-run.");
  }
  return result.value;
}
