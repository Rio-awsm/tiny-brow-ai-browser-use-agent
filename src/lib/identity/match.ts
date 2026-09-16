import Fuse from "fuse.js";
import type { ElementDescriptor } from "@/lib/page-index";

/**
 * Finds a recorded element again on a page that may have changed since.
 *
 * Pure: descriptors in, verdict out, no DOM. Evidence comes in three kinds,
 * kept apart on purpose:
 *
 *   own        what the element itself carries: test id, id, name attribute, accessible name
 *   near       what surrounds it: landmarks, heading, the card it sits in
 *   position   where it is: path, ordinal, geometry
 *
 * A match needs an anchor: a unique test id, id or name attribute, or an equal
 * accessible name. Neighbourhood never anchors — every link in a paragraph
 * shares it, and "Add to wish list" shares a card with "Add to cart". Nor does a
 * similar name: "node debug adapter" is one letter from "mono debug adapter",
 * and "Satish Dhawan Space Centre" scores against "Indian Space Research
 * Organisation" like "Add to bag" does against "Add to cart". An untagged control
 * that was relabelled therefore comes back not_found, for the caller to heal,
 * rather than as its neighbour.
 *
 * Position can rank but never separate candidates that look identical:
 * duplicate a button and the copy inherits the original's slot, delete a result
 * card and the next one slides into it. For the same reason, an element that
 * already had a lookalike on the page it was recorded from is never matched.
 */

export type MatchOutcome = "matched" | "ambiguous" | "not_found";

export type Signal =
  | "testid"
  | "id"
  | "name_attr"
  | "name_exact"
  | "name_norm"
  | "name_fuzzy"
  | "landmarks"
  | "landmark_suffix"
  | "context"
  | "path"
  | "ordinal"
  | "geometry"
  | "role_compatible"
  | "name_conflict"
  | "context_conflict"
  | "heading_conflict"
  | "landmark_conflict";

export type Scope = "within_run" | "across_runs";

export interface MatchWeights {
  testid: number;
  id: number;
  nameAttr: number;
  nameExact: number;
  nameNorm: number;
  /** Multiplied by similarity. */
  nameFuzzy: number;
  landmarks: number;
  landmarkSuffix: number;
  context: number;
  ordinal: number;
  pathAcrossRuns: number;
  pathWithinRun: number;
  geometry: number;
  roleCompatible: number;
  nameConflict: number;
  contextConflict: number;
  headingConflict: number;
  landmarkConflict: number;
}

export const DEFAULT_WEIGHTS: MatchWeights = {
  testid: 50,
  id: 30,
  nameAttr: 25,
  nameExact: 40,
  nameNorm: 32,
  nameFuzzy: 20,
  landmarks: 25,
  landmarkSuffix: 12,
  context: 15,
  ordinal: 8,
  pathAcrossRuns: 10,
  pathWithinRun: 30,
  geometry: 5,
  roleCompatible: -8,
  nameConflict: -20,
  contextConflict: -40,
  headingConflict: -15,
  landmarkConflict: -12,
};

export interface MatchTuning {
  weights: MatchWeights;
  /** Least total score a match may have. */
  threshold: number;
  /** Least score from everything but position; an anchor is required as well. */
  identityFloor: number;
  /** How far the winner must lead the runner-up. */
  margin: number;
  /** Fuse similarity (1 − score) below which a name earns nothing. */
  nameFuzzyFloor: number;
  /** Names both present and this dissimilar are different controls. */
  nameConflictBelow: number;
  /** Container text this similar counts as the same item. */
  itemMatchAt: number;
  /** Container text this dissimilar is a different item. */
  itemConflictBelow: number;
  /** Largest centre offset, as a fraction of the document, that counts as the same place. */
  geometryWithin: number;
}

export const DEFAULT_TUNING: MatchTuning = {
  weights: DEFAULT_WEIGHTS,
  threshold: 50,
  identityFloor: 30,
  margin: 10,
  nameFuzzyFloor: 0.5,
  nameConflictBelow: 0.4,
  itemMatchAt: 0.85,
  itemConflictBelow: 0.75,
  geometryWithin: 0.15,
};

export interface MatchOptions {
  scope?: Scope;
  /**
   * The page the target was recorded from. Enables the ordinal signal, and the
   * refusal to match a target that had a lookalike there.
   */
  source?: ElementDescriptor[];
  tuning?: Partial<MatchTuning>;
}

export interface ScoredCandidate {
  /** Position in the candidates array. */
  index: number;
  score: number;
  identity: number;
  /** Has evidence tying it to this element specifically, not just its neighbourhood. */
  anchored: boolean;
  signals: Partial<Record<Signal, number>>;
}

export interface MatchResult {
  outcome: MatchOutcome;
  match: ElementDescriptor | null;
  index: number | null;
  score: number;
  /** Winner's lead over the runner-up; the whole score when there is none. */
  margin: number;
  /** The signal that set the winner apart, or its strongest one when nothing competed. */
  rung: Signal | null;
  /** Best first, for explaining a verdict. Candidates with an incompatible role are absent. */
  ranked: ScoredCandidate[];
}

/** Everything but position. */
const IDENTITY: ReadonlySet<Signal> = new Set<Signal>([
  "testid", "id", "name_attr", "name_exact", "name_norm", "name_fuzzy", "landmarks",
  "landmark_suffix", "context", "role_compatible", "name_conflict", "context_conflict",
  "heading_conflict", "landmark_conflict",
]);

/** Strongest first; breaks ties when choosing a rung. */
const RUNG_ORDER: Signal[] = [
  "testid", "name_exact", "name_norm", "id", "name_attr", "landmarks", "path",
  "name_fuzzy", "context", "landmark_suffix", "ordinal", "geometry",
];

const TESTID_KEYS = ["data-testid", "data-test", "data-qa", "data-cy"];

const ROLE_FAMILIES: string[][] = [
  ["button", "link", "menuitem", "tab"],
  ["textbox", "searchbox", "combobox"],
  ["checkbox", "switch", "menuitemcheckbox"],
  ["radio", "menuitemradio"],
];

/** Tags reported as a role because nothing better was declared, e.g. a clickable `div`. */
const ARIA_ROLES = new Set([
  "button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "switch", "textbox", "combobox", "searchbox", "slider",
  "spinbutton", "treeitem", "listbox", "group", "listitem", "row", "cell", "gridcell",
  "heading", "img", "dialog",
]);

type RoleFit = "same" | "compatible" | "incompatible";

export function roleFit(a: string, b: string): RoleFit {
  if (a === b) return "same";
  // A clickable div swapped for a button, or back, is the same control restyled.
  const clickable = (r: string) => !ARIA_ROLES.has(r) || ROLE_FAMILIES[0]!.includes(r);
  if (clickable(a) && clickable(b)) return "compatible";
  return ROLE_FAMILIES.some((f) => f.includes(a) && f.includes(b)) ? "compatible" : "incompatible";
}

export function matchElement(
  target: ElementDescriptor,
  candidates: ElementDescriptor[],
  options: MatchOptions = {},
): MatchResult {
  const result = evaluate(target, candidates, options);
  if (result.outcome !== "matched" || !options.source?.includes(target)) return result;
  if (distinctWhenRecorded(target, options.source, options)) return result;
  return { ...result, outcome: "ambiguous", match: null, index: null };
}

const recorded = new WeakMap<ElementDescriptor[], Map<string, boolean>>();

/** Whether the target was the one clear match on its own page. Cached per source page. */
function distinctWhenRecorded(
  target: ElementDescriptor,
  source: ElementDescriptor[],
  options: MatchOptions,
): boolean {
  const cacheable = !options.tuning;
  const key = `${options.scope ?? "across_runs"}:${source.indexOf(target)}`;
  let seen = recorded.get(source);
  if (cacheable && seen?.has(key)) return seen.get(key)!;

  const self = evaluate(target, source, options);
  const distinct = self.outcome === "matched" && self.match === target;
  if (cacheable) {
    if (!seen) recorded.set(source, (seen = new Map()));
    seen.set(key, distinct);
  }
  return distinct;
}

function evaluate(
  target: ElementDescriptor,
  candidates: ElementDescriptor[],
  options: MatchOptions,
): MatchResult {
  const tuning: MatchTuning = { ...DEFAULT_TUNING, ...options.tuning };
  const w = tuning.weights;
  const scope = options.scope ?? "across_runs";

  const nameSim = similarities(candidates, "nameNorm", target.nameNorm);
  const itemSim = similarities(candidates, "context.itemNorm", target.context.itemNorm);
  const targetOrdinal = options.source ? ordinalIn(options.source, target) : null;
  const unique = uniqueStable(target, candidates, options.source);

  const ranked: ScoredCandidate[] = [];

  candidates.forEach((c, index) => {
    if (c.frame !== target.frame) return;
    const fit = roleFit(target.role, c.role);
    if (fit === "incompatible") return;

    const s: Partial<Record<Signal, number>> = {};
    if (fit === "compatible") s.role_compatible = w.roleCompatible;

    if (unique.testid.some((k) => target.stable[k] === c.stable[k])) s.testid = w.testid;
    if (unique.id && target.stable.id === c.stable.id) s.id = w.id;
    if (unique.name && target.stable.name === c.stable.name) s.name_attr = w.nameAttr;

    if (target.name && target.name === c.name) {
      s.name_exact = w.nameExact;
    } else if (target.nameNorm && target.nameNorm === c.nameNorm) {
      s.name_norm = w.nameNorm;
    } else if (target.nameNorm && c.nameNorm) {
      const sim = nameSim.get(index) ?? 0;
      if (sim >= tuning.nameFuzzyFloor) s.name_fuzzy = round(w.nameFuzzy * sim);
      else if (sim < tuning.nameConflictBelow && !s.testid) s.name_conflict = w.nameConflict;
    }

    if (target.landmarks.length > 0 && c.landmarks.length > 0) {
      if (target.landmarks.join("/") === c.landmarks.join("/")) s.landmarks = w.landmarks;
      else if (target.landmarks.at(-1) === c.landmarks.at(-1)) s.landmark_suffix = w.landmarkSuffix;
      else if (!s.testid) s.landmark_conflict = w.landmarkConflict;
    }

    // Like with like: a card against a card, a heading against a heading. A
    // rival outside any card must not borrow credit from the page heading.
    const targetItem = Boolean(target.context.itemNorm);
    if (targetItem && c.context.itemNorm) {
      const sim = target.context.itemNorm === c.context.itemNorm ? 1 : (itemSim.get(index) ?? 0);
      if (sim >= tuning.itemMatchAt) s.context = w.context;
      else if (sim < tuning.itemConflictBelow && !s.testid) s.context_conflict = w.contextConflict;
    } else if (!targetItem && !c.context.itemNorm && target.context.headingNorm && c.context.headingNorm) {
      if (target.context.headingNorm === c.context.headingNorm) s.context = w.context;
      else if (!s.testid) s.heading_conflict = w.headingConflict;
    }

    if (target.pathNorm && target.pathNorm === c.pathNorm) {
      s.path = scope === "within_run" ? w.pathWithinRun : w.pathAcrossRuns;
    }
    if (targetOrdinal !== null && c.nameNorm === target.nameNorm && ordinalIn(candidates, c) === targetOrdinal) {
      s.ordinal = w.ordinal;
    }
    if (
      Math.abs(target.geom.docX - c.geom.docX) <= tuning.geometryWithin &&
      Math.abs(target.geom.docY - c.geom.docY) <= tuning.geometryWithin
    ) {
      s.geometry = w.geometry;
    }

    let score = 0;
    let identity = 0;
    const anchored = Boolean(s.testid || s.id || s.name_attr || s.name_exact || s.name_norm);
    for (const [signal, value] of Object.entries(s) as [Signal, number][]) {
      score += value;
      if (IDENTITY.has(signal)) identity += value;
    }
    ranked.push({ index, score: round(score), identity: round(identity), anchored, signals: s });
  });

  ranked.sort((a, b) => b.score - a.score || b.identity - a.identity || a.index - b.index);

  const eligible = ranked.filter(
    (r) => r.anchored && r.score >= tuning.threshold && r.identity >= tuning.identityFloor,
  );
  const best = eligible[0];
  if (!best) {
    return { outcome: "not_found", match: null, index: null, score: ranked[0]?.score ?? 0, margin: 0, rung: null, ranked };
  }

  const others = ranked.filter((r) => r !== best);
  const runnerUp = others[0];
  const margin = round(best.score - (runnerUp?.score ?? 0));
  const lookalike = others.find((r) => r.identity >= best.identity);
  const rival = lookalike ?? runnerUp;
  const rung = rungOf(best, rival);

  if (lookalike || (runnerUp && margin < tuning.margin)) {
    return { outcome: "ambiguous", match: null, index: null, score: best.score, margin, rung, ranked };
  }
  return {
    outcome: "matched",
    match: candidates[best.index]!,
    index: best.index,
    score: best.score,
    margin,
    rung,
    ranked,
  };
}

/**
 * Which of the target's stable attributes identify one element. A value shared
 * by several — `data-qa="thread"` on every inbox row, `name="size"` on every
 * radio — is a class, not an identity, and scores nothing.
 */
function uniqueStable(
  target: ElementDescriptor,
  candidates: ElementDescriptor[],
  source: ElementDescriptor[] | undefined,
): { testid: string[]; id: boolean; name: boolean } {
  const once = (key: string) => {
    const value = target.stable[key];
    if (!value) return false;
    const count = (list: ElementDescriptor[]) => list.filter((d) => d.stable[key] === value).length;
    return count(candidates) <= 1 && (!source || count(source) <= 1);
  };
  return { testid: TESTID_KEYS.filter(once), id: once("id"), name: once("name") };
}

/** The positive signal the winner leads the rival on by the most. */
function rungOf(best: ScoredCandidate, rival: ScoredCandidate | undefined): Signal | null {
  let rung: Signal | null = null;
  let lead = 0;
  for (const signal of RUNG_ORDER) {
    const mine = best.signals[signal] ?? 0;
    if (mine <= 0) continue;
    const gap = mine - (rival?.signals[signal] ?? 0);
    if (gap > lead) {
      lead = gap;
      rung = signal;
    }
  }
  if (rung) return rung;
  return RUNG_ORDER.find((s) => (best.signals[s] ?? 0) > 0) ?? null;
}

/**
 * Similarity 0..1 of every candidate's field to the query, by position.
 *
 * Fuse answers "does the text contain the query", so "search" scores perfectly
 * against "search, alt, forward slash". Scaling by the length ratio turns that
 * into "are these the same text". Very short queries match anything that
 * contains the letter, so they get no fuzzy credit at all.
 */
function similarities(candidates: ElementDescriptor[], key: string, query: string): Map<number, number> {
  const out = new Map<number, number>();
  if (query.length < 3) return out;
  const fuse = new Fuse(candidates, {
    keys: [key],
    includeScore: true,
    ignoreLocation: true,
    ignoreFieldNorm: true,
    threshold: 1,
    useTokenSearch: true,
    tokenMatch: "any",
  });
  for (const r of fuse.search(query)) {
    const text = key === "nameNorm" ? r.item.nameNorm : r.item.context.itemNorm;
    const ratio = Math.min(text.length, query.length) / Math.max(text.length, query.length, 1);
    out.set(r.refIndex, (1 - (r.score ?? 1)) * Math.sqrt(ratio));
  }
  return out;
}

/** 1-based position among same-role, same-name descriptors. */
function ordinalIn(list: ElementDescriptor[], d: ElementDescriptor): number | null {
  let n = 0;
  for (const other of list) {
    if (other.role !== d.role || other.nameNorm !== d.nameNorm) continue;
    n++;
    if (other === d || sameDescriptor(other, d)) return n;
  }
  return null;
}

function sameDescriptor(a: ElementDescriptor, b: ElementDescriptor): boolean {
  return a.pathNorm === b.pathNorm && a.geom.docX === b.geom.docX && a.geom.docY === b.geom.docY;
}

const round = (n: number) => Math.round(n * 100) / 100;
