/**
 * Slots must follow elements, not numbers.
 *
 * Against the fixture snapshots, with no browser: a re-render keeps every slot,
 * a banner inserted above shifts every number but no slot, a removed element
 * takes only its own slot with it, a badge count changing keeps the slot, and
 * navigating away starts over. Then in headless Chrome each fixture's DOM is
 * rebuilt from its own markup — every node replaced — and read again.
 *
 *   npm run check:slots
 *   npm run check:slots -- https://en.wikipedia.org/wiki/Chandrayaan-3   time a re-read of a real page
 */

import { SlotTracker, slotOfIndex } from "../src/lib/identity/slots";
import { DESCRIPTOR_CAP, INDEX_CAP, TEXT_CAP, type ElementDescriptor, type PageIndex } from "../src/lib/page-index";
import { extractorExpression } from "./lib/bundle";
import { launchBrowser } from "./lib/chrome";
import { serveFixturesEphemeral } from "./lib/fixture-server";
import { loadSnapshots } from "./lib/snapshots";

const failures: string[] = [];
let cases = 0;

function expect(name: string, ok: boolean, detail = "") {
  cases++;
  if (!ok) failures.push(`${name}${detail ? `\n      ${detail}` : ""}`);
}

const pageOf = (url: string, descriptors: ElementDescriptor[]): PageIndex => ({
  url,
  title: "",
  elements: [],
  descriptors,
  totalFound: descriptors.length,
  viewport: { w: 1280, h: 800, scrollX: 0, scrollY: 0, docH: 2000 },
  text: "",
  textChars: 0,
  tookMs: 0,
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ---- snapshots, no browser ----

for (const snap of loadSnapshots()) {
  const url = `http://fixture.test/${snap.url}`;
  const base = snap.descriptors;

  {
    const tracker = new SlotTracker();
    const before = tracker.observe(pageOf(url, base));
    const after = tracker.observe(pageOf(url, clone(base)));
    expect(`${snap.url}: a re-render keeps every slot`, before.join() === after.join());
    expect(`${snap.url}: slots are distinct`, new Set(before).size === before.length);
  }

  {
    const tracker = new SlotTracker();
    const before = tracker.observe(pageOf(url, base));
    const banner: ElementDescriptor = {
      ...clone(base[0]!),
      i: 0,
      tag: "a",
      role: "link",
      name: "Shop the sale",
      nameNorm: "shop the sale",
      stable: {},
      landmarks: [],
      href: "/sale",
      pathNorm: "div>a",
      context: { heading: "", headingNorm: "", item: "", itemNorm: "" },
    };
    const shifted = [banner, ...clone(base).map((d) => ({ ...d, i: d.i === null ? null : d.i + 1 }))];
    const after = tracker.observe(pageOf(url, shifted));
    expect(
      `${snap.url}: an element inserted above shifts numbers, not slots`,
      after.slice(1).join() === before.join() && !before.includes(after[0]!),
      `before ${before.join()} after ${after.join()}`,
    );
  }

  if (base.length > 1) {
    const tracker = new SlotTracker();
    const before = tracker.observe(pageOf(url, base));
    const gone = Math.floor(base.length / 2);
    const after = tracker.observe(pageOf(url, clone(base).filter((_, k) => k !== gone)));
    expect(
      `${snap.url}: removing one element takes only its slot`,
      after.join() === before.filter((_, k) => k !== gone).join(),
    );
  }

  {
    const tracker = new SlotTracker();
    const before = tracker.observe(pageOf(url, base));
    const after = tracker.observe(pageOf(`http://fixture.test/elsewhere`, clone(base)));
    expect(`${snap.url}: navigating starts over`, after.every((s) => !before.includes(s)));
  }
}

{
  const shop = loadSnapshots().find((s) => s.url === "pages/shop.html")!;
  const url = "http://fixture.test/pages/shop.html";
  const tracker = new SlotTracker();
  const page = pageOf(url, shop.descriptors);
  const before = tracker.observe(page);
  const cart = shop.descriptors.findIndex((d) => d.name === "Cart (3)");
  const bumped = clone(shop.descriptors);
  bumped[cart] = { ...bumped[cart]!, name: "Cart (4)" };
  const after = tracker.observe(pageOf(url, bumped));
  expect("a badge count changing keeps the slot", after[cart] === before[cart], `${before[cart]} → ${after[cart]}`);
  expect(
    "the model's number resolves to its slot",
    slotOfIndex(page, before, shop.descriptors[cart]!.i) === before[cart],
  );
}

// ---- a real re-render, in Chrome ----

const extract = extractorExpression(INDEX_CAP, TEXT_CAP, DESCRIPTOR_CAP);
const urls = process.argv.slice(2).filter((a) => /^https?:/.test(a));
const fixtures = await serveFixturesEphemeral();
const browser = await launchBrowser();

try {
  const tab = await browser.open("about:blank", 0);

  for (const snap of urls.length ? [] : loadSnapshots()) {
    await tab.goto(`${fixtures.origin}/${snap.url}`, 50);
    const before = await tab.evaluate<PageIndex>(extract);
    // Every node is thrown away and rebuilt from the same markup, as a framework re-render would.
    await tab.evaluate(`(() => {
      const html = document.body.innerHTML;
      document.body.innerHTML = html;
    })()`);
    await new Promise((r) => setTimeout(r, 100));
    const after = await tab.evaluate<PageIndex>(extract);

    const tracker = new SlotTracker();
    const a = tracker.observe(before);
    const b = tracker.observe(after);
    const kept = a.filter((s) => b.includes(s)).length;
    expect(
      `${snap.url}: slots survive a real re-render`,
      kept === Math.min(a.length, b.length),
      `${kept} of ${a.length} kept (${after.descriptors.length} after)`,
    );
    console.log(`  ${snap.url.padEnd(22)} re-render: ${kept}/${a.length} slots kept`);
  }

  for (const url of urls) {
    await tab.goto(url, 2500);
    const before = await tab.evaluate<PageIndex>(extract);
    await tab.reload(2500);
    const after = await tab.evaluate<PageIndex>(extract);
    const tracker = new SlotTracker();
    const a = tracker.observe(before);
    const started = performance.now();
    const b = tracker.observe(after);
    const ms = Math.round(performance.now() - started);
    const kept = a.filter((s) => b.includes(s)).length;
    console.log(`  ${url}\n    reload: ${kept}/${a.length} slots kept, tracked in ${ms}ms`);
  }
  await tab.close();
} finally {
  await browser.close();
  fixtures.close();
}

console.log(`\n  ${cases} cases`);
if (failures.length) {
  console.error(`\n  ${failures.length} failed:\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("\n  slots verified\n");
