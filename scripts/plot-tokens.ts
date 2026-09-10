/**
 * Plots prompt tokens per step from a scored run.
 *
 * The claim compression makes is that step 30 costs what step 3 cost. That is
 * either true in the numbers or it is not, and a chart of the actual run is the
 * only way to tell — a growing line means a past page state is leaking into the
 * prompt somewhere.
 *
 *   npx tsx scripts/plot-tokens.ts [results.json]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "harness-results";

interface Step {
  n: number;
  usage: { prompt: number; completion: number; cachedPrompt?: number };
}
interface Result {
  taskId: string;
  taskSlug: string;
  verdict: string;
  usage: { prompt: number; completion: number };
  stepLog: Step[];
}

const file = process.argv[2] ?? newest();
if (!file) {
  console.log(
    `\n  Nothing to plot — no scored runs in ${DIR}/.\n\n` +
      "  Score one first:\n" +
      "    npm run fixtures\n" +
      "    npx tsx harness/index.ts --driver bridge --provider <preset>\n\n" +
      "  Or point at a result file directly:\n" +
      "    npm run plot:tokens -- path/to/result.json\n",
  );
  process.exit(0);
}

const run = JSON.parse(readFileSync(file, "utf8")) as {
  backend: { provider: string; model: string };
  results: Result[];
};

console.log(`\n  ${file}`);
console.log(`  ${run.backend.provider} · ${run.backend.model}\n`);

const WIDTH = 44;
let worst = 0;

for (const result of run.results) {
  const steps = result.stepLog.filter((s) => s.usage.prompt > 0);
  if (steps.length < 2) continue;

  const prompts = steps.map((s) => s.usage.prompt);
  const peak = Math.max(...prompts);
  const first = prompts[0] ?? 0;
  const last = prompts.at(-1) ?? 0;
  // Growth per step against the first step, which is what "flat" means here.
  const drift = first > 0 ? (last - first) / first / Math.max(1, steps.length - 1) : 0;
  worst = Math.max(worst, Math.abs(drift));

  console.log(
    `  ${result.taskId} ${result.taskSlug.padEnd(18)} ${String(result.verdict).padEnd(8)}` +
      ` total ${String(result.usage.prompt).padStart(6)}p` +
      `  drift ${(drift * 100 >= 0 ? "+" : "")}${(drift * 100).toFixed(1)}%/step`,
  );

  for (const step of steps) {
    const bar = Math.round((step.usage.prompt / peak) * WIDTH);
    const cached = Math.round(((step.usage.cachedPrompt ?? 0) / peak) * WIDTH);
    console.log(
      `    ${String(step.n).padStart(2)} ${"▓".repeat(Math.min(cached, bar))}` +
        `${"█".repeat(Math.max(0, bar - cached))} ${step.usage.prompt}`,
    );
  }
  console.log();
}

console.log("  ▓ served from the provider's cache   █ paid for\n");

const total = run.results.reduce((n, r) => n + r.usage.prompt + r.usage.completion, 0);
const longest = run.results.reduce(
  (a, b) => (a && a.stepLog.length > b.stepLog.length ? a : b),
  run.results[0],
);
if (!longest) {
  console.log("  this run scored nothing\n");
  process.exit(0);
}
console.log(`  suite total        ${total} tokens`);
console.log(
  `  longest task       ${longest.taskId} — ${longest.stepLog.length} steps, ` +
    `${longest.usage.prompt + longest.usage.completion} tokens`,
);
console.log(`  worst drift        ${(worst * 100).toFixed(1)}% per step\n`);

/** Null rather than a throw: an empty results directory is a normal state. */
function newest(): string | null {
  let files: string[];
  try {
    files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return null;
  }
  const last = files.at(-1);
  return last ? join(DIR, last) : null;
}
