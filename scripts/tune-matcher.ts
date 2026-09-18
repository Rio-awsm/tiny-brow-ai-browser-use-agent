/**
 * Tunes the matcher against recorded drift, not intuition.
 *
 * Replays every case saved by `npm run check:drift -- --all --record` under a
 * range of settings, one parameter at a time from the current defaults, and
 * also re-runs the snapshot sweep from check:matcher. A setting is only worth
 * taking if it adds correct answers with zero wrong ones in both.
 *
 *   npm run tune:matcher
 */

import { existsSync, readFileSync } from "node:fs";
import {
  DEFAULT_TUNING,
  DEFAULT_WEIGHTS,
  matchElement,
  identifyingAttributes,
  type MatchTuning,
  type MatchWeights,
} from "../src/lib/identity/match";
import type { ElementDescriptor } from "../src/lib/page-index";
import { MUST_MATCH, RECORD_PATH, judge, type RecordedCase } from "./lib/drift";
import { loadSnapshots } from "./lib/snapshots";

if (!existsSync(RECORD_PATH)) {
  console.error("\n  nothing recorded — run `npm run check:drift -- --all --record` first\n");
  process.exit(1);
}

const recorded = JSON.parse(readFileSync(RECORD_PATH, "utf8")) as RecordedCase[];
const sources = new Map(loadSnapshots().map((s) => [s.url, s.descriptors]));

interface Score {
  wrong: number;
  /** Unmodified not matched, deleted matched, or duplicated resolved wrongly, across snapshots. */
  sweepFailures: number;
  main: number;
  label: number;
  anchoredLabel: number;
}

function score(tuning: MatchTuning): Score {
  const s: Score = { wrong: 0, sweepFailures: 0, main: 0, label: 0, anchoredLabel: 0 };
  for (const c of recorded) {
    const source = sources.get(c.fixture)!;
    const target = source[c.k]!;
    const verdict = judge(c.variant, target, c.truth, matchElement(target, c.descriptors, { source, tuning }));
    if (verdict === "wrong") s.wrong++;
    if (verdict !== "correct") continue;
    if (MUST_MATCH.includes(c.variant)) s.main++;
    if (c.variant === 4) {
      s.label++;
      const u = identifyingAttributes(target, source, source);
      if (u.testid.length || u.id || u.name || u.href) s.anchoredLabel++;
    }
  }

  for (const source of sources.values()) {
    source.forEach((target: ElementDescriptor, k: number) => {
      if (matchElement(target, source, { source, tuning }).index !== k) s.sweepFailures++;
      const deleted = source.filter((_, i) => i !== k);
      if (matchElement(target, deleted, { source, tuning }).outcome === "matched") s.sweepFailures++;
    });
  }
  return s;
}

const base = score(DEFAULT_TUNING);
const line = (label: string, s: Score) =>
  `  ${label.padEnd(34)} wrong ${String(s.wrong).padStart(2)}  sweep ${String(s.sweepFailures).padStart(3)}` +
  `  must-match ${String(s.main).padStart(3)}  label ${String(s.label).padStart(3)} (anchored ${s.anchoredLabel})`;

console.log(`\n  ${recorded.length} recorded cases, ${sources.size} snapshots\n`);
console.log(line("current defaults", base));
console.log();

const knobs: [keyof Omit<MatchTuning, "weights">, number[]][] = [
  ["threshold", [30, 40, 50, 60, 70]],
  ["identityFloor", [10, 20, 30, 40, 50]],
  ["margin", [0, 5, 10, 15, 20]],
  ["nameFuzzyFloor", [0.3, 0.4, 0.5, 0.6, 0.7]],
  ["nameConflictBelow", [0.2, 0.3, 0.4, 0.5, 0.6]],
  ["itemMatchAt", [0.7, 0.8, 0.85, 0.9, 0.95]],
  ["itemConflictBelow", [0.5, 0.6, 0.7, 0.75, 0.8]],
  ["geometryWithin", [0.05, 0.1, 0.15, 0.25]],
];

const better: string[] = [];
const report = (label: string, s: Score) => {
  const differs =
    s.wrong !== base.wrong || s.sweepFailures !== base.sweepFailures || s.main !== base.main || s.label !== base.label;
  if (!differs) return;
  console.log(line(label, s));
  const safe = s.wrong === 0 && s.sweepFailures === 0;
  if (safe && s.main + s.label > base.main + base.label) better.push(label);
};

for (const [knob, values] of knobs) {
  for (const value of values) {
    if (value === DEFAULT_TUNING[knob]) continue;
    report(`${knob} ${value}`, score({ ...DEFAULT_TUNING, [knob]: value }));
  }
}

for (const weight of Object.keys(DEFAULT_WEIGHTS) as (keyof MatchWeights)[]) {
  for (const factor of [0, 0.5, 1.5, 2]) {
    const value = Math.round(DEFAULT_WEIGHTS[weight] * factor * 100) / 100;
    report(
      `weight ${weight} ${value}`,
      score({ ...DEFAULT_TUNING, weights: { ...DEFAULT_WEIGHTS, [weight]: value } }),
    );
  }
}

console.log(
  better.length
    ? `\n  safe improvements: ${better.join(", ")}\n`
    : "\n  no single change adds correct answers without a wrong one\n",
);
