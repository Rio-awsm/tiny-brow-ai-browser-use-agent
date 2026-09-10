/**
 * Harness CLI.
 *
 *   npm run harness                      # stub driver, everything errors
 *   npm run harness -- --driver oracle   # canned answers, proves the scorer
 *   npm run harness -- --task T02 -n 3
 *   npm run harness -- --provider lmstudio --model gemma-4-e4b-it
 *   npm run harness -- --verify-tasks    # tasks.md vs the registry
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { redact, resolveBackend, validateBackend } from "./config.js";
import { makeDriver, DRIVERS } from "./driver.js";
import { buildMatrix, loadRuns, renderMatrix } from "./compare.js";
import { persist, renderAttempts, renderReport } from "./report.js";
import { runSuite } from "./runner.js";
import { TASKS, taskById } from "./tasks.js";
import type { AttemptResult } from "./types.js";

const { values, positionals } = parseArgs({
  options: {
    driver: { type: "string", default: "stub" },
    provider: { type: "string" },
    "base-url": { type: "string" },
    model: { type: "string" },
    task: { type: "string", multiple: true },
    tier: { type: "string" },
    attempts: { type: "string", short: "n", default: "1" },
    "step-cap": { type: "string", default: "40" },
    timeout: { type: "string", default: "300" },
    port: { type: "string" },
    authed: { type: "boolean", default: false },
    verbose: { type: "boolean", short: "v", default: false },
    "no-save": { type: "boolean", default: false },
    "verify-tasks": { type: "boolean", default: false },
    compare: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  // Tolerated so the situation below can be explained rather than crashing
  // with a raw Node stack trace.
  allowPositionals: true,
});

if (positionals.length > 0) {
  // npm on Windows consumes `--provider`/`--model` as its own config and passes
  // only the bare values through, so the flag names never reach us. No form of
  // quoting or `--` gets around it; running the script directly does.
  const guessed = positionals.join(" ");
  console.error("");
  console.error(`  Unexpected arguments: ${guessed}`);
  console.error("");
  console.error("  npm swallowed the flag names before they reached the harness.");
  console.error("  This is npm's behaviour on Windows and quoting does not help.");
  console.error("");
  console.error("  Run the script directly instead:");
  console.error("");
  console.error(`    npx tsx harness/index.ts --driver bridge ${flagsFor(positionals)}`);
  console.error("");
  process.exit(1);
}

/** Best-effort reconstruction of what the user meant, for the hint above. */
function flagsFor(values: string[]): string {
  const [first, second] = values;
  if (first && second) return `--provider ${first} --model ${second}`;
  if (first) return `--provider ${first} --model <model>`;
  return "--provider <preset> --model <model>";
}

if (values.help) {
  console.log(helpText());
  process.exit(0);
}

if (values["verify-tasks"]) {
  process.exit(verifyTasks() ? 0 : 1);
}

if (values.compare) {
  const runs = loadRuns();
  console.log(renderMatrix(buildMatrix(runs)));
  process.exit(runs.length ? 0 : 1);
}

const backend = resolveBackend({
  provider: values.provider,
  baseUrl: values["base-url"],
  model: values.model,
});

const problems = validateBackend(backend);
const needsBackend = values.driver !== "stub" && values.driver !== "oracle";

if (problems.length) {
  const label = needsBackend ? "ERROR" : "note";
  console.log(`\n  ${label}: backend not fully configured`);
  for (const p of problems) console.log(`    ${p.field}: ${p.message}`);
  if (needsBackend) {
    console.log(`\n  driver "${values.driver}" needs a working backend. Fix .env and retry.\n`);
    process.exit(1);
  }
  const r = redact(backend);
  console.log(`    (driver "${values.driver}" does not call a model, continuing — key: ${r.apiKey})`);
}

let tasks = TASKS;
if (values.task?.length) {
  tasks = values.task.map((id) => {
    const t = taskById(id);
    if (!t) {
      console.error(`unknown task "${id}" — known: ${TASKS.map((x) => x.id).join(", ")}`);
      process.exit(1);
    }
    return t;
  });
}
if (values.tier) {
  tasks = tasks.filter((t) => t.tier === values.tier);
  if (!tasks.length) {
    console.error(`no tasks in tier "${values.tier}"`);
    process.exit(1);
  }
}

const driver = makeDriver(values.driver!);
const attempts = Number(values.attempts);
const stepCap = Number(values["step-cap"]);
const timeoutMs = Number(values.timeout) * 1000;

if (!Number.isFinite(attempts) || attempts < 1) {
  console.error("--attempts must be a positive integer");
  process.exit(1);
}

const line = (r: AttemptResult) => {
  const v = r.verdict.toUpperCase().padEnd(7);
  const note = r.error ?? r.failure ?? "";
  console.log(`  ${v} ${r.taskId} ${r.taskSlug} (#${r.attempt})${note ? `  ${note}` : ""}`);
};

// Printed before anything runs, not only in the closing report: the most
// common mistake is losing flags to npm (they need `--` first) and silently
// scoring the backend in .env instead of the one you meant.
for (const line of [
  "",
  `  driver    ${driver.name}`,
  `  backend   ${backend.provider}  ${backend.model || "(no model)"}`,
  `  endpoint  ${backend.baseUrl || "(no base url)"}`,
  `  key       ${redact(backend).apiKey}`,
  `  tasks     ${tasks.map((t) => t.id).join(", ")}  x${attempts}`,
  "",
]) {
  console.log(line);
}

const run = await runSuite({
  tasks,
  backend,
  driver,
  attempts,
  stepCap,
  timeoutMs,
  authed: values.authed!,
  onAttempt: values.verbose ? line : undefined,
});

console.log(renderReport(run));
if (values.verbose) console.log(renderAttempts(run) + "\n");

if (!values["no-save"]) {
  console.log(`  saved     ${persist(run)}\n`);
}

/**
 * Guards against the prose spec and the executable registry drifting apart.
 * They will, because they are edited at different times for different reasons.
 */
function verifyTasks(): boolean {
  const md = readFileSync("tasks.md", "utf8");
  const heads = [...md.matchAll(/^##\s+(T\d{2})\s+—\s+([a-z0-9-]+)\s+·\s+(\w+)/gm)].map(
    (m) => ({ id: m[1], slug: m[2], tier: m[3].toLowerCase() }),
  );
  // The prompt line, unwrapped: markdown hard-wraps but the registry does not.
  const prompts = new Map<string, string>();
  for (const m of md.matchAll(/^##\s+(T\d{2})[\s\S]*?\*\*Prompt:\*\*\s+`([^`]+)`/gm)) {
    prompts.set(m[1], m[2].replace(/\s+/g, " ").trim());
  }

  const errs: string[] = [];
  if (heads.length !== TASKS.length) {
    errs.push(`tasks.md has ${heads.length} tasks, registry has ${TASKS.length}`);
  }
  for (const t of TASKS) {
    const h = heads.find((x) => x.id === t.id);
    if (!h) {
      errs.push(`${t.id} is in the registry but has no section in tasks.md`);
      continue;
    }
    if (h.slug !== t.slug) errs.push(`${t.id} slug: tasks.md "${h.slug}" vs registry "${t.slug}"`);
    if (h.tier !== t.tier) errs.push(`${t.id} tier: tasks.md "${h.tier}" vs registry "${t.tier}"`);
    const p = prompts.get(t.id);
    if (p === undefined) {
      errs.push(`${t.id} has no **Prompt:** line in tasks.md`);
    } else if (p !== t.prompt.replace(/\s+/g, " ").trim()) {
      errs.push(`${t.id} prompt differs:\n      md:  ${p}\n      reg: ${t.prompt}`);
    }
    if (t.scoring === "auto" && !t.check) {
      errs.push(`${t.id} is scoring:"auto" but has no check predicate`);
    }
    if (t.scoring === "manual" && t.check) {
      errs.push(`${t.id} is scoring:"manual" but defines a check predicate`);
    }
  }
  for (const h of heads) {
    if (!TASKS.some((t) => t.id === h.id)) {
      errs.push(`${h.id} is in tasks.md but not in the registry`);
    }
  }

  if (errs.length) {
    console.log("\n  tasks.md and harness/tasks.ts disagree:\n");
    for (const e of errs) console.log(`    ${e}`);
    console.log("");
    return false;
  }
  console.log(`\n  ok — ${TASKS.length} tasks, tasks.md and the registry agree\n`);
  return true;
}

function helpText(): string {
  return `
tiny-brow scoring harness

  npm run harness -- [options]

  --driver <name>     ${Object.keys(DRIVERS).join(" | ")}   (default: stub)
                      "bridge" runs the real agent in your browser
  --provider <name>   preset: groq | openrouter | google | litellm | lmstudio | custom
  --base-url <url>    override the preset base URL
  --model <name>      override the model
  --task <id>         run one task; repeatable (T01 or page-title)
  --tier <tier>       trivial | easy | medium | hard | recovery
  -n, --attempts <n>  attempts per task (default 1)
  --step-cap <n>      max agent steps per attempt (default 40)
  --timeout <s>       per-attempt wall-clock ceiling (default 300)
  --port <n>          bridge port (default 8787)
  --authed            the browser profile is signed in; run requiresAuth tasks
  -v, --verbose       per-attempt lines and a detail table
  --no-save           do not write a JSON result file
  --verify-tasks      check tasks.md against the registry, then exit
  --compare           build the provider matrix from harness-results/, then exit
  -h, --help
`;
}
