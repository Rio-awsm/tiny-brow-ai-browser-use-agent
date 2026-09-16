import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A minimal CDP client over a headless Chrome's WebSocket. No dependency. */

export interface Tab {
  goto: (url: string, settleMs: number) => Promise<void>;
  reload: (settleMs: number) => Promise<void>;
  evaluate: <T>(expression: string) => Promise<T>;
  close: () => Promise<void>;
}

export interface Browser {
  open: (url: string, settleMs: number) => Promise<Tab>;
  close: () => Promise<void>;
}

export const VIEWPORT = { width: 1280, height: 800 };

function findBrowser(): string {
  const env = process.env.CHROME_PATH;
  if (env) return env;
  const local = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    join(local, "Google\\Chrome\\Application\\chrome.exe"),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error("\n  no Chrome or Edge found — set CHROME_PATH to a Chromium binary\n");
    process.exit(1);
  }
  return found;
}

export async function launchBrowser(): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), "tiny-brow-chrome-"));
  const child: ChildProcess = spawn(
    findBrowser(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("browser did not start within 20s")), 20_000);
    child.stderr!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const m = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
    child.once("exit", (code) => reject(new Error(`browser exited early (${code})`)));
  });

  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const waiters: { sessionId: string; method: string; resolve: () => void }[] = [];

  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
      return;
    }
    const at = waiters.findIndex((w) => w.sessionId === msg.sessionId && w.method === msg.method);
    if (at >= 0) waiters.splice(at, 1)[0]!.resolve();
  });

  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const waitFor = (sessionId: string, method: string, ms: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), ms);
      waiters.push({ sessionId, method, resolve: () => (clearTimeout(timer), resolve()) });
    });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return {
    async open(url, settleMs) {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      await send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false }, sessionId);
      await send("Page.enable", {}, sessionId);

      const tab: Tab = {
        async goto(target, ms) {
          const loaded = waitFor(sessionId, "Page.loadEventFired", 30_000);
          const { errorText } = await send("Page.navigate", { url: target }, sessionId);
          if (errorText) throw new Error(`could not load ${target}: ${errorText}`);
          await loaded;
          await sleep(ms);
        },
        async reload(ms) {
          const loaded = waitFor(sessionId, "Page.loadEventFired", 30_000);
          await send("Page.reload", { ignoreCache: true }, sessionId);
          await loaded;
          await sleep(ms);
        },
        async evaluate<T>(expression: string) {
          const { result, exceptionDetails } = await send(
            "Runtime.evaluate",
            { expression, returnByValue: true },
            sessionId,
          );
          if (exceptionDetails) {
            throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
          }
          return result.value as T;
        },
        async close() {
          await send("Target.closeTarget", { targetId }).catch(() => {});
        },
      };
      await tab.goto(url, settleMs);
      return tab;
    },
    async close() {
      socket.close();
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
      // Chrome can hold profile files for a moment after it exits.
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
