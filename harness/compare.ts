/**
 * The provider matrix.
 *
 * With BYOK you are never scoring one system, you are scoring a family of them,
 * so the useful artefact is not a number per task — it is the *gap* between
 * backends on the same task, and the named failure mode behind each gap. A task
 * that passes on one backend and fails on another is telling you something
 * specific about that model.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AttemptResult, FailureMode, SuiteRun } from "./types.js";

export interface BackendColumn {
  key: string;
  provider: string;
  model: string;
  runs: number;
  startedAt: string;
}

export interface CellSummary {
  pass: number;
  scoreable: number;
  manual: number;
  skipped: number;
  failures: FailureMode[];
  avgSteps: number;
  avgTotalMs: number;
  avgRequestMs: number;
  avgPrefillMs: number;
  avgGenerationMs: number;
  avgPromptTokens: number;
  avgCompletionTokens: number;
}

export interface Matrix {
  backends: BackendColumn[];
  /** taskId -> backend key -> summary */
  cells: Map<string, Map<string, CellSummary>>;
  taskIds: string[];
  slugs: Map<string, string>;
}

export function loadRuns(dir = "harness-results"): SuiteRun[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf8")) as SuiteRun;
      } catch {
        return null;
      }
    })
    .filter((r): r is SuiteRun => r !== null && Array.isArray(r.results));
}

const keyOf = (provider: string, model: string) => `${provider}/${model}`;

export function buildMatrix(runs: SuiteRun[]): Matrix {
  const backends = new Map<string, BackendColumn>();
  const cells = new Map<string, Map<string, AttemptResult[]>>();
  const slugs = new Map<string, string>();

  for (const run of runs) {
    for (const result of run.results) {
      const key = keyOf(result.provider, result.model);

      const column = backends.get(key);
      if (!column) {
        backends.set(key, {
          key,
          provider: result.provider,
          model: result.model,
          runs: 1,
          startedAt: run.startedAt,
        });
      } else if (run.startedAt > column.startedAt) {
        column.startedAt = run.startedAt;
      }

      slugs.set(result.taskId, result.taskSlug);
      const row = cells.get(result.taskId) ?? new Map<string, AttemptResult[]>();
      row.set(key, [...(row.get(key) ?? []), result]);
      cells.set(result.taskId, row);
    }
  }

  const summarised = new Map<string, Map<string, CellSummary>>();
  for (const [taskId, row] of cells) {
    const out = new Map<string, CellSummary>();
    for (const [key, results] of row) out.set(key, summarise(results));
    summarised.set(taskId, out);
  }

  return {
    backends: [...backends.values()].sort((a, b) => a.key.localeCompare(b.key)),
    cells: summarised,
    taskIds: [...summarised.keys()].sort(),
    slugs,
  };
}

function summarise(results: AttemptResult[]): CellSummary {
  const mean = (f: (r: AttemptResult) => number) =>
    results.length ? results.reduce((n, r) => n + f(r), 0) / results.length : 0;

  const manual = results.filter((r) => r.verdict === "manual").length;
  const skipped = results.filter((r) => r.verdict === "skipped").length;

  return {
    pass: results.filter((r) => r.verdict === "pass").length,
    scoreable: results.length - manual - skipped,
    manual,
    skipped,
    failures: [...new Set(results.map((r) => r.failure).filter(Boolean))] as FailureMode[],
    avgSteps: mean((r) => r.steps),
    avgTotalMs: mean((r) => r.timing.totalMs),
    avgRequestMs: mean((r) => r.timing.requestMs),
    avgPrefillMs: mean((r) => r.timing.prefillMs ?? 0),
    avgGenerationMs: mean((r) => r.timing.generationMs ?? 0),
    avgPromptTokens: mean((r) => r.usage.prompt),
    avgCompletionTokens: mean((r) => r.usage.completion),
  };
}

export function renderMatrix(matrix: Matrix): string {
  if (matrix.backends.length === 0) {
    return "\n  no results yet — run the suite first\n";
  }

  const lines: string[] = ["", "  BACKENDS", ""];
  matrix.backends.forEach((b, i) => {
    lines.push(`  ${String.fromCharCode(65 + i)}  ${b.provider}  ${b.model}`);
  });

  const header = ["TASK", "SLUG", ...matrix.backends.map((_, i) => String.fromCharCode(65 + i))];
  const rows: string[][] = [header];

  for (const taskId of matrix.taskIds) {
    const row = [taskId, matrix.slugs.get(taskId) ?? ""];
    for (const backend of matrix.backends) {
      row.push(cellText(matrix.cells.get(taskId)?.get(backend.key)));
    }
    rows.push(row);
  }

  lines.push("", "  PASS RATE", "");
  lines.push(table(rows));

  // The gap is the artefact, so it gets called out rather than left to be
  // spotted by eye across two columns.
  const gaps = findGaps(matrix);
  lines.push("", "  WHERE BACKENDS DISAGREE", "");
  if (gaps.length === 0) {
    lines.push("    none — every backend behaves the same on every scored task");
  } else {
    for (const gap of gaps) lines.push(`    ${gap}`);
  }

  lines.push("", "  STEP LATENCY, ms", "");
  const latency: string[][] = [["BACKEND", "STEPS", "TOTAL", "REQUEST", "PREFILL", "GEN", "BROWSER", "P.TOK", "C.TOK"]];
  for (const backend of matrix.backends) {
    const all = [...matrix.cells.values()]
      .map((row) => row.get(backend.key))
      .filter((c): c is CellSummary => c !== undefined);

    const avg = (f: (c: CellSummary) => number) =>
      all.length ? all.reduce((n, c) => n + f(c), 0) / all.length : 0;

    const steps = avg((c) => c.avgSteps);
    const total = avg((c) => c.avgTotalMs);
    const request = avg((c) => c.avgRequestMs);

    latency.push([
      `${backend.provider}/${backend.model}`,
      steps.toFixed(1),
      perStep(total, steps),
      perStep(request, steps),
      perStep(avg((c) => c.avgPrefillMs), steps),
      perStep(avg((c) => c.avgGenerationMs), steps),
      perStep(Math.max(0, total - request), steps),
      perStep(avg((c) => c.avgPromptTokens), steps),
      perStep(avg((c) => c.avgCompletionTokens), steps),
    ]);
  }
  lines.push(table(latency));
  lines.push("", "  Latency is per step. Prefill and generation are only filled in by");
  lines.push("  providers that report them; a dash means the provider said nothing.", "");

  return lines.join("\n");
}

function cellText(cell: CellSummary | undefined): string {
  if (!cell) return "·";
  if (cell.scoreable === 0) return cell.manual > 0 ? "man" : "skip";
  const rate = Math.round((cell.pass / cell.scoreable) * 100);
  const mark = rate === 100 ? "PASS" : rate === 0 ? "fail" : `${rate}%`;
  return cell.failures.length && rate < 100 ? `${mark} ${cell.failures[0]}` : mark;
}

function findGaps(matrix: Matrix): string[] {
  const gaps: string[] = [];

  for (const taskId of matrix.taskIds) {
    const row = matrix.cells.get(taskId);
    if (!row) continue;

    const scored = matrix.backends
      .map((b) => ({ backend: b, cell: row.get(b.key) }))
      .filter((x): x is { backend: BackendColumn; cell: CellSummary } =>
        x.cell !== undefined && x.cell.scoreable > 0);

    if (scored.length < 2) continue;

    const rates = scored.map((x) => x.cell.pass / x.cell.scoreable);
    if (Math.max(...rates) - Math.min(...rates) < 0.5) continue;

    const winners = scored.filter((x) => x.cell.pass / x.cell.scoreable >= 0.5);
    const losers = scored.filter((x) => x.cell.pass / x.cell.scoreable < 0.5);

    gaps.push(
      `${taskId} ${matrix.slugs.get(taskId)}: ` +
        `passes on ${winners.map((w) => w.backend.model).join(", ")}; ` +
        `fails on ${losers
          .map((l) => `${l.backend.model} (${l.cell.failures.join(", ") || "no mode recorded"})`)
          .join(", ")}`,
    );
  }
  return gaps;
}

const perStep = (total: number, steps: number) =>
  steps > 0 && total > 0 ? String(Math.round(total / steps)) : "—";

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  const line = (r: string[]) =>
    "    " + r.map((cell, c) => (cell ?? "").padEnd(widths[c]!)).join("  ").trimEnd();

  return [
    line(rows[0]!),
    "    " + widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.slice(1).map(line),
  ].join("\n");
}
