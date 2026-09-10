/**
 * Serves the local fixtures the suite depends on.
 *
 * T10 exists to test interruption handling, so its cookie banner and login wall
 * have to be present every single time and identical every single time. Pointing
 * it at a real site would make it fail for reasons that have nothing to do with
 * interruptions.
 *
 *   npm run fixtures
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.FIXTURE_PORT ?? 5199);
const ROOT = join(process.cwd(), "fixtures");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
  // Contain every request inside fixtures/, whatever the path claims.
  const resolved = normalize(join(ROOT, path)).replace(/[\/]+$/, "");

  if (!resolved.startsWith(ROOT)) {
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

// A stale server from an earlier session is the usual cause, and an unhandled
// EADDRINUSE reports it as a stack trace rather than as the one-line problem it
// actually is.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") throw err;
  console.error(`
  Port ${PORT} is already in use.

  Either a fixture server is already running — in which case you are ready to
  go — or one was left behind. To find and stop it:

    Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ForEach-Object {
      Stop-Process -Id $_.OwningProcess -Force }

  Or serve somewhere else:  $env:FIXTURE_PORT=5200; npm run fixtures
`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  fixtures on http://127.0.0.1:${PORT}`);
  console.log(`  T10 gauntlet: http://127.0.0.1:${PORT}/gauntlet/\n`);
});
