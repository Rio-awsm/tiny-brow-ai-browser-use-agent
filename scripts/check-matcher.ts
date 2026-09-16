/**
 * The matcher against real descriptors, with no browser.
 *
 * Every element on every fixture snapshot is used as a target three ways: on
 * the page as recorded it must be matched to itself, with it deleted nothing
 * may be matched, and with a copy beside it the verdict must be ambiguous. Each
 * runs in both scopes. Snapshots come from `npm run check:descriptors -- --update`.
 *
 *   npm run check:matcher
 */

import {
  matchElement,
  roleFit,
  type MatchResult,
  type Scope,
  type Signal,
} from "../src/lib/identity/match";
import type { ElementDescriptor } from "../src/lib/page-index";
import { loadSnapshots } from "./lib/snapshots";

const snapshots = loadSnapshots();
if (snapshots.length === 0) {
  console.error("\n  no snapshots in fixtures/descriptors — run `npm run check:descriptors -- --update`\n");
  process.exit(1);
}

const failures: string[] = [];
const rungs = new Map<Signal | "none", number>();
let cases = 0;

const describe = (d: ElementDescriptor) => `${d.role} "${d.name.slice(0, 40)}" (${d.pathNorm})`;
const verdict = (r: MatchResult) =>
  `${r.outcome} score ${r.score} margin ${r.margin} rung ${r.rung ?? "-"}` +
  (r.ranked[0] ? ` ${JSON.stringify(r.ranked[0].signals)}` : "");

for (const snap of snapshots) {
  const page = snap.descriptors;

  for (const scope of ["within_run", "across_runs"] as Scope[]) {
    page.forEach((target, k) => {
      const tag = `${snap.url} ${scope} #${k} ${describe(target)}`;

      const same = matchElement(target, page, { scope, source: page });
      cases++;
      if (same.outcome !== "matched" || same.index !== k) {
        failures.push(`${tag}\n      unmodified: want matched #${k}, got ${verdict(same)}${same.index !== null ? ` #${same.index}` : ""}`);
      } else {
        rungs.set(same.rung ?? "none", (rungs.get(same.rung ?? "none") ?? 0) + 1);
        if (!same.rung) failures.push(`${tag}\n      matched without a rung`);
      }

      const deleted = page.filter((_, i) => i !== k);
      const gone = matchElement(target, deleted, { scope, source: page });
      cases++;
      if (gone.outcome !== "not_found") {
        const hit = gone.index !== null ? ` → ${describe(deleted[gone.index]!)}` : "";
        failures.push(`${tag}\n      deleted: want not_found, got ${verdict(gone)}${hit}`);
      }

      // The copy lands just below the original, as an inserted sibling would.
      const copy: ElementDescriptor = {
        ...target,
        i: null,
        geom: { ...target.geom, docY: target.geom.docY + 0.02, vpY: target.geom.vpY + 0.02 },
      };
      const doubled = [...page.slice(0, k + 1), copy, ...page.slice(k + 1)];
      const twin = matchElement(target, doubled, { scope, source: page });
      cases++;
      // A copied link goes where the original went, so either one is the right click.
      const sameDestination = Boolean(target.href) && twin.outcome === "matched" && (twin.index === k || twin.index === k + 1);
      if (twin.outcome !== "ambiguous" && !sameDestination) {
        failures.push(`${tag}\n      duplicated: want ambiguous, got ${verdict(twin)}${twin.index !== null ? ` #${twin.index}` : ""}`);
      }
    });
  }
}

// ---- targeted cases: the ones a whole-page sweep cannot express ----

function expect(name: string, ok: boolean, detail = "") {
  cases++;
  if (!ok) failures.push(`${name}${detail ? `\n      ${detail}` : ""}`);
}

expect("button and link are compatible", roleFit("button", "link") === "compatible");
expect("a clickable div and a button are compatible", roleFit("div", "button") === "compatible");
expect("a textbox and a checkbox are not", roleFit("textbox", "checkbox") === "incompatible");
expect("a searchbox and a textbox are compatible", roleFit("searchbox", "textbox") === "compatible");

{
  const mail = snapshots.find((s) => s.url === "pages/mail.html")!.descriptors;
  const rows = mail.filter((d) => d.stable["data-qa"] === "thread");
  const r = matchElement(rows[2]!, mail.filter((d) => d !== rows[2]), { source: mail });
  expect("a test id shared by every row identifies none of them", rows.length === 3 && r.outcome === "not_found", verdict(r));
}

const shop = snapshots.find((s) => s.url === "pages/shop.html")!.descriptors;
const dellCart = shop.findIndex((d) => d.name === "Add to cart" && d.context.item.includes("Dell"));

{
  const renamed = shop.map((d, i) =>
    i === dellCart
      ? {
          ...d,
          name: "Add to bag",
          nameNorm: "add to bag",
          context: {
            ...d.context,
            item: d.context.item.replace("Add to cart", "Add to bag"),
            itemNorm: d.context.itemNorm.replace("add to cart", "add to bag"),
          },
        }
      : d,
  );
  const r = matchElement(shop[dellCart]!, renamed, { scope: "across_runs", source: shop });
  // Indistinguishable from the cart button being gone and "Add to wish list"
  // remaining, so the one wrong answer is a match to anything else.
  expect(
    "a relabelled untagged button is never matched to its neighbour",
    r.outcome !== "matched" || r.index === dellCart,
    verdict(r),
  );

  const tagged = renamed.map((d, i) => (i === dellCart ? { ...d, stable: { ...d.stable, "data-testid": "add-dell" } } : d));
  const source = shop.map((d, i) => (i === dellCart ? tagged[i]! : d));
  const t = matchElement(source[dellCart]!, tagged, { source });
  expect(
    "a relabelled button with a test id is found",
    t.outcome === "matched" && t.index === dellCart && t.rung === "testid",
    verdict(t),
  );
}

{
  const cart = shop.findIndex((d) => d.stable["data-testid"] === "nav-cart");
  const moved = shop.map((d, i) =>
    i === cart
      ? { ...d, name: "Basket", nameNorm: "basket", landmarks: ["nav:primary"], pathNorm: "nav>a", geom: { ...d.geom, docX: 0.9 } }
      : d,
  );
  const r = matchElement(shop[cart]!, moved, { source: shop });
  expect(
    "a renamed, moved control with the same testid resolves on testid",
    r.outcome === "matched" && r.index === cart && r.rung === "testid",
    verdict(r),
  );
}

{
  const link = shop.findIndex((d) => d.name === "Today's Deals");
  const asButton = shop.map((d, i) => (i === link ? { ...d, role: "button", tag: "button" } : d));
  const r = matchElement(shop[link]!, asButton, { source: shop });
  expect(
    "a link turned into a button is found, with the role penalty",
    r.outcome === "matched" && r.index === link && r.ranked[0]?.signals.role_compatible === -8,
    verdict(r),
  );
}

{
  const cards = shop.filter((d) => d.name === "Add to cart");
  const reordered = shop.filter((d) => d.name !== "Add to cart").concat([...cards].reverse());
  const target = cards[1]!;
  const r = matchElement(target, reordered, { source: shop });
  expect(
    "reordered result cards: the right card, not the one now in its slot",
    r.outcome === "matched" && reordered[r.index!] === target,
    verdict(r),
  );
}

{
  const deals = shop.findIndex((d) => d.name === "Today's Deals");
  const elsewhere = { ...shop[deals]!, landmarks: ["footer"], pathNorm: "footer>a[4]", geom: { ...shop[deals]!.geom, docY: 0.9 } };
  const page = shop.filter((_, i) => i !== deals).concat({ ...elsewhere, href: "/deals-archive" });
  const r = matchElement(shop[deals]!, page, { source: shop });
  expect("a same-named link to a different destination is not the target", r.outcome !== "matched", verdict(r));
}

// ---- report ----

const total = [...rungs.values()].reduce((a, b) => a + b, 0);
console.log(`\n  ${snapshots.length} snapshots, ${cases} cases`);
console.log(
  "  rungs: " +
    [...rungs.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r} ${Math.round((n / total) * 100)}%`)
      .join(", "),
);

if (failures.length > 0) {
  console.error(`\n  ${failures.length} failed:\n`);
  for (const f of failures.slice(0, 25)) console.error(`  ✗ ${f}`);
  if (failures.length > 25) console.error(`  … and ${failures.length - 25} more`);
  process.exit(1);
}
console.log("\n  matcher verified\n");
