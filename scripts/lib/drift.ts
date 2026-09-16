import { join } from "node:path";
import type { MatchResult } from "../../src/lib/identity/match";
import type { ElementDescriptor } from "../../src/lib/page-index";

export const VARIANTS = ["", "wrappers", "ids+classes", "banner", "label", "reorder", "delete", "duplicate"];

/** Variants where the target survives and must be found. Label tweaks are judged apart. */
export const MUST_MATCH = [1, 2, 3, 5];

export const MATCH_RATE_FLOOR = 0.9;

export const RECORD_PATH = join(process.cwd(), "harness-results", "drift-cases.json");

export type Verdict = "correct" | "wrong" | "missed" | "lost";

/** Where the tagged target and its copy ended up in the mutated page's descriptors; -1 if absent. */
export interface Truth {
  target: number;
  clone: number;
}

/** One mutated page, enough to recompute the verdict under any tuning. */
export interface RecordedCase {
  fixture: string;
  k: number;
  variant: number;
  truth: Truth;
  descriptors: ElementDescriptor[];
}

export function judge(variant: number, target: ElementDescriptor, truth: Truth, result: MatchResult): Verdict {
  const got = result.index;

  if (variant === 6) return result.outcome === "matched" ? "wrong" : "correct";

  if (variant === 7) {
    // A copy laid exactly over the original covers it, and the original stops being clickable.
    if (truth.target < 0) return "lost";
    if (result.outcome === "ambiguous") return "correct";
    if (result.outcome === "not_found") return "missed";
    if (got === truth.target) return "correct";
    // A copied link goes where the original did, so the copy is the right click too.
    if (got === truth.clone && target.href) return "correct";
    return "wrong";
  }

  if (truth.target < 0) return "lost";
  if (result.outcome !== "matched") return "missed";
  return got === truth.target ? "correct" : "wrong";
}
