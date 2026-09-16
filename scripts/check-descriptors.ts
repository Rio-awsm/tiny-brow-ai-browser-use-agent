/**
 * Runs the built indexer in a real headless Chrome and checks the descriptors
 * it records: that every shown element has one, that a reload produces
 * byte-identical output, that the model-facing index did not change shape, and
 * that the tricky cases in the fixtures resolve the way the matcher will need.
 *
 * Needs `npm run build` and a local Chrome or Edge (or CHROME_PATH).
 *
 *   npm run check:descriptors
 *   npm run check:descriptors -- https://www.amazon.in/s?k=wireless+mouse   (report only)
 *   npm run check:descriptors -- --dump fixtures/pages/shop.html
 *   npm run check:descriptors -- --update   (rewrite fixtures/descriptors after an intended change)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  DESCRIPTOR_CAP,
  INDEX_CAP,
  TEXT_CAP,
  estimateTokens,
  serializeIndex,
  type ElementDescriptor,
  type PageIndex,
} from "../src/lib/page-index";
import { extractFunction, readBundle } from "./lib/bundle";
import { FIXTURE_ROOT, serveFixturesEphemeral } from "./lib/fixture-server";
import { snapshotPath } from "./lib/snapshots";

const ELEMENT_KEYS = "frame,h,i,inViewport,label,note,role,tag,w,x,y";

/** Aggregate floors over the fixture set; below these the resolver needs work before F2. */
const MIN_NAMED = 0.95;
const MIN_LANDMARKED = 0.75;

interface Expectation {
  page: string;
  find: (d: ElementDescriptor) => boolean;
  what: string;
  check: (d: ElementDescriptor) => string | null;
}

const eq = (label: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? null
    : `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`;

const EXPECT: Expectation[] = [
  {
    page: "pages/shop.html",
    what: "badge count stripped, testid kept, hex id dropped",
    find: (d) => d.name === "Cart (3)",
    check: (d) =>
      eq("nameNorm", d.nameNorm, "cart") ??
      eq("stable", d.stable, { "data-testid": "nav-cart" }) ??
      eq("landmarks", d.landmarks, ["header"]),
  },
  {
    page: "pages/shop.html",
    what: "React useId dropped",
    find: (d) => d.name === "Account & Lists",
    check: (d) => eq("stable", d.stable, {}),
  },
  {
    page: "pages/shop.html",
    what: "search box named by aria-label inside a labelled search landmark",
    find: (d) => d.stable.name === "field-keywords",
    check: (d) =>
      eq("name", d.name, "Search Amazon.in") ??
      eq("landmarks", d.landmarks, ["header", "search:search amazon.in"]) ??
      eq("id", d.stable.id, "twotabsearchtextbox"),
  },
  {
    page: "pages/shop.html",
    what: "product button: counter id dropped, card is the repeated item",
    find: (d) => d.name === "Add to cart" && d.context.item.includes("Dell MS116"),
    check: (d) =>
      eq("stable", d.stable, { type: "submit" }) ??
      eq("landmarks", d.landmarks, ["main"]) ??
      eq("heading", d.context.heading, "Dell MS116 Optical Wired Mouse"),
  },
  {
    page: "pages/shop.html",
    what: "checkbox named by its wrapping label, mui id dropped",
    find: (d) => d.role === "checkbox" && d.name === "HP",
    check: (d) =>
      eq("landmarks", d.landmarks, ["aside:filters"]) ??
      eq("stable", d.stable, { type: "checkbox" }) ??
      eq("heading", d.context.heading, "Brands"),
  },
  {
    page: "pages/shop.html",
    what: "icon-only link named by its image",
    find: (d) => d.tag === "a" && d.name === "Amazon.in",
    check: (d) => eq("landmarks", d.landmarks, ["header"]),
  },
  {
    page: "pages/shop.html",
    what: "pagination: a bare number keeps its name",
    find: (d) => d.name === "2" && d.tag === "a",
    check: (d) => eq("landmarks", d.landmarks, ["main", "nav:pagination"]),
  },
  {
    page: "pages/form.html",
    what: "input named by a wrapping label, inside a form labelled by id",
    find: (d) => d.stable.name === "custname",
    check: (d) =>
      eq("name", d.name, "Customer name:") ??
      eq("landmarks", d.landmarks, ["main", "form:pizza order"]),
  },
  {
    page: "pages/form.html",
    what: "React 19 useId in id dropped, label[for] still resolves",
    find: (d) => d.stable.name === "custemail",
    check: (d) => eq("name", d.name, "E-mail address:") ?? eq("id", d.stable.id, undefined),
  },
  {
    page: "pages/form.html",
    what: "placeholder-only and title-only fields, generated name dropped",
    find: (d) => d.name === "Gift message",
    check: (d) => eq("stable", d.stable, { type: "text" }),
  },
  {
    page: "pages/form.html",
    what: "reset button named by value",
    find: (d) => d.name === "Clear form",
    check: (d) => eq("role", d.role, "button"),
  },
  {
    page: "pages/dialog.html",
    what: "icon close button named by svg title, inside a labelled modal",
    find: (d) => d.name === "Close",
    check: (d) => eq("landmarks", d.landmarks, ["dialog:unsaved changes"]),
  },
  {
    page: "pages/dialog.html",
    what: "radix id dropped",
    find: (d) => d.name === "Discard",
    check: (d) => eq("stable", d.stable, { type: "submit" }),
  },
  {
    page: "pages/mail.html",
    what: "folder count stripped, ember id dropped",
    find: (d) => d.name === "Inbox 12",
    check: (d) =>
      eq("nameNorm", d.nameNorm, "inbox") ??
      eq("stable", d.stable, {}) ??
      eq("landmarks", d.landmarks, ["nav:mailboxes"]),
  },
  {
    page: "pages/mail.html",
    what: "shadow DOM button: testid and landmark cross the boundary",
    find: (d) => d.name === "Archive",
    check: (d) =>
      eq("stable", d.stable, { "data-testid": "archive", type: "submit" }) ??
      eq("landmarks", d.landmarks, ["main"]),
  },
  {
    page: "pages/mail.html",
    what: "shadow DOM aria-labelledby resolves inside the shadow root",
    find: (d) => d.name === "Refresh",
    check: () => null,
  },
  {
    page: "pages/mail.html",
    what: "thread row is a repeated item under its heading",
    find: (d) => d.role === "listitem" && d.name.includes("GitHub"),
    check: (d) =>
      eq("stable", d.stable, { "data-qa": "thread" }) ?? eq("heading", d.context.heading, "Primary"),
  },
  {
    page: "pages/mail.html",
    what: "same-origin iframe control keeps its frame and its form",
    find: (d) => d.name === "Send",
    check: (d) => eq("frame", d.frame, "iframe") ?? eq("landmarks", d.landmarks, ["form:quick reply"]),
  },
  {
    page: "pages/article.html",
    what: "toc link inside a nav labelled by its heading",
    find: (d) => d.name === "Landing" && d.landmarks.length === 1,
    check: (d) => eq("landmarks", d.landmarks, ["nav:contents"]) ?? eq("heading", d.context.heading, "Contents"),
  },
  {
    page: "pages/article.html",
    what: "Parsoid node id dropped",
    find: (d) => d.name === "Sulphur",
    check: (d) => eq("stable", d.stable, {}),
  },
  {
    page: "pages/article.html",
    what: "reference link in a labelled section",
    find: (d) => d.name.startsWith('"Pragyan rover'),
    check: (d) => eq("landmarks", d.landmarks, ["main", "section:references"]),
  },
];

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dump = args.includes("--dump");
const update = args.includes("--update");
const targets = args.filter((a) => !a.startsWith("--"));

const bundle = readBundle();
// Minified, so found by what it returns rather than by name.
const source = [...bundle.matchAll(/\(\$\{([\w$]+)\.toString\(\)\}\)/g)]
  .map((m) => extractFunction(bundle, m[1]!))
  .find((fn) => fn?.includes("descriptors:") && fn.includes("totalFound:"));
if (!source) {
  console.error("\n  could not find the injected indexer in the bundle\n");
  process.exit(1);
}
const expression = `(${source})(${INDEX_CAP}, ${TEXT_CAP}, ${DESCRIPTOR_CAP})`;

const fixtures = await serveFixturesEphemeral();
const browser = await launchBrowser();
let failed = false;

try {
  const external = targets.filter((t) => /^https?:/.test(t));
  const local = targets.length > 0 ? targets.filter((t) => !/^https?:/.test(t)) : fixtureFiles();

  const totals = { elements: 0, named: 0, landmarked: 0 };

  for (const file of local) {
    const path = relative(FIXTURE_ROOT, file.startsWith("fixtures") ? join(process.cwd(), file) : file)
      .replace(/\\/g, "/");
    const result = await inspect(`${fixtures.origin}/${path}`, true);
    report(path, result);
    totals.elements += result.first.descriptors.length;
    totals.named += result.first.descriptors.filter((d) => d.name).length;
    totals.landmarked += result.first.descriptors.filter((d) => d.landmarks.length).length;
    if (dump) console.log(JSON.stringify(result.first.descriptors, null, 2));
    checkSnapshot(path, result.first);

    const expected = EXPECT.filter((e) => e.page === path);
    for (const exp of expected) {
      const hit = result.first.descriptors.find(exp.find);
      const problem = hit ? exp.check(hit) : "no descriptor matched";
      if (problem) fail(`${path}: ${exp.what} — ${problem}`);
    }
    if (expected.length > 0) console.log(`    ${expected.length} expectations checked`);

    // Repeated controls must stay distinguishable by path, or the matcher's
    // structural signal cannot separate one result card from the next.
    const repeated = new Map<string, Set<string>>();
    for (const d of result.first.descriptors.filter((x) => x.context.item)) {
      const key = `${d.role}|${d.nameNorm}`;
      if (!repeated.has(key)) repeated.set(key, new Set());
      repeated.get(key)!.add(d.pathNorm);
    }
    for (const [key, paths] of repeated) {
      const total = result.first.descriptors.filter(
        (x) => x.context.item && `${x.role}|${x.nameNorm}` === key,
      ).length;
      if (paths.size !== total) fail(`${path}: ${total} × ${key} share ${paths.size} pathNorm(s)`);
    }
  }

  for (const url of external) {
    const result = await inspect(url, false);
    report(url, result);
    if (dump) console.log(JSON.stringify(result.first.descriptors, null, 2));
  }

  if (local.length > 0 && targets.length === 0) {
    const named = totals.named / Math.max(1, totals.elements);
    const landmarked = totals.landmarked / Math.max(1, totals.elements);
    console.log(
      `\n  fixture set: ${totals.elements} descriptors, ` +
        `${pct(named)} named, ${pct(landmarked)} with landmarks`,
    );
    if (named < MIN_NAMED) fail(`accessible names below ${pct(MIN_NAMED)}`);
    if (landmarked < MIN_LANDMARKED) fail(`landmark chains below ${pct(MIN_LANDMARKED)}`);
  }
} finally {
  await browser.close();
  fixtures.close();
}

if (failed) process.exit(1);
console.log("\n  descriptors verified\n");

// ---------------------------------------------------------------------------

interface Inspection {
  first: PageIndex;
  second: PageIndex;
  reloaded: boolean;
}

async function inspect(url: string, reload: boolean): Promise<Inspection> {
  const tab = await browser.open(url, reload ? 150 : 2500);
  try {
    const first = await tab.evaluate();
    if (reload) await tab.reload(150);
    const second = await tab.evaluate();
    return { first, second, reloaded: reload };
  } finally {
    await tab.close();
  }
}

function report(name: string, { first, second, reloaded }: Inspection) {
  const d = first.descriptors;
  const count = (f: (x: ElementDescriptor) => boolean) => d.filter(f).length;
  const share = (n: number) => pct(n / Math.max(1, d.length));

  console.log(
    `\n  ${name}\n` +
      `    ${first.elements.length} shown / ${first.totalFound} found / ${d.length} descriptors\n` +
      `    named ${share(count((x) => Boolean(x.name)))}` +
      `  landmarks ${share(count((x) => x.landmarks.length > 0))}` +
      `  stable ${share(count((x) => Object.keys(x.stable).some((k) => k !== "type")))}` +
      `  heading ${share(count((x) => Boolean(x.context.heading)))}` +
      `  item ${share(count((x) => Boolean(x.context.item)))}\n` +
      `    index ${estimateTokens(serializeIndex(first.elements))} tokens to the model, read in ${first.tookMs}ms`,
  );

  if (d.length !== Math.min(first.totalFound, DESCRIPTOR_CAP)) {
    fail(`${name}: ${d.length} descriptors for ${first.totalFound} candidates`);
  }

  const shown = d.filter((x) => x.i !== null).map((x) => x.i);
  if (JSON.stringify(shown) !== JSON.stringify(first.elements.map((e) => e.i))) {
    fail(`${name}: shown elements and descriptors disagree`);
  }

  for (const e of first.elements) {
    const keys = Object.keys(e).sort().join(",");
    if (keys !== ELEMENT_KEYS) {
      fail(`${name}: element [${e.i}] has keys ${keys} — the model-facing index changed shape`);
      break;
    }
  }

  const same = JSON.stringify(first.descriptors) === JSON.stringify(second.descriptors);
  console.log(`    ${reloaded ? "reload" : "re-read"} ${same ? "byte-identical" : "DIFFERS"}`);
  if (!same && reloaded) {
    const at = first.descriptors.findIndex(
      (x, k) => JSON.stringify(x) !== JSON.stringify(second.descriptors[k]),
    );
    fail(
      `${name}: descriptors changed across a reload at #${at}\n` +
        `      ${JSON.stringify(first.descriptors[at])}\n      ${JSON.stringify(second.descriptors[at])}`,
    );
  }
}

/**
 * The matcher and drift checks run on these files rather than a browser, so a
 * snapshot that no longer matches what the indexer produces is a failure.
 */
function checkSnapshot(path: string, page: PageIndex) {
  const file = snapshotPath(path);
  const fresh =
    JSON.stringify({ url: path, elements: page.elements, descriptors: page.descriptors }, null, 2) + "\n";
  if (update) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, fresh);
    console.log("    snapshot written");
    return;
  }
  // Git may have checked the file out with CRLF.
  if (!existsSync(file) || readFileSync(file, "utf8").replace(/\r\n/g, "\n") !== fresh) {
    fail(`${path}: snapshot is stale — rerun with --update if the indexer change was intended`);
  }
}

function fixtureFiles(): string[] {
  const out: string[] = [];
  for (const dir of ["gauntlet", "pages"]) {
    for (const f of readdirSync(join(FIXTURE_ROOT, dir)).sort()) {
      if (f.endsWith(".html")) out.push(join(FIXTURE_ROOT, dir, f));
    }
  }
  return out;
}

function fail(message: string) {
  failed = true;
  console.error(`\n  FAIL ${message}`);
}

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

// ---- a minimal CDP client over the browser's WebSocket ----

interface Tab {
  evaluate: () => Promise<PageIndex>;
  reload: (settleMs: number) => Promise<void>;
  close: () => Promise<void>;
}

interface Browser {
  open: (url: string, settleMs: number) => Promise<Tab>;
  close: () => Promise<void>;
}

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

async function launchBrowser(): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), "tiny-brow-descriptors-"));
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
      "--window-size=1280,800",
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
      await send("Emulation.setDeviceMetricsOverride", {
        width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
      }, sessionId);
      await send("Page.enable", {}, sessionId);

      const loaded = waitFor(sessionId, "Page.loadEventFired", 30_000);
      await send("Page.navigate", { url }, sessionId);
      await loaded;
      await sleep(settleMs);

      return {
        async evaluate() {
          const { result, exceptionDetails } = await send(
            "Runtime.evaluate",
            { expression, returnByValue: true },
            sessionId,
          );
          if (exceptionDetails) {
            throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
          }
          return result.value as PageIndex;
        },
        async reload(ms) {
          const again = waitFor(sessionId, "Page.loadEventFired", 30_000);
          await send("Page.reload", { ignoreCache: true }, sessionId);
          await again;
          await sleep(ms);
        },
        async close() {
          await send("Target.closeTarget", { targetId }).catch(() => {});
        },
      };
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
