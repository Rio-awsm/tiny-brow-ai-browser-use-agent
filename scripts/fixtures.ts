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

import { createFixtureServer } from "./lib/fixture-server";

const PORT = Number(process.env.FIXTURE_PORT ?? 5199);
const server = createFixtureServer();

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
  console.log(`  T10 gauntlet: http://127.0.0.1:${PORT}/gauntlet/`);
  console.log(`  descriptor pages: http://127.0.0.1:${PORT}/pages/\n`);
});
