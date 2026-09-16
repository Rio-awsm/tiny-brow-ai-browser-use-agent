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

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
import { extractorExpression } from "./lib/bundle";
import { launchBrowser } from "./lib/chrome";
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
    what: "href loses tracking params, the /ref= segment, the origin and an off-page fragment",
    find: (d) => d.name === "Logitech M235 Wireless Mouse, 1000 DPI",
    check: (d) => eq("href", d.href, "/dp/B07W4DHNBS?keywords=wireless+mouse"),
  },
  {
    page: "pages/shop.html",
    what: "an in-page link keeps its fragment",
    find: (d) => d.name === "Dell MS116 Optical Wired Mouse",
    check: (d) => eq("href", d.href, "/pages/shop.html#p2"),
  },
  {
    page: "pages/shop.html",
    what: "a styled control inside a focusable scroll region is still a control",
    find: (d) => d.name === "See more results",
    check: (d) => eq("tag", d.tag, "span"),
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
    what: "a citation is one link, named by its whole text",
    find: (d) => d.name === "[1]",
    check: (d) => eq("tag", d.tag, "a") ?? eq("href", d.href, "/pages/article.html#ref1"),
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

const expression = extractorExpression(INDEX_CAP, TEXT_CAP, DESCRIPTOR_CAP);

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
    // Text inside a link inherits its pointer cursor; it must not become a control of its own.
    const inherited = result.first.descriptors.filter((d) => d.tag === "span" && /^[[\]]$/.test(d.name));
    if (inherited.length > 0) fail(`${path}: ${inherited.length} citation brackets indexed as controls`);

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
    const first = await tab.evaluate<PageIndex>(expression);
    if (reload) await tab.reload(150);
    const second = await tab.evaluate<PageIndex>(expression);
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
