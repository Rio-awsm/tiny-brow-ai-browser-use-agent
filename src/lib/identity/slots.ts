import type { ElementDescriptor, PageIndex } from "@/lib/page-index";
import { matchElement } from "./match";

/**
 * Gives every element a name that survives the page re-rendering.
 *
 * The model's numbers are reassigned each step, so "[7] twice" can be two
 * different elements, and one element can be [7] then [9]. A slot is carried
 * from step to step: identical descriptors keep theirs outright, and the few
 * that changed are found again with the matcher. The model never sees slots.
 *
 * Slots only carry across reads of the same page. Navigating starts over.
 */

/** Past this many changed elements the page was replaced, not edited. */
const MATCH_LEFTOVERS_CAP = 40;

interface Previous {
  page: string;
  descriptors: ElementDescriptor[];
  slots: string[];
}

export class SlotTracker {
  private previous: Previous | null = null;
  private next = 1;

  /** Slots for this page's descriptors, in the same order. */
  observe(page: PageIndex): string[] {
    const descriptors = page.descriptors;
    const key = pageKey(page.url);
    const prev = this.previous?.page === key ? this.previous : null;
    const slots: (string | null)[] = descriptors.map(() => null);

    if (prev && descriptors.length > 0) {
      const taken = new Set<number>();
      const carried = new Set<number>();
      pairIdentical(prev.descriptors, descriptors, (from, to) => {
        slots[to] = prev.slots[from]!;
        taken.add(to);
        carried.add(from);
      });

      const unpaired = prev.descriptors.map((_, k) => k).filter((k) => !carried.has(k));
      if (unpaired.length > 0 && unpaired.length <= MATCH_LEFTOVERS_CAP && taken.size < descriptors.length) {
        for (const k of unpaired) {
          const result = matchElement(prev.descriptors[k]!, descriptors, {
            scope: "within_run",
            source: prev.descriptors,
          });
          if (result.index !== null && !taken.has(result.index)) {
            slots[result.index] = prev.slots[k]!;
            taken.add(result.index);
          }
        }
      }
    }

    const assigned = slots.map((s) => s ?? `s${this.next++}`);
    this.previous = { page: key, descriptors, slots: assigned };
    return assigned;
  }
}

/** The slot of the element the model knows as [i], if it has one. */
export function slotOfIndex(page: PageIndex, slots: string[], i: number | null | undefined): string | null {
  if (i === null || i === undefined) return null;
  const at = page.descriptors.findIndex((d) => d.i === i);
  return at >= 0 ? (slots[at] ?? null) : null;
}

/**
 * Pairs descriptors that did not change at all. Identical ones are paired in
 * document order, which is what a re-render preserves.
 */
function pairIdentical(
  before: ElementDescriptor[],
  after: ElementDescriptor[],
  pair: (from: number, to: number) => void,
) {
  const waiting = new Map<string, number[]>();
  before.forEach((d, k) => {
    const id = identity(d);
    const list = waiting.get(id);
    if (list) list.push(k);
    else waiting.set(id, [k]);
  });
  after.forEach((d, k) => {
    const from = waiting.get(identity(d))?.shift();
    if (from !== undefined) pair(from, k);
  });
}

/**
 * Everything about a descriptor except where it sits. Path is left out too: a
 * banner inserted at the top shifts the nth-of-type of every sibling after it.
 */
function identity(d: ElementDescriptor): string {
  return JSON.stringify([
    d.tag, d.role, d.name, d.href, d.stable, d.landmarks, d.context.heading, d.context.item, d.frame,
  ]);
}

function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}
