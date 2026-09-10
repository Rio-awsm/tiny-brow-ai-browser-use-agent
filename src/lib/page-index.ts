export interface IndexedElement {
  /** The number the model refers to. Contiguous from 0 after truncation. */
  i: number;
  tag: string;
  role: string;
  label: string;
  /** Viewport coordinates, CSS pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  inViewport: boolean;
  /** Empty for the top document; otherwise the iframe chain that contains it. */
  frame: string;
  /** Extra qualifiers worth spending tokens on: input type, checked, disabled. */
  note: string;
}

export interface Viewport {
  w: number;
  h: number;
  scrollX: number;
  scrollY: number;
  docH: number;
}

export interface PageIndex {
  url: string;
  title: string;
  elements: IndexedElement[];
  /** Candidates before the cap, so a truncated index is visibly truncated. */
  totalFound: number;
  viewport: Viewport;
  /** Readable page text, kept separate: the index is for acting, this is for reading. */
  text: string;
  textChars: number;
  tookMs: number;
}

export const INDEX_CAP = 40;
export const TEXT_CAP = 4000;

/**
 * Rough token count. Deliberately an over-estimate: the budget it guards is
 * a hard rate limit, and being wrong in the cheap direction costs a retry.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~3.6 chars/token holds for the punctuation-dense shape of a serialised
  // index, where a plain-prose 4.0 under-counts.
  return Math.ceil(text.length / 3.6);
}

/** One line per element. This exact string is what reaches the model. */
export function serializeIndex(elements: IndexedElement[]): string {
  return elements
    .map((e) => {
      const parts = [`[${e.i}]`, e.role];
      if (e.label) parts.push(JSON.stringify(e.label));
      if (e.note) parts.push(e.note);
      if (!e.inViewport) parts.push("(off-screen)");
      if (e.frame) parts.push(`(in ${e.frame})`);
      return parts.join(" ");
    })
    .join("\n");
}

export function serializeViewport(v: Viewport): string {
  const pct = v.docH > 0 ? Math.round((v.scrollY / Math.max(1, v.docH - v.h)) * 100) : 0;
  return `viewport ${v.w}x${v.h}, scrolled ${clamp(pct, 0, 100)}% of ${v.docH}px`;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
