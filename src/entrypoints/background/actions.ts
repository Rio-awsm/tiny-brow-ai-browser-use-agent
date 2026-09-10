import { resolveKey, type Command } from "@/lib/commands";
import { send } from "./cdp";
import * as cursor from "./cursor";

/** Also spelled literally inside `focusIndexed`, which cannot import. */
export const NO_INDEX = "no index on this page yet";

export interface ActionResult {
  summary: string;
  detail?: string;
  tookMs: number;
  /** Where the click landed, so the transcript can say it precisely. */
  at?: { x: number; y: number };
  /** True when the target had to be scrolled into view first. */
  scrolled?: boolean;
}

interface Target {
  ok: boolean;
  error?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  scrolled: boolean;
  role: string;
  label: string;
}

/**
 * Scrolls element N into view and reports where it ended up.
 *
 * The re-read after scrolling is the whole point: coordinates recorded when the
 * index was built are stale the moment the page moves, and dispatching to them
 * clicks whatever slid into that spot.
 */
function focusIndexed(index: number, selectAll: boolean) {
  const store = (window as unknown as Record<string, any>).__tinyBrow;
  if (!store?.els) {
    // Keep in sync with NO_INDEX in this module.
    return { ok: false, error: "no index on this page yet — build one first" };
  }

  const el = store.els[index] as Element | undefined;
  if (!el) {
    return {
      ok: false,
      error: `[${index}] is not in the current index (0-${store.els.length - 1})`,
    };
  }
  if (!el.isConnected) {
    return { ok: false, error: `[${index}] has left the page — rebuild the index` };
  }

  function viewportRect(node: Element) {
    const r = node.getBoundingClientRect();
    let x = r.left;
    let y = r.top;
    let win: Window | null = node.ownerDocument.defaultView;
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

  let rect = viewportRect(el);
  const offscreen =
    rect.y < 0 ||
    rect.x < 0 ||
    rect.y + rect.h > window.innerHeight ||
    rect.x + rect.w > window.innerWidth;

  if (offscreen) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
    rect = viewportRect(el);
  }

  if (selectAll) {
    const field = el as HTMLInputElement;
    if (typeof field.select === "function") {
      field.focus();
      field.select();
    }
  }

  const meta = store.meta?.[index] ?? {};
  const clamp = (v: number, hi: number) => Math.min(Math.max(v, 1), hi - 1);

  return {
    ok: true,
    // Clamped, because an element pinned inside a fixed container can still sit
    // partly outside the viewport after scrollIntoView.
    x: clamp(Math.round(rect.x + rect.w / 2), window.innerWidth),
    y: clamp(Math.round(rect.y + rect.h / 2), window.innerHeight),
    w: Math.round(rect.w),
    h: Math.round(rect.h),
    scrolled: offscreen,
    role: meta.role ?? "",
    label: meta.label ?? "",
  };
}

interface EvaluateResult<T> {
  result: { value?: T };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

async function evaluate<T>(tabId: number, expression: string): Promise<T> {
  const { result, exceptionDetails } = await send<EvaluateResult<T>>(
    tabId,
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: false },
  );
  if (exceptionDetails) {
    throw new Error(
      exceptionDetails.exception?.description ?? exceptionDetails.text,
    );
  }
  return result.value as T;
}

async function target(tabId: number, index: number, selectAll = false): Promise<Target> {
  const t = await evaluate<Target>(
    tabId,
    `(${focusIndexed.toString()})(${index}, ${selectAll})`,
  );
  if (!t?.ok) throw new Error(t?.error ?? "could not resolve that element");
  // Give a scroll a frame to settle before anything is dispatched at it.
  if (t.scrolled) await sleep(120);
  return t;
}

/**
 * Real input events at the browser's input layer.
 *
 * Never `element.click()`. Modern frameworks and every bot-detection layer check
 * `isTrusted`, and a synthetic DOM event fails that check — silently, on exactly
 * the sites worth automating. CDP input is indistinguishable from a real mouse.
 */
async function clickAt(
  tabId: number,
  x: number,
  y: number,
  showCursor: boolean,
  label = "Tiny",
) {
  const base = { x, y, pointerType: "mouse" as const };

  if (showCursor) {
    // Awaited, so the click lands after the cursor arrives rather than while it
    // is still travelling — otherwise the animation is a lie about what happened.
    await cursor.glideTo(tabId, x, y, label);
  }

  await send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseMoved", button: "none", buttons: 0 });
  await sleep(60);
  await send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed", button: "left", buttons: 1, clickCount: 1 });
  if (showCursor) await cursor.pulse(tabId);
  await sleep(35);
  await send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 });
}

async function pressKey(tabId: number, name: string) {
  const spec = resolveKey(name);
  if (!spec) throw new Error(`unknown key "${name}"`);

  const shared = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
  };
  await send(tabId, "Input.dispatchKeyEvent", {
    ...shared,
    type: spec.text ? "keyDown" : "rawKeyDown",
    text: spec.text,
    unmodifiedText: spec.text,
  });
  await sleep(25);
  await send(tabId, "Input.dispatchKeyEvent", { ...shared, type: "keyUp" });
}

async function typeText(tabId: number, text: string, mode: "insert" | "keys") {
  if (mode === "insert") {
    await send(tabId, "Input.insertText", { text });
    return;
  }
  // Per-character, because some search boxes only open their autocomplete on a
  // real keydown and ignore a bulk insert entirely.
  for (const ch of text) {
    const code = ch.toUpperCase().charCodeAt(0);
    await send(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      text: ch,
      unmodifiedText: ch,
      key: ch,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    });
    await sleep(18);
    await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: code });
  }
}

interface LayoutMetrics {
  cssVisualViewport?: { clientWidth: number; clientHeight: number };
  cssLayoutViewport?: { clientWidth: number; clientHeight: number };
}

export async function runCommand(
  tabId: number,
  command: Command,
  showCursor: boolean,
): Promise<ActionResult> {
  const started = performance.now();
  // Re-created on demand, which is also how it comes back after a navigation.
  if (showCursor) await cursor.ensure(tabId);
  const done = (summary: string, extra: Partial<ActionResult> = {}): ActionResult => ({
    summary,
    tookMs: Math.round(performance.now() - started),
    ...extra,
  });

  switch (command.kind) {
    case "click": {
      const t = await target(tabId, command.index);
      await clickAt(tabId, t.x, t.y, showCursor, `Tiny · clicking ${describe(t)}`.slice(0, 44));
      return done(`clicked [${command.index}] ${describe(t)}`, {
        at: { x: t.x, y: t.y },
        scrolled: t.scrolled,
        detail: t.scrolled ? "scrolled into view, then re-read its position" : undefined,
      });
    }

    case "type": {
      const t = await target(tabId, command.index, true);
      await clickAt(tabId, t.x, t.y, showCursor, "Tiny · typing");
      await sleep(80);
      await typeText(tabId, command.text, command.mode);
      return done(
        `typed ${JSON.stringify(command.text)} into [${command.index}] ${describe(t)}`,
        {
          at: { x: t.x, y: t.y },
          scrolled: t.scrolled,
          detail: command.mode === "keys" ? "per keystroke" : "bulk insert",
        },
      );
    }

    case "key":
      await pressKey(tabId, command.name);
      return done(`pressed ${command.name}`);

    case "scroll": {
      const metrics = await send<LayoutMetrics>(tabId, "Page.getLayoutMetrics");
      const v = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
      const w = Math.round(v?.clientWidth ?? 800);
      const h = Math.round(v?.clientHeight ?? 600);
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.round(w / 2),
        y: Math.round(h / 2),
        deltaX: 0,
        deltaY: command.direction === "down" ? command.amount : -command.amount,
        pointerType: "mouse",
      });
      return done(`scrolled ${command.direction} ${command.amount}px`);
    }

    case "goto":
      await send(tabId, "Page.navigate", { url: command.url });
      return done(`navigated to ${command.url}`);

    case "index":
    case "help":
      throw new Error(`"${command.kind}" is handled in the panel, not here`);
  }
}

function describe(t: Target): string {
  const label = t.label ? ` ${JSON.stringify(t.label)}` : "";
  return `${t.role}${label}`.trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
