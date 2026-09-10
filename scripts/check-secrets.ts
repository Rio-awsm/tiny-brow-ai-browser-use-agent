/**
 * Enforces the one security invariant this project cannot get wrong:
 * no credential ever reaches the extension bundle.
 *
 * Vite inlines `import.meta.env` at build time. An API key read from `.env`
 * inside extension source would be baked into the published .zip and shipped
 * to every user who installs it. The README says this; this script makes it
 * true. It runs in `npm run check` so it cannot be forgotten.
 *
 * Three rules:
 *   1. Extension source must not read `import.meta.env` or `process.env`.
 *   2. Extension source must not import from `harness/` (which does read .env).
 *   3. No file may contain a live-looking key literal — including the built
 *      bundle in .output/, which is the artifact the claim is actually about.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

/** Directories that end up inside the shipped extension bundle. */
const EXTENSION_DIRS = ["entrypoints", "src", "components"];

/** Never scanned. */
const IGNORED = new Set(["node_modules", ".git", ".wxt", "dist", "harness-results"]);

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".svelte", ".vue"]);

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

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
    else out.push(full);
  }
  return out;
}

const root = process.cwd();
const violations: Violation[] = [];

// Rules 1 and 2 — scoped to the extension source tree only. The harness is
// allowed, and required, to read .env.
for (const dir of EXTENSION_DIRS) {
  for (const file of walk(join(root, dir))) {
    if (!SOURCE_EXT.has(extname(file))) continue;
    const rel = relative(root, file);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
      if (/import\.meta\.env/.test(text)) {
        violations.push({ file: rel, line: i + 1, rule: "import.meta.env in extension source", text });
      }
      if (/\bprocess\.env\b/.test(text)) {
        violations.push({ file: rel, line: i + 1, rule: "process.env in extension source", text });
      }
      if (/from\s+["'][^"']*harness\//.test(text)) {
        violations.push({ file: rel, line: i + 1, rule: "extension source imports harness/", text });
      }
    });
  }
}

// Rule 3 — key-shaped literals anywhere tracked. Prefixes are the public,
// documented ones for each provider.
const KEY_PATTERNS: Array<[string, RegExp]> = [
  ["Groq key", /\bgsk_[A-Za-z0-9]{20,}/],
  ["OpenAI key", /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenRouter key", /\bsk-or-v1-[A-Za-z0-9]{20,}/],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{30,}/],
];

// The built bundle is scanned when present: that is what ships, and it is the
// only place an inlined key would actually show up.
const SCAN_DIRS = [".", ...EXTENSION_DIRS, ".output"];
const seen = new Set<string>();
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(root, dir))) {
    const rel = relative(root, file);
    if (seen.has(rel)) continue;
    seen.add(rel);
    // .env is gitignored and is the one place a real key legitimately lives.
    if (rel === ".env" || rel.startsWith(`.env${sep}`)) continue;
    const ext = extname(file);
    if (!SOURCE_EXT.has(ext) && ![".json", ".md", ".html", ".css", ".example", ""].includes(ext)) {
      continue;
    }
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    content.split(/\r?\n/).forEach((text, i) => {
      for (const [label, re] of KEY_PATTERNS) {
        if (re.test(text)) {
          violations.push({ file: rel, line: i + 1, rule: `${label} literal`, text: text.trim().slice(0, 60) });
        }
      }
    });
  }
}

if (violations.length) {
  console.log("\n  SECRET BOUNDARY VIOLATIONS\n");
  for (const v of violations) {
    console.log(`    ${v.file}:${v.line}  ${v.rule}`);
    console.log(`      ${v.text.trim().slice(0, 100)}`);
  }
  console.log("\n  Credentials belong in the settings UI -> chrome.storage, never in the bundle.\n");
  process.exit(1);
}

const scanned = [...seen].length;
console.log(`\n  ok — secret boundary clean (${scanned} files scanned)\n`);
