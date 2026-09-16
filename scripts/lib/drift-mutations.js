// Injected into a fixture page by check:drift, so it must stay self-contained.
// The element under test carries data-drift-target; a duplicate gets data-drift-clone.
(function mutate(variant, seed) {
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const token = () => Math.floor(rand() * 36 ** 6).toString(36).padStart(6, "a");

  const store = window.__tinyBrow;
  const target = store && store.all ? store.all.find((el) => el.hasAttribute("data-drift-target")) : null;
  if (!target) return { applied: false, note: "target not found before mutating" };

  const parentOf = (node) => node.parentElement || (node.getRootNode().host ?? null);
  const skip = new Set(["HTML", "HEAD", "BODY", "SCRIPT", "STYLE", "TITLE", "META", "LINK"]);

  function wrap(node) {
    const parent = node.parentNode;
    if (!parent || skip.has(node.tagName)) return false;
    const wrapper = node.ownerDocument.createElement("div");
    wrapper.style.display = "contents";
    parent.insertBefore(wrapper, node);
    wrapper.appendChild(node);
    return true;
  }

  function ancestors(node) {
    const out = [];
    let n = node;
    while (n && out.length < 8 && !skip.has(n.tagName)) {
      out.push(n);
      n = parentOf(n);
    }
    return out;
  }

  // Swaps the last word, or adds one: small enough to be the same control.
  const SWAPS = {
    cart: "bag", sign: "log", results: "items", account: "profile", search: "find",
    submit: "send", order: "purchase", more: "extra", next: "forward", previous: "back",
    save: "keep", close: "dismiss", discard: "drop", archive: "store", send: "post",
  };
  function tweak(text) {
    const m = text.match(/^(.*?)([\p{L}\p{N}]+)(\W*)$/u);
    if (!m) return `${text} now`;
    const [, head, word, tail] = m;
    const swap = SWAPS[word.toLowerCase()];
    if (!swap) return `${text.trimEnd()} now`;
    const cased = word[0] === word[0].toUpperCase() ? swap[0].toUpperCase() + swap.slice(1) : swap;
    return `${head}${cased}${tail}`;
  }

  function lastText(node) {
    const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let found = null;
    for (let t = walker.nextNode(); t; t = walker.nextNode()) if (t.textContent.trim()) found = t;
    return found;
  }

  switch (variant) {
    case 1: {
      let wrapped = 0;
      const chain = ancestors(target);
      for (const node of chain) if (rand() < 0.5 && wrap(node)) wrapped++;
      if (wrapped === 0 && wrap(chain[0])) wrapped++;
      const everything = Array.from(document.body.querySelectorAll("*"));
      for (let i = 0; i < 12 && everything.length; i++) if (wrap(pick(everything))) wrapped++;
      return { applied: wrapped > 0, note: `${wrapped} wrappers` };
    }

    case 2: {
      const ids = new Map();
      const classes = new Map();
      const roots = [document];
      for (const el of document.querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
      for (const root of roots) {
        for (const el of root.querySelectorAll("[id]")) {
          const fresh = `r-${token()}`;
          ids.set(el.id, fresh);
          el.id = fresh;
        }
        for (const el of root.querySelectorAll("[class]")) {
          const names = Array.from(el.classList);
          el.className = names
            .map((name) => {
              if (!classes.has(name)) classes.set(name, `c-${token()}`);
              return classes.get(name);
            })
            .join(" ");
        }
      }
      for (const root of roots) {
        for (const attr of ["for", "aria-labelledby", "aria-describedby", "aria-controls"]) {
          for (const el of root.querySelectorAll(`[${attr}]`)) {
            const next = el.getAttribute(attr).split(/\s+/).map((id) => ids.get(id) ?? id).join(" ");
            el.setAttribute(attr, next);
          }
        }
        for (const style of root.querySelectorAll("style")) {
          let css = style.textContent;
          for (const [from, to] of classes) {
            css = css.replace(new RegExp(`\\.${from.replace(/[^\w-]/g, "\\$&")}(?![\\w-])`, "g"), `.${to}`);
          }
          for (const [from, to] of ids) {
            css = css.replace(new RegExp(`#${from.replace(/[^\w-]/g, "\\$&")}(?![\\w-])`, "g"), `#${to}`);
          }
          style.textContent = css;
        }
      }
      return { applied: ids.size + classes.size > 0, note: `${ids.size} ids, ${classes.size} classes` };
    }

    case 3: {
      const banner = document.createElement("div");
      banner.setAttribute("style", "padding: 40px 16px; background: #fff4e5; font: 16px sans-serif");
      banner.append("Festival sale ends tonight. ");
      const promo = document.createElement("a");
      promo.href = "/sale";
      promo.textContent = "Shop the sale";
      banner.append(promo, " ");
      const dismiss = document.createElement("button");
      dismiss.textContent = "Dismiss";
      banner.append(dismiss);
      document.body.prepend(banner);
      return { applied: true, note: "banner" };
    }

    case 4: {
      const attrs = ["aria-label"];
      for (const a of attrs) {
        if (target.hasAttribute(a)) {
          target.setAttribute(a, tweak(target.getAttribute(a)));
          return { applied: true, note: a };
        }
      }
      const by = target.getAttribute("aria-labelledby");
      if (by) {
        const ref = target.getRootNode().getElementById?.(by.split(/\s+/)[0]);
        const text = ref && lastText(ref);
        if (text) {
          text.textContent = tweak(text.textContent);
          return { applied: true, note: "aria-labelledby" };
        }
      }
      if (target.labels && target.labels.length) {
        const text = lastText(target.labels[0]);
        if (text) {
          text.textContent = tweak(text.textContent);
          return { applied: true, note: "label" };
        }
      }
      const type = (target.getAttribute("type") || "").toLowerCase();
      if (target.tagName === "INPUT" && ["submit", "button", "reset"].includes(type) && target.value) {
        target.value = tweak(target.value);
        target.setAttribute("value", target.value);
        return { applied: true, note: "value" };
      }
      const text = lastText(target);
      if (text) {
        text.textContent = tweak(text.textContent);
        return { applied: true, note: "text" };
      }
      for (const a of ["alt", "title", "placeholder"]) {
        const holder = a === "alt" ? target.querySelector("[alt]") : target.hasAttribute(a) ? target : null;
        if (holder && holder.getAttribute(a)) {
          holder.setAttribute(a, tweak(holder.getAttribute(a)));
          return { applied: true, note: a };
        }
      }
      return { applied: false, note: "no name source to change" };
    }

    case 5: {
      for (const node of ancestors(target)) {
        const parent = node.parentNode;
        if (!parent) continue;
        const peers = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (peers.length < 2) continue;
        const others = peers.filter((p) => p !== node);
        const anchor = pick(others);
        const before = Array.from(parent.children).indexOf(anchor) < Array.from(parent.children).indexOf(node);
        parent.insertBefore(node, before ? anchor : anchor.nextSibling);
        return { applied: true, note: `moved a ${node.tagName.toLowerCase()} among ${peers.length}` };
      }
      return { applied: false, note: "no siblings to reorder" };
    }

    case 6:
      target.remove();
      return { applied: true, note: "deleted" };

    case 7: {
      const clone = target.cloneNode(true);
      clone.removeAttribute("data-drift-target");
      clone.setAttribute("data-drift-clone", "");
      target.after(clone);
      return { applied: true, note: "duplicated" };
    }
  }
  return { applied: false, note: `unknown variant ${variant}` };
})
