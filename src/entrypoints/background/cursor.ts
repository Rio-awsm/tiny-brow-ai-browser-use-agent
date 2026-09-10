import { send } from "./cdp";

export const GLIDE_MS = 340;

/**
 * Creates the cursor if the page does not have one. Idempotent, and called
 * before every action, which is also how the cursor comes back after a
 * navigation destroys it.
 */
function ensureCursor(label: string) {
  const store = ((window as unknown as Record<string, any>).__tinyBrow ??= {});

  if (store.cursor?.el?.isConnected) {
    if (store.cursor.tag?.lastChild) store.cursor.tag.lastChild.textContent = label;
    return { ok: true };
  }

  const host = document.createElement("div");
  host.setAttribute("data-tiny-brow", "cursor");
  host.style.cssText =
    "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;";

  // Closed shadow root plus the data attribute: the indexer skips the host and
  // cannot walk in, so the cursor never shows up in its own index. It also
  // isolates these styles from the page's, in both directions.
  const root = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host, * { box-sizing: border-box; }

    .c {
      position: absolute;
      left: 0; top: 0;
      width: 0; height: 0;
      pointer-events: none;
      transition-property: transform;
      transition-timing-function: cubic-bezier(0.22, 0.61, 0.36, 1);
      will-change: transform;
      animation: tb-in 260ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
    }

    /* Halo — the thing that reads as "not your pointer" at a glance. */
    .halo {
      position: absolute;
      left: -17px; top: -17px;
      width: 34px; height: 34px;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(25,214,159,.42) 0%, rgba(25,214,159,0) 70%);
      animation: tb-breathe 2.4s ease-in-out infinite;
      transition: opacity 160ms ease, transform 160ms ease;
    }
    .c.mv .halo { animation: none; opacity: 1; transform: scale(1.35); }

    .arrow {
      position: absolute;
      left: -6px; top: -3px;
      display: block;
      filter: drop-shadow(0 2px 4px rgba(0,0,0,.45));
    }

    .tag {
      position: absolute;
      left: 15px; top: 17px;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px 2px 5px;
      border-radius: 999px;
      background: #0b8a6d;
      box-shadow: 0 2px 6px rgba(0,0,0,.35), inset 0 0 0 1px rgba(255,255,255,.18);
      white-space: nowrap;

      /* Set outright: inherited properties cross the shadow boundary. */
      font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
      font-size: 10px;
      font-weight: 650;
      font-style: normal;
      line-height: 14px;
      letter-spacing: .015em;
      text-transform: none;
      color: #fff;
    }
    .lbl {
      max-width: 190px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dot {
      width: 5px; height: 5px;
      border-radius: 999px;
      background: #7bf5cf;
      animation: tb-blink 1.4s ease-in-out infinite;
    }

    .r {
      position: absolute;
      left: 0; top: 0;
      width: 16px; height: 16px;
      margin: -8px 0 0 -8px;
      border-radius: 999px;
      border: 2px solid #19d69f;
      background: rgba(25,214,159,.2);
      pointer-events: none;
    }

    @keyframes tb-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    @keyframes tb-breathe {
      0%, 100% { transform: scale(.82); opacity: .55; }
      50%      { transform: scale(1.1);  opacity: .95; }
    }
    @keyframes tb-blink {
      0%, 100% { opacity: 1; }
      50%      { opacity: .35; }
    }
    @keyframes tb-pulse {
      0%   { transform: scale(.3); opacity: .95; }
      100% { transform: scale(3);  opacity: 0; }
    }
  `;
  root.appendChild(style);

  const el = document.createElement("div");
  el.className = "c";

  const halo = document.createElement("div");
  halo.className = "halo";
  el.appendChild(halo);

  const arrow = document.createElement("div");
  // Mint fill with a white edge, so it reads as deliberate on any background
  // and never gets mistaken for the operating system's own pointer.
  arrow.innerHTML =
    '<svg class="arrow" viewBox="0 0 24 24" width="25" height="25">' +
    '<path d="M6 3.2 18.6 12.4 12.2 13.2 15.6 20.1 12.9 21.4 9.5 14.5 6 18.6Z" ' +
    'fill="#19d69f" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  el.appendChild(arrow.firstChild as Node);

  const tag = document.createElement("div");
  tag.className = "tag";
  const dot = document.createElement("span");
  dot.className = "dot";
  tag.appendChild(dot);
  const text = document.createElement("span");
  text.className = "lbl";
  text.textContent = label;
  tag.appendChild(text);
  el.appendChild(tag);

  // Parked centre-screen, so the first move is a glide from somewhere sensible
  // rather than a jump out of the top-left corner.
  const startX = Math.round(window.innerWidth / 2);
  const startY = Math.round(window.innerHeight / 2);
  el.style.transitionDuration = "0ms";
  el.style.transform = `translate3d(${startX}px, ${startY}px, 0)`;

  root.appendChild(el);
  document.documentElement.appendChild(host);

  store.cursor = { host, el, root, tag, x: startX, y: startY };
  return { ok: true };
}

/** Glides to a point and resolves when it actually gets there. */
function moveCursor(x: number, y: number, ms: number, label: string) {
  const store = (window as unknown as Record<string, any>).__tinyBrow;
  const cursor = store?.cursor;
  if (!cursor?.el?.isConnected) return Promise.resolve({ ok: false });

  const el = cursor.el as HTMLElement;
  // The label lives in a span after the status dot, so replace only that.
  if (cursor.tag?.lastChild) cursor.tag.lastChild.textContent = label;

  const already = Math.abs(cursor.x - x) < 2 && Math.abs(cursor.y - y) < 2;
  cursor.x = x;
  cursor.y = y;
  if (already) return Promise.resolve({ ok: true });

  return new Promise<{ ok: boolean }>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("transitionend", finish);
      el.classList.remove("mv");
      resolve({ ok: true });
    };

    el.addEventListener("transitionend", finish);
    el.classList.add("mv");
    el.style.transitionDuration = `${ms}ms`;
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;

    // transitionend does not fire if the transition never starts — a
    // background tab, or a duplicate target. Without this the click would
    // never be dispatched.
    setTimeout(finish, ms + 140);
  });
}

/** Ripple at the cursor's current position, fired as the click lands. */
function pulseCursor() {
  const store = (window as unknown as Record<string, any>).__tinyBrow;
  const cursor = store?.cursor;
  if (!cursor?.root) return { ok: false };

  const ring = document.createElement("div");
  ring.className = "r";
  ring.style.transform = `translate3d(${cursor.x}px, ${cursor.y}px, 0)`;
  ring.style.animation = "tb-pulse 520ms cubic-bezier(0.2,0.8,0.3,1) forwards";
  cursor.root.appendChild(ring);
  setTimeout(() => ring.remove(), 640);
  return { ok: true };
}

function removeCursor() {
  const store = (window as unknown as Record<string, any>).__tinyBrow;
  store?.cursor?.host?.remove();
  if (store) store.cursor = null;
  return { ok: true };
}

interface EvaluateResult {
  result: { value?: { ok: boolean } };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

async function run(tabId: number, expression: string, awaitPromise = false) {
  const { result, exceptionDetails } = await send<EvaluateResult>(
    tabId,
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise },
  );
  if (exceptionDetails) {
    throw new Error(
      `Cursor threw in the page: ${
        exceptionDetails.exception?.description ?? exceptionDetails.text
      }`,
    );
  }
  return result?.value?.ok ?? false;
}

export const ensure = (tabId: number, label = "Tiny") =>
  run(tabId, `(${ensureCursor.toString()})(${JSON.stringify(label)})`);

export const glideTo = (
  tabId: number,
  x: number,
  y: number,
  label = "Tiny",
  ms = GLIDE_MS,
) => run(tabId, `(${moveCursor.toString()})(${x}, ${y}, ${ms}, ${JSON.stringify(label)})`, true);

export const pulse = (tabId: number) => run(tabId, `(${pulseCursor.toString()})()`);

export const remove = (tabId: number) => run(tabId, `(${removeCursor.toString()})()`);
