/**
 * The seam between the Node-side scorer and the agent, which lives in a browser
 * extension and cannot be imported.
 *
 * A local HTTP server hands out one task at a time; the extension polls it,
 * runs the task with the real loop against the real browser, and posts the
 * outcome back. Everything the harness already knows how to do — the
 * (task, provider, model) triple, the timing split, the failure taxonomy —
 * applies unchanged, because this is just another `AgentDriver`.
 *
 * Plain HTTP polling rather than a socket: no dependency, no upgrade
 * handshake, and it survives the extension's service worker being evicted
 * mid-suite.
 */

import { createServer, type Server } from "node:http";
import type {
  AgentDriver,
  AgentOutcome,
  BackendConfig,
  DriveOptions,
  StepRecord,
} from "./types.js";

export const DEFAULT_PORT = 8787;

interface PendingTask {
  id: string;
  task: string;
  startUrl: string | null;
  stepCap: number;
  backend: BackendConfig;
  resolve: (outcome: AgentOutcome) => void;
  reject: (err: Error) => void;
  handedOut: boolean;
}

export class BridgeDriver implements AgentDriver {
  readonly name = "bridge";

  private server: Server | null = null;
  private pending: PendingTask | null = null;
  private connectedAt = 0;
  private readonly port: number;
  private readonly quiet: boolean;

  constructor(opts: { port?: number; quiet?: boolean } = {}) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.quiet = opts.quiet ?? false;
  }

  async setup(): Promise<void> {
    this.server = createServer((req, res) => this.route(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, "127.0.0.1", resolve);
    });

    if (!this.quiet) {
      console.log(`\n  bridge listening on http://127.0.0.1:${this.port}`);
      console.log("  open the Tiny side panel and turn on Benchmark under Tools\n");
    }
    await this.waitForExtension();
  }

  async teardown(): Promise<void> {
    this.pending?.reject(new Error("suite ended before the task came back"));
    this.pending = null;
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      // Polling requests hold sockets open; close them so the process can exit.
      this.server.closeAllConnections?.();
    });
    this.server = null;
  }

  drive(opts: DriveOptions): Promise<AgentOutcome> {
    return new Promise<AgentOutcome>((resolve, reject) => {
      this.pending = {
        id: `${opts.task.id}-${Date.now()}`,
        task: opts.task.prompt,
        startUrl: opts.task.startUrl,
        stepCap: opts.stepCap,
        backend: opts.backend,
        resolve,
        reject,
        handedOut: false,
      };

      opts.signal.addEventListener("abort", () => {
        this.pending = null;
        reject(new Error("attempt timed out"));
      });
    });
  }

  /** Blocks the suite until the panel says hello, so nothing is scored against a closed panel. */
  private async waitForExtension(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.connectedAt > 0) return;
      await sleep(250);
    }
    throw new Error(
      "no extension connected — open the side panel and enable Benchmark, then rerun",
    );
  }

  private route(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
    // The panel is an extension origin, so every request is cross-origin.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return end(res, 204, null);

    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/health") {
      this.connectedAt ||= Date.now();
      return end(res, 200, { ok: true, waiting: this.pending !== null });
    }

    if (url.pathname === "/task") {
      this.connectedAt ||= Date.now();
      if (!this.pending || this.pending.handedOut) return end(res, 204, null);
      this.pending.handedOut = true;
      const { id, task, startUrl, stepCap, backend } = this.pending;
      return end(res, 200, { id, task, startUrl, stepCap, backend });
    }

    if (url.pathname === "/result" && req.method === "POST") {
      return readJson(req).then((body) => {
        const payload = body as { id?: string; outcome?: AgentOutcome };
        const current = this.pending;
        if (!current || payload.id !== current.id) {
          // A result for a task that already timed out. Acknowledged and dropped.
          return end(res, 200, { ok: true, stale: true });
        }
        this.pending = null;
        current.resolve(normalise(payload.outcome));
        return end(res, 200, { ok: true });
      });
    }

    return end(res, 404, { error: "not found" });
  }
}

/** Trusts nothing about the shape that came back over the wire. */
function normalise(outcome: AgentOutcome | undefined): AgentOutcome {
  const steps: StepRecord[] = Array.isArray(outcome?.steps) ? outcome.steps : [];
  return {
    answer: typeof outcome?.answer === "string" ? outcome.answer : "",
    data: outcome?.data,
    completed: outcome?.completed === true,
    finalUrl: typeof outcome?.finalUrl === "string" ? outcome.finalUrl : "",
    steps,
    failure: outcome?.failure,
    error: outcome?.error,
  };
}

function end(res: import("node:http").ServerResponse, code: number, body: unknown) {
  if (body === null) {
    res.writeHead(code);
    return res.end();
  }
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
