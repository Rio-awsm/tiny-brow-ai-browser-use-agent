import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ElementDescriptor, IndexedElement } from "../../src/lib/page-index";

export const SNAPSHOT_ROOT = join(process.cwd(), "fixtures", "descriptors");

export interface Snapshot {
  /** Fixture path relative to `fixtures/`, e.g. `pages/shop.html`. */
  url: string;
  elements: IndexedElement[];
  descriptors: ElementDescriptor[];
}

export function snapshotPath(fixture: string): string {
  return join(SNAPSHOT_ROOT, fixture.replace(/\.html$/, ".json"));
}

export function loadSnapshots(): Snapshot[] {
  const out: Snapshot[] = [];
  for (const dir of readdirSync(SNAPSHOT_ROOT).sort()) {
    for (const file of readdirSync(join(SNAPSHOT_ROOT, dir)).sort()) {
      if (!file.endsWith(".json")) continue;
      out.push(JSON.parse(readFileSync(join(SNAPSHOT_ROOT, dir, file), "utf8")) as Snapshot);
    }
  }
  return out;
}
