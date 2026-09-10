/**
 * Everything Tiny runs inside a page is delivered by stringifying a function
 * and evaluating it there, so each one must be completely self-contained. A
 * bundler is free to hoist an inner helper to module scope, and the result
 * still builds, still typechecks, and then throws `ReferenceError` in every
 * page it touches.
 *
 * This finds every injected function in the built bundle, pulls it back out,
 * and runs it against a stub DOM. Requires `npm run build` first.
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

// Every injection is written as `(${NAME.toString()})(...)` at its call site.
const names = [...new Set([...src.matchAll(/\(\$\{(\w+)\.toString\(\)\}\)/g)].map((m) => m[1]!))];

if (names.length === 0) {
  console.error("\n  found no injected functions in the bundle — did the call-site shape change?\n");
  process.exit(1);
}

let failed = false;

for (const name of names) {
  const source = extractFunction(src, name);
  if (!source) {
    console.error(`\n  could not find \`function ${name}(\` in the bundle\n`);
    failed = true;
    continue;
  }

  try {
    invoke(source);
    console.log(`  ok — ${name} is self-contained (${source.length} bytes)`);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${name} IS NOT SELF-CONTAINED\n\n    ${text}\n`);
    if (/is not defined/.test(text)) {
      console.error(
        "  The bundler hoisted something out of the function, so the injected\n" +
          "  source references an identifier no page will have. Move it back inside\n" +
          "  the function body.\n",
      );
    }
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`\n  ${names.length} injected functions verified\n`);

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

/**
 * Runs the function with page globals only, against two page states.
 *
 * Every injected function has a "nothing set up yet" branch that returns early.
 * A single stub therefore always leaves half of them untested — populated, the
 * cursor's create path never runs; empty, the overlay's draw path never runs.
 * Running both is what makes the check mean something.
 */
function invoke(source: string): void {
  for (const populated of [true, false]) {
    const stub = makeStubDom(populated);
    const keys = Object.keys(stub);
    const factory = new Function(...keys, `return (${source});`);
    const fn = factory(...keys.map((k) => stub[k])) as (...args: unknown[]) => unknown;
    // The indexer takes (indexCap, textCap) and focusIndexed takes (index,
    // selectAll); both are satisfied by these, and the rest ignore their args.
    fn(40, 4000);
  }
}

function makeStubDom(populated: boolean): Record<string, unknown> {
  const rect = { left: 10, top: 20, width: 100, height: 30, right: 110, bottom: 50 };

  function makeEl(tag = "div"): any {
    const el: any = {
      tagName: tag.toUpperCase(),
      children: [],
      shadowRoot: null,
      dataset: {},
      className: "",
      style: { cssText: "", setProperty() {} },
      textContent: "",
      innerText: "",
      value: "",
      type: "text",
      checked: false,
      disabled: false,
      selectedOptions: [],
      isConnected: true,
      innerHTML: "",
      focus() {},
      select() {},
      scrollIntoView() {},
      addEventListener() {},
      removeEventListener() {},
      classList: { add() {}, remove() {}, toggle() {} },
      lastChild: { textContent: "" },
      parentElement: null,
      hasAttribute: () => false,
      getAttribute: () => null,
      setAttribute() {},
      contains: () => false,
      getBoundingClientRect: () => rect,
      appendChild(child: unknown) {
        el.children.push(child);
        return child;
      },
      remove() {},
      attachShadow: () => ({ appendChild() {} }),
      isContentEditable: false,
    };
    el.ownerDocument = doc;
    return el;
  }

  const doc: any = {
    createTreeWalker: () => ({ nextNode: () => null }),
    createElement: (tag: string) => makeEl(tag),
    createTextNode: (text: string) => ({ textContent: text }),
    elementFromPoint: () => null,
    getElementById: () => null,
    querySelectorAll: () => [],
    readyState: "complete",
    title: "Stub",
    body: { innerText: "" },
    documentElement: null,
    defaultView: null,
  };

  doc.documentElement = makeEl("html");
  doc.documentElement.scrollHeight = 2000;

  const win: any = {
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    frameElement: null,
    getComputedStyle: () => ({
      cursor: "auto",
      display: "block",
      visibility: "visible",
      opacity: "1",
    }),
    // Sized past the highest index any injected function is called with below,
    // so none of them bail out before reaching their helpers.
    __tinyBrow: populated
      ? {
          els: Array.from({ length: 64 }, () => makeEl("button")),
          meta: Array.from({ length: 64 }, (_, i) => ({ i, role: "button", label: "Go" })),
          cursor: {
            host: makeEl("div"),
            el: makeEl("div"),
            root: makeEl("div"),
            tag: makeEl("div"),
            x: 0,
            y: 0,
          },
          overlay: { destroy() {} },
        }
      : undefined,
  };
  doc.defaultView = win;

  return {
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
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
