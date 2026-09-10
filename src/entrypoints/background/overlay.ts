import { send } from "./cdp";

/**
 * Drawn in the page's main world rather than the content script, because the
 * indexer runs there and only that world holds the element references it found.
 * Re-measuring live rects is what makes the boxes correct while scrolling and
 * on sticky headers, instead of freezing coordinates at capture time.
 */
function showOverlay() {
  const store = (window as unknown as Record<string, any>).__tinyBrow;
  if (!store?.els?.length) return { count: 0 };

  store.overlay?.destroy();

  const COLORS: Record<string, string> = {
    textbox: "#3b82f6",
    searchbox: "#3b82f6",
    combobox: "#3b82f6",
    spinbutton: "#3b82f6",
    slider: "#3b82f6",
    checkbox: "#f59e0b",
    radio: "#f59e0b",
    switch: "#f59e0b",
    link: "#a78bfa",
  };
  const DEFAULT = "#12c39a";

  const host = document.createElement("div");
  host.setAttribute("data-tiny-brow", "overlay");
  host.style.cssText =
    "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;";

  // Closed, so the indexer's `el.shadowRoot` check reads null and never walks
  // into it. Combined with the data attribute on the host, the overlay cannot
  // index itself. `pointer-events:none` keeps it out of the hit test too.
  const root = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    .b {
      position: fixed;
      left: 0; top: 0;
      box-sizing: border-box;
      border: 2px solid var(--c);
      border-radius: 3px;
      pointer-events: none;
      will-change: transform;
    }
    .b::after {
      content: attr(data-n);
      position: absolute;
      top: -1px; left: -2px;
      transform: translateY(-100%);
      background: var(--c);
      color: #fff;
      font: 600 10px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 1px 4px;
      border-radius: 3px 3px 3px 0;
      white-space: nowrap;
    }
    .b[data-inside="1"]::after {
      transform: none;
      border-radius: 0 0 3px 0;
      top: 0; left: 0;
    }
  `;
  root.appendChild(style);

  /** Rect in top-document viewport space, walking out through any iframes. */
  function viewportRect(el: Element) {
    const r = el.getBoundingClientRect();
    let x = r.left;
    let y = r.top;
    let win: Window | null = el.ownerDocument.defaultView;
    let guard = 0;

    while (win && win !== window && guard++ < 8) {
      const frame = win.frameElement;
      if (!frame) break;
      const fr = frame.getBoundingClientRect();
      x += fr.left;
      y += fr.top;
      win = frame.ownerDocument.defaultView;
    }
    return { x, y, w: r.width, h: r.height };
  }

  const boxes = (store.els as Element[]).map((el, n) => {
    const meta = store.meta?.[n];
    const box = document.createElement("div");
    box.className = "b";
    box.dataset.n = String(meta?.i ?? n);
    box.style.setProperty("--c", COLORS[meta?.role] ?? DEFAULT);
    root.appendChild(box);
    return { el, box };
  });

  document.documentElement.appendChild(host);

  let frame = 0;
  function reposition() {
    frame = 0;
    for (const b of boxes) {
      const r = viewportRect(b.el);
      if (r.w < 1 || r.h < 1 || r.y + r.h < 0 || r.y > window.innerHeight) {
        b.box.style.display = "none";
        continue;
      }
      b.box.style.display = "block";
      b.box.style.transform = `translate(${Math.round(r.x)}px, ${Math.round(r.y)}px)`;
      b.box.style.width = `${Math.round(r.w)}px`;
      b.box.style.height = `${Math.round(r.h)}px`;
      // Keep the number chip on screen when the box is flush with the top.
      b.box.dataset.inside = r.y < 16 ? "1" : "0";
    }
  }

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(reposition);
  };

  reposition();
  // Capture phase, so scrolling inside any nested scroller repositions too.
  addEventListener("scroll", schedule, { capture: true, passive: true });
  addEventListener("resize", schedule, { passive: true });

  store.overlay = {
    destroy() {
      removeEventListener("scroll", schedule, { capture: true } as EventListenerOptions);
      removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
      host.remove();
      store.overlay = null;
    },
  };

  return { count: boxes.length };
}

function overlayState() {
  const store = (window as unknown as Record<string, any>).__tinyBrow;
  return { count: store?.overlay ? 1 : 0 };
}

function hideOverlay() {
  const store = (window as unknown as Record<string, any>).__tinyBrow;
  store?.overlay?.destroy();
  return { count: 0 };
}

interface EvaluateResult {
  result: { value?: { count: number } };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

async function run(tabId: number, expression: string): Promise<number> {
  const { result, exceptionDetails } = await send<EvaluateResult>(
    tabId,
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: false },
  );
  if (exceptionDetails) {
    throw new Error(
      `Overlay threw in the page: ${
        exceptionDetails.exception?.description ?? exceptionDetails.text
      }`,
    );
  }
  return result?.value?.count ?? 0;
}

// Stringified at the call site, not passed as a value, so `npm run check:extractor`
// can find every injected function in the built bundle and prove each one runs
// with nothing but page globals.
export const showHighlights = (tabId: number) =>
  run(tabId, `(${showOverlay.toString()})()`);

export const hideHighlights = (tabId: number) =>
  run(tabId, `(${hideOverlay.toString()})()`);

/** Whether the page currently has an overlay, so an action can restore it. */
export const isOverlayOn = async (tabId: number) =>
  (await run(tabId, `(${overlayState.toString()})()`)) === 1;
