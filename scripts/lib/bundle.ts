import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BUNDLE = join(process.cwd(), ".output", "chrome-mv3", "background.js");

/** The built background bundle, or exit with the one thing to do about it. */
export function readBundle(): string {
  if (!existsSync(BUNDLE)) {
    console.error(`\n  no build found at ${BUNDLE} — run \`npm run build\` first\n`);
    process.exit(1);
  }
  return readFileSync(BUNDLE, "utf8");
}

/**
 * Brace-matches a function declaration out of the bundle.
 *
 * Minified names repeat across scopes, so `function S(` can also be a helper
 * nested inside some other function. The injected one is the declaration no
 * other declaration contains.
 */
export function extractFunction(bundle: string, fnName: string): string | null {
  const spans = [...bundle.matchAll(/function\s+[\w$]+\(/g)]
    .map((m) => ({ start: m.index!, end: bodyEnd(bundle, m.index!), head: m[0] }))
    .filter((s) => s.end !== -1);

  const wanted = new RegExp(`^function\\s+${fnName.replace(/\$/g, "\\$")}\\($`);
  const outermost = spans.find(
    (s) =>
      wanted.test(s.head) &&
      !spans.some((o) => o !== s && o.start < s.start && o.end >= s.end),
  );
  return outermost ? bundle.slice(outermost.start, outermost.end + 1) : null;
}

function bodyEnd(bundle: string, start: number): number {
  let depth = 0;
  let seenBody = false;
  for (let i = start; i < bundle.length; i++) {
    const ch = bundle[i];
    if (ch === "{") {
      depth++;
      seenBody = true;
    } else if (ch === "}") {
      depth--;
      if (seenBody && depth === 0) return i;
    }
  }
  return -1;
}
