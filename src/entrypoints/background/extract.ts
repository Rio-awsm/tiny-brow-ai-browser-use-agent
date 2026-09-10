import { INDEX_CAP, TEXT_CAP, type PageIndex } from "@/lib/page-index";
import { send } from "./cdp";

/**
 * Runs inside the page via `Runtime.evaluate`, so it must be entirely
 * self-contained — no imports, no closure over anything in this module.
 * It is stringified and injected.
 */
function extractPage(indexCap: number, textCap: number) {
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
    return label.length > MAX_LABEL ? label.slice(0, MAX_LABEL - 1) + "…" : label;
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
    if (el.getAttribute("aria-expanded")) {
      bits.push(el.getAttribute("aria-expanded") === "true" ? "expanded" : "collapsed");
    }
    return bits.join(" ");
  }

  /** Walks a root, piercing shadow roots and same-origin iframes. */
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

  // Stashed in the page so the overlay can re-measure live rects on scroll.
  // Element references cannot cross the CDP boundary, so anything that needs
  // them has to run in this same world.
  const store = (window as unknown as Record<string, any>).__tinyBrow ?? {};
  store.els = ranked.map((e) => e.el);
  store.meta = elements.map((e) => ({ i: e.i, role: e.role, label: e.label }));
  (window as unknown as Record<string, any>).__tinyBrow = store;

  const text = (document.body?.innerText ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    url: location.href,
    title: document.title,
    elements,
    totalFound: all.length,
    viewport: {
      w: vw,
      h: vh,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      docH: Math.round(document.documentElement.scrollHeight),
    },
    text: text.slice(0, textCap),
    textChars: text.length,
    tookMs: Math.round(performance.now() - started),
  };
}

interface EvaluateResult {
  result: { value?: PageIndex };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

export async function buildIndex(tabId: number): Promise<PageIndex> {
  const expression = `(${extractPage.toString()})(${INDEX_CAP}, ${TEXT_CAP})`;

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
