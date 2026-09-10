/**
 * The page indexer is injected by stringifying a function and evaluating it in
 * the page, so it must be completely self-contained. A bundler is free to hoist
 * an inner helper to module scope, and the result still builds, still typechecks,
 * and then throws `ReferenceError` inside every page it touches.
 *
 * This extracts the real function out of the built bundle and runs it against a
 * stub DOM. Requires `npm run build` first.
 *
 *   npm run check:extractor
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BUNDLE = join(process.cwd(), ".output", "chrome-mv3", "background.js");

if (!existsSync(BUNDLE)) {
  console.error(`\n  no build found at ${BUNDLE} — run \`npm run build\` first\n`);
  process.exit(1);
}

const src = readFileSync(BUNDLE, "utf8");

// The call site is `expression: \`(${NAME.toString()})(40, 4000)\``.
const call = /\(\$\{(\w+)\.toString\(\)\}\)/.exec(src);
if (!call) {
  console.error("\n  could not find the injected-extractor call site in the bundle\n");
  process.exit(1);
}
const name = call[1]!;

const source = extractFunction(src, name);
if (!source) {
  console.error(`\n  could not find \`function ${name}(\` in the bundle\n`);
  process.exit(1);
}

let result: ExtractorResult;
try {
  result = runAgainstStubDom(source);
} catch (err) {
  const text = err instanceof Error ? err.message : String(err);
  console.error(`\n  INJECTED EXTRACTOR IS NOT SELF-CONTAINED\n\n    ${text}\n`);
  if (/is not defined/.test(text)) {
    console.error(
      "  The bundler hoisted something out of the function, so the injected\n" +
        "  source references an identifier no page will have. Move it back inside\n" +
        "  the function body.\n",
    );
  }
  process.exit(1);
}

if (result.elements.length !== 0 || result.totalFound !== 0) {
  console.error("\n  stub DOM has no elements but the extractor found some\n");
  process.exit(1);
}

console.log(
  `\n  ok — injected extractor is self-contained ` +
    `(${name}, ${source.length} bytes, ran clean on a stub DOM)\n`,
);

/** Brace-matches a function declaration out of the bundle. */
function extractFunction(bundle: string, fnName: string): string | null {
  const start = bundle.indexOf(`function ${fnName}(`);
  if (start === -1) return null;

  let depth = 0;
  let seenBody = false;
  for (let i = start; i < bundle.length; i++) {
    const ch = bundle[i];
    if (ch === "{") {
      depth++;
      seenBody = true;
    } else if (ch === "}") {
      depth--;
      if (seenBody && depth === 0) return bundle.slice(start, i + 1);
    }
  }
  return null;
}

interface ExtractorResult {
  elements: unknown[];
  totalFound: number;
}

/**
 * Just enough DOM for the extractor to run to completion on an empty page.
 * Any reference it makes to a hoisted helper throws here instead of in a user's
 * browser.
 */
function runAgainstStubDom(source: string): ExtractorResult {
  const emptyWalker = { nextNode: () => null };

  const documentElement = { scrollHeight: 2000 };
  const body = { innerText: "" };

  const doc = {
    createTreeWalker: () => emptyWalker,
    elementFromPoint: () => null,
    getElementById: () => null,
    title: "Stub",
    body,
    documentElement,
    defaultView: null as unknown,
  };

  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: () => ({ cursor: "auto", display: "block", visibility: "visible", opacity: "1" }),
  };
  doc.defaultView = win;

  const sandbox = {
    document: doc,
    window: win,
    location: { href: "https://stub.invalid/" },
    performance: { now: () => 0 },
    NodeFilter: { SHOW_ELEMENT: 1 },
    ShadowRoot: class {},
    HTMLInputElement: class {},
    HTMLSelectElement: class {},
    HTMLButtonElement: class {},
    HTMLIFrameElement: class {},
  };

  const keys = Object.keys(sandbox);
  const values = keys.map((k) => sandbox[k as keyof typeof sandbox]);

  const factory = new Function(...keys, `return (${source});`);
  const extractor = factory(...values) as (cap: number, textCap: number) => ExtractorResult;
  return extractor(40, 4000);
}
