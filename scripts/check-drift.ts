/**
 * Does the matcher survive the page changing underneath it?
 *
 * Each fixture is loaded in headless Chrome, one element is tagged, the page is
 * mutated, and the real indexer reads it again. The tag says which descriptor
 * is truly the target afterwards, so every verdict is scored against the truth:
 *
 *   1 wrappers    2 ids and classes regenerated    3 banner inserted on top
 *   4 label tweaked    5 siblings reordered    6 target deleted    7 target duplicated
 *
 * A wrong match is the one unacceptable answer. Needs `npm run build` and a
 * local Chrome or Edge.
 *
 *   npm run check:drift                          a seeded sample of targets per fixture
 *   npm run check:drift -- --all                 every identifiable element
 *   npm run check:drift -- --all --record        and save the pages for `npm run tune:matcher`
 *   npm run check:drift -- --case pages/shop.html#17#1   one case, every candidate's signals
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { identifyingAttributes, matchElement, type MatchResult, type Signal } from "../src/lib/identity/match";
import {
  DESCRIPTOR_CAP,
  INDEX_CAP,
  TEXT_CAP,
  type ElementDescriptor,
  type PageIndex,
} from "../src/lib/page-index";
import { extractorExpression } from "./lib/bundle";
import { launchBrowser, type Tab } from "./lib/chrome";
import {
  MATCH_RATE_FLOOR,
  MUST_MATCH,
  RECORD_PATH,
  VARIANTS,
  judge,
  type RecordedCase,
  type Truth,
  type Verdict,
} from "./lib/drift";
import { serveFixturesEphemeral } from "./lib/fixture-server";
import { loadSnapshots } from "./lib/snapshots";

const PER_FIXTURE = 8;

interface Case {
  fixture: string;
  k: number;
  variant: number;
  verdict: Verdict;
  outcome: MatchResult["outcome"];
  rung: Signal | null;
  /** Carries a unique test id, id, name attribute or link destination. */
  anchored: boolean;
  target: string;
  detail: string;
}

const args = process.argv.slice(2);
const all = args.includes("--all");
const record = args.includes("--record");
const caseAt = args.indexOf("--case");
const only = caseAt >= 0 ? args[caseAt + 1]!.split("#") : undefined;

const extract = extractorExpression(INDEX_CAP, TEXT_CAP, DESCRIPTOR_CAP);
const mutate = readFileSync(join(process.cwd(), "scripts", "lib", "drift-mutations.js"), "utf8").trim();

const fixtures = await serveFixturesEphemeral();
const browser = await launchBrowser();
const cases: Case[] = [];
const recorded: RecordedCase[] = [];
let skipped = 0;
let failed = false;

try {
  const tab = await browser.open("about:blank", 0);

  for (const snap of loadSnapshots().filter((s) => !only || s.url === only[0])) {
    const url = `${fixtures.origin}/${snap.url}`;
    const source = snap.descriptors;

    await tab.goto(url, 50);
    const fresh = await tab.evaluate<PageIndex>(extract);
    if (JSON.stringify(fresh.descriptors) !== JSON.stringify(source)) {
      fail(`${snap.url}: page no longer matches its snapshot — run \`npm run check:descriptors -- --update\``);
      continue;
    }

    // An element the matcher cannot pick out of the unmodified page says nothing about drift.
    const identifiable = source
      .map((d, k) => ({ d, k }))
      .filter(({ d, k }) => matchElement(d, source, { source }).index === k);
    skipped += source.length - identifiable.length;

    const targets = only
      ? identifiable.filter(({ k }) => k === Number(only[1]))
      : all
        ? identifiable
        : sample(identifiable, PER_FIXTURE, hash(snap.url));

    for (const { d, k } of targets) {
      for (let variant = 1; variant <= 7; variant++) {
        if (only && variant !== Number(only[2])) continue;
        const outcome = await runCase(tab, url, snap.url, source, d, k, variant);
        if (outcome) cases.push(outcome);
      }
    }
  }
  await tab.close();
} finally {
  await browser.close();
  fixtures.close();
}

report();
if (record) {
  mkdirSync(dirname(RECORD_PATH), { recursive: true });
  writeFileSync(RECORD_PATH, JSON.stringify(recorded));
  console.log(`\n  recorded ${recorded.length} cases to ${RECORD_PATH}`);
}
if (failed) process.exit(1);
console.log("\n  drift verified\n");

// ---------------------------------------------------------------------------

async function runCase(
  tab: Tab,
  url: string,
  fixture: string,
  source: ElementDescriptor[],
  target: ElementDescriptor,
  k: number,
  variant: number,
): Promise<Case | null> {
  await tab.goto(url, 30);
  await tab.evaluate(extract);
  await tab.evaluate(`window.__tinyBrow.all[${k}].setAttribute("data-drift-target", "")`);
  const applied = await tab.evaluate<{ applied: boolean; note: string }>(
    `(${mutate})(${variant}, ${hash(`${fixture}#${k}#${variant}`)})`,
  );
  // Reordering an element with no siblings, say, is not a case.
  if (!applied.applied) return null;

  const page = await tab.evaluate<PageIndex>(extract);
  const truth = await tab.evaluate<Truth>(`({
    target: window.__tinyBrow.all.findIndex((el) => el.hasAttribute("data-drift-target")),
    clone: window.__tinyBrow.all.findIndex((el) => el.hasAttribute("data-drift-clone")),
  })`);
  if (record) recorded.push({ fixture, k, variant, truth, descriptors: page.descriptors });

  const result = matchElement(target, page.descriptors, { source });
  if (only) explain(target, k, truth, applied.note, page.descriptors, result);

  const unique = identifyingAttributes(target, source, source);
  const got = result.index === null ? "" : ` → #${result.index} "${page.descriptors[result.index]!.name.slice(0, 32)}"`;
  return {
    fixture,
    k,
    variant,
    verdict: judge(variant, target, truth, result),
    outcome: result.outcome,
    rung: result.rung,
    anchored: unique.testid.length > 0 || unique.id || unique.name || unique.href,
    target: `${target.role} "${target.name.slice(0, 32)}"`,
    detail: `${applied.note}; ${result.outcome} score ${result.score} margin ${result.margin}${got}`,
  };
}

function explain(
  target: ElementDescriptor,
  k: number,
  truth: Truth,
  note: string,
  page: ElementDescriptor[],
  result: MatchResult,
) {
  console.log(`\n  target #${k}: ${JSON.stringify(target)}`);
  console.log(`  truth #${truth.target}${truth.clone >= 0 ? `, clone #${truth.clone}` : ""}; ${note}\n`);
  for (const r of result.ranked.slice(0, 6)) {
    const d = page[r.index]!;
    console.log(
      `  #${r.index} ${r.score} (identity ${r.identity}${r.anchored ? ", anchored" : ""}) ` +
        `${d.role} "${d.name}" item "${d.context.item.slice(0, 40)}" ${d.pathNorm}`,
    );
    console.log(`      ${JSON.stringify(r.signals)}`);
  }
}

function report() {
  const rows = [["variant", "cases", "correct", "wrong", "missed", "lost", "rate"]];
  for (let v = 1; v <= 7; v++) {
    const list = cases.filter((c) => c.variant === v);
    const count = (verdict: Verdict) => list.filter((c) => c.verdict === verdict).length;
    const judged = list.length - count("lost");
    rows.push([
      `${v} ${VARIANTS[v]}`,
      String(list.length),
      String(count("correct")),
      String(count("wrong")),
      String(count("missed")),
      String(count("lost")),
      judged ? pct(count("correct") / judged) : "-",
    ]);
  }

  console.log(
    `\n  ${cases.length} cases over ${new Set(cases.map((c) => c.fixture)).size} fixtures` +
      (skipped ? ` (${skipped} elements skipped: not identifiable unmodified)` : "") +
      "\n",
  );
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  for (const row of rows) console.log("  " + row.map((cell, i) => cell.padEnd(widths[i]! + 2)).join(""));

  const scored = (variants: number[], keep: (c: Case) => boolean = () => true) =>
    cases.filter((c) => variants.includes(c.variant) && c.verdict !== "lost" && keep(c));
  const rate = (list: Case[]) => (list.length ? list.filter((c) => c.verdict === "correct").length / list.length : 1);
  const main = scored(MUST_MATCH);
  const label = scored([4], (c) => c.anchored);
  const wrong = cases.filter((c) => c.verdict === "wrong");

  const rungs = new Map<string, number>();
  for (const c of cases) {
    if (c.verdict === "correct" && c.outcome === "matched") rungs.set(c.rung ?? "none", (rungs.get(c.rung ?? "none") ?? 0) + 1);
  }

  console.log(`\n  match rate, variants 1–3 and 5: ${pct(rate(main))}`);
  console.log(`  label tweaks on anchored elements: ${pct(rate(label))} of ${label.length}`);
  console.log(`  wrong matches: ${wrong.length}`);
  console.log("  rungs: " + [...rungs].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(", "));

  const misses = main.filter((c) => c.verdict === "missed");
  if (misses.length) {
    console.log("\n  misses on variants 1–3 and 5:");
    for (const c of misses.slice(0, 15)) console.log(`    ${c.fixture} #${c.k} ${c.target}, ${VARIANTS[c.variant]}: ${c.detail}`);
  }

  for (const c of wrong) {
    fail(`wrong match — ${c.fixture} #${c.k} ${c.target}, ${VARIANTS[c.variant]}: ${c.detail}`);
  }
  if (only) return;
  if (rate(main) < MATCH_RATE_FLOOR) fail(`match rate ${pct(rate(main))} is below ${pct(MATCH_RATE_FLOOR)}`);
  if (label.length && rate(label) < MATCH_RATE_FLOOR) {
    fail(`label tweaks on anchored elements matched ${pct(rate(label))}, below ${pct(MATCH_RATE_FLOOR)}`);
  }
}

function sample<T>(list: T[], n: number, seed: number): T[] {
  if (list.length <= n) return list;
  let state = seed >>> 0;
  const rand = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
  return list
    .map((item) => ({ item, key: rand() }))
    .sort((a, b) => a.key - b.key)
    .slice(0, n)
    .map((x) => x.item);
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function fail(message: string) {
  failed = true;
  console.error(`\n  FAIL ${message}`);
}

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}
