import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";

export const FIXTURE_ROOT = join(process.cwd(), "fixtures");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export function createFixtureServer(): Server {
  return createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    // Contain every request inside fixtures/, whatever the path claims.
    const resolved = normalize(join(FIXTURE_ROOT, path)).replace(/[\/]+$/, "");

    if (!resolved.startsWith(FIXTURE_ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    const file =
      existsSync(resolved) && statSync(resolved).isDirectory()
        ? join(resolved, "index.html")
        : resolved;

    if (!existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" }).end(`no fixture at ${path}`);
      return;
    }

    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      // Fixtures change while you iterate on them; a cached copy is a debugging trap.
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
  });
}

/** Serves on an ephemeral port, for checks that must not collide with `npm run fixtures`. */
export function serveFixturesEphemeral(): Promise<{ origin: string; close: () => void }> {
  const server = createFixtureServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}
