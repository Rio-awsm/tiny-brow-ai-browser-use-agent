/**
 * Rejects control characters in source.
 *
 * A backspace (0x08) written into a regex where `\b` was meant reads as a word
 * boundary in every editor and matches nothing at runtime — the pattern simply
 * stops working, silently, with no error anywhere. It reached this repo once
 * already and disabled OTP detection for several milestones.
 *
 *   npm run check:chars
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROOTS = ["src", "harness", "scripts", "fixtures"];
const EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".json", ".md"]);
const IGNORED = new Set(["node_modules", ".git", ".wxt", ".output", "dist"]);

/** Tab, newline and carriage return are the only control characters allowed. */
const BANNED = new Set([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x0b, 0x0c, 0x0e, 0x0f, 0x1b, 0x7f,
]);

const NAMES: Record<number, string> = {
  0x07: "BEL (\a)", 0x08: "BACKSPACE (\b)", 0x0b: "VTAB (\v)",
  0x0c: "FORMFEED (\f)", 0x1b: "ESC (\e)", 0x00: "NUL (\0)",
};

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (IGNORED.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT.has(extname(full))) out.push(full);
  }
  return out;
}

const root = process.cwd();
let found = 0;
let scanned = 0;

for (const dir of ROOTS) {
  for (const file of walk(join(root, dir))) {
    scanned++;
    const bytes = readFileSync(file);
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]!;
      if (!BANNED.has(byte)) continue;
      const line = bytes.subarray(0, i).toString("utf8").split("\n").length;
      console.error(
        `  ${relative(root, file)}:${line}  ${NAMES[byte] ?? `0x${byte.toString(16)}`}`,
      );
      found++;
    }
  }
}

if (found) {
  console.error(
    `\n  ${found} control character(s) in source.\n\n` +
      "  Almost certainly an escape that was interpreted when it should have been\n" +
      "  written literally — `\b` becoming a backspace byte, say. The pattern will\n" +
      "  look correct and match nothing.\n",
  );
  process.exit(1);
}

console.log(`\n  ok — no control characters (${scanned} files scanned)\n`);
