/**
 * Reporting. Two outputs from every run:
 *
 *  - a console table, for the person watching;
 *  - a JSON file per run, for the matrix. M10 compares backends, which means
 *    comparing runs that happened hours apart, so every run must persist
 *    itself with the backend baked into the filename and the payload.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttemptResult, FailureMode, SuiteRun, Verdict } from "./types.js";

const MARK: Record<Verdict, string> = {
  pass: "PASS",
  fail: "FAIL",
  error: "ERR ",
  skipped: "SKIP",
  manual: "MAN ",
};

/** Fixed-width columns; no dependency, and it stays aligned in a CI log. */
function table(rows: string[][], align: ("l" | "r")[]): string {
  const widths = rows[0].map((_, c) =>
    Math.max(...rows.map((r) => visibleLength(r[c] ?? ""))),
  );
  const line = (r: string[]) =>
    r
      .map((cell, c) => {
        const pad = " ".repeat(widths[c] - visibleLength(cell));
        return align[c] === "r" ? pad + cell : cell + pad;
      })
      .join("  ")
      .trimEnd();

  const out = [line(rows[0]), widths.map((w) => "-".repeat(w)).join("  ")];
  for (const r of rows.slice(1)) out.push(line(r));
  return out.join("\n");
}

// The rupee sign and box characters are single-width; nothing here is
// double-width, so string length is the honest measure.
const visibleLength = (s: string) => [...s].length;

interface TaskSummary {
  taskId: string;
  slug: string;
  tier: string;
  pass: number;
  fail: number;
  error: number;
  skipped: number;
  manual: number;
  attempts: number;
  avgSteps: number;
  avgTotalMs: number;
  avgRequestMs: number;
  avgPromptTokens: number;
  avgCompletionTokens: number;
  failures: FailureMode[];
}

function summarise(run: SuiteRun): TaskSummary[] {
  const byTask = new Map<string, AttemptResult[]>();
  for (const r of run.results) {
    const list = byTask.get(r.taskId) ?? [];
    list.push(r);
    byTask.set(r.taskId, list);
  }

  return [...byTask.entries()].map(([taskId, rs]) => {
    const count = (v: Verdict) => rs.filter((r) => r.verdict === v).length;
    const mean = (f: (r: AttemptResult) => number) =>
      rs.length ? rs.reduce((n, r) => n + f(r), 0) / rs.length : 0;

    return {
      taskId,
      slug: rs[0].taskSlug,
      tier: rs[0].tier,
      pass: count("pass"),
      fail: count("fail"),
      error: count("error"),
      skipped: count("skipped"),
      manual: count("manual"),
      attempts: rs.length,
      avgSteps: mean((r) => r.steps),
      avgTotalMs: mean((r) => r.timing.totalMs),
      avgRequestMs: mean((r) => r.timing.requestMs),
      avgPromptTokens: mean((r) => r.usage.prompt),
      avgCompletionTokens: mean((r) => r.usage.completion),
      failures: [...new Set(rs.map((r) => r.failure).filter(Boolean))] as FailureMode[],
    };
  });
}

export function renderReport(run: SuiteRun): string {
  const s = summarise(run);
  const n1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
  const n0 = (x: number) => String(Math.round(x));

  const rows: string[][] = [
    ["TASK", "SLUG", "TIER", "PASS", "RATE", "STEPS", "TOTAL ms", "REQ ms", "P.TOK", "C.TOK", "FAILURE"],
    ...s.map((t) => {
      // Skipped and manual attempts are not scoreable, so they leave the
      // denominator rather than silently counting as failures.
      const scoreable = t.attempts - t.skipped - t.manual;
      const rate = scoreable > 0 ? `${Math.round((t.pass / scoreable) * 100)}%` : "—";
      return [
        t.taskId,
        t.slug,
        t.tier,
        `${t.pass}/${scoreable || "—"}`,
        rate,
        n1(t.avgSteps),
        n0(t.avgTotalMs),
        n0(t.avgRequestMs),
        n0(t.avgPromptTokens),
        n0(t.avgCompletionTokens),
        t.failures.join(",") || "—",
      ];
    }),
  ];

  const scoreable = run.results.filter(
    (r) => r.verdict !== "skipped" && r.verdict !== "manual",
  );
  const passed = scoreable.filter((r) => r.verdict === "pass").length;
  const manual = run.results.filter((r) => r.verdict === "manual").length;
  const skipped = run.results.filter((r) => r.verdict === "skipped").length;

  const totalPrompt = run.results.reduce((n, r) => n + r.usage.prompt, 0);
  const totalCompletion = run.results.reduce((n, r) => n + r.usage.completion, 0);
  const wallMs = run.results.reduce((n, r) => n + r.timing.totalMs, 0);

  const head = [
    "",
    `  backend   ${run.backend.provider}  ${run.backend.model || "(no model)"}`,
    `  endpoint  ${run.backend.baseUrl || "(no base url)"}`,
    `  attempts  ${run.attemptsPerTask} per task    step cap ${run.stepCap}`,
    "",
  ].join("\n");

  const foot = [
    "",
    `  scored    ${passed}/${scoreable.length} passed` +
      (manual ? `   ${manual} awaiting manual review` : "") +
      (skipped ? `   ${skipped} skipped` : ""),
    `  tokens    ${totalPrompt} prompt + ${totalCompletion} completion = ${totalPrompt + totalCompletion}`,
    `  wall      ${(wallMs / 1000).toFixed(1)}s`,
    "",
  ].join("\n");

  const align: ("l" | "r")[] = ["l", "l", "l", "r", "r", "r", "r", "r", "r", "r", "l"];
  return head + table(rows, align) + "\n" + foot;
}

/** Verdict-per-attempt detail. Useful when a task is flaky rather than broken. */
export function renderAttempts(run: SuiteRun): string {
  const rows: string[][] = [
    ["TASK", "#", "VERDICT", "STEPS", "ms", "NOTE"],
    ...run.results.map((r) => [
      r.taskId,
      String(r.attempt),
      MARK[r.verdict],
      String(r.steps),
      String(Math.round(r.timing.totalMs)),
      r.error ?? r.failure ?? "",
    ]),
  ];
  return table(rows, ["l", "r", "l", "r", "r", "l"]);
}

export function persist(run: SuiteRun, dir = "harness-results"): string {
  mkdirSync(dir, { recursive: true });
  const stamp = run.startedAt.replace(/[:.]/g, "-");
  const slug = `${run.backend.provider}_${run.backend.model || "nomodel"}`.replace(
    /[^\w.-]/g,
    "-",
  );
  const path = join(dir, `${stamp}_${slug}.json`);
  writeFileSync(path, JSON.stringify(run, null, 2), "utf8");
  return path;
}
