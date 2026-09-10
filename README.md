# tiny-brow

A Chrome extension that opens a side panel, takes a plain-English task, and drives
the current tab to completion.

The brain is **bring-your-own-key**: you supply a base URL, an API key and a model
name, and the agent runs on whatever OpenAI-compatible endpoint answers — Groq,
OpenRouter, Google AI Studio, LiteLLM, a local LM Studio server, or anything else
speaking the same wire format.

> **Status: M3.** The page indexer works: any page becomes a short numbered list of
> things that can be clicked or typed into. There is no actuation and no agent yet,
> so every harness task still reports `not_implemented`.

## Where this is

The build runs through sixteen gated milestones (`docs/browser-agent-build-guide.md`).

| | Milestone | State |
|---|---|---|
| M0 | Test suite + scoring harness | **done** |
| M1 | Extension scaffold, side panel | **done** |
| M2 | CDP attach, first screenshot | **done** |
| M3 | The DOM indexer | **done** |
| M4 | The highlight overlay | next |
| M5–M6 | Manual actuation, cursor | |
| M7–M10 | Provider layer, agent loop, provider matrix | |
| M11–M14 | Compression, repair, safety gate, router | |
| M15 | Packaging and release | |

## Running the extension

```bash
npm install
npm run dev        # launches a dev-profile Chrome with the extension loaded
```

Click the tiny-brow toolbar icon to open the side panel. Three probe buttons at the
bottom exercise the messaging paths the agent will use:

| Probe | Path |
|---|---|
| **Ping** | panel → background → panel, with the round-trip time |
| **Tab** | panel → background → `chrome.tabs`, refreshes the header |
| **Page** | panel → background → content script → back |

**Tools** under the composer opens the debug drawer:

| Tool | What it does |
|---|---|
| **Attach** / **Detach** | Opens or closes a pinned CDP session |
| **Index** | Builds the numbered element index the model will act on |
| **Shot** | `Page.captureScreenshot`. Attaches first if needed, then detaches, so a one-shot never leaves the banner up |
| **Ping** / **Probe** | Message round trips through the background worker and content script |

Results land in the transcript. Click a capture to enlarge it, or an index to
expand the exact text that will reach the model.

To load a production build manually instead: `npm run build`, then
`chrome://extensions` → Developer mode → Load unpacked → `.output/chrome-mv3`.

**The agent loop will live in the side panel, not the background service worker.**
MV3 kills idle service workers after ~30 seconds, and a 40-step run would die
mid-task. The panel page stays alive as long as it is open. Background exists only
to own the CDP connection and relay messages.

### The debugging banner

While attached, Chrome shows a yellow "extension is debugging this browser" banner
across the top of the tab. **It cannot be suppressed** — every extension in this
category lives with it. Detaching removes it.

CDP inside the user's own browser, with their real cookies and logins, is the whole
reason this is an extension rather than a Puppeteer script. The banner is the price.

### Pages Chrome will not let us touch

`chrome://`, `chrome-extension://`, `devtools://`, `about:`, `view-source:` and the
Chrome Web Store all reject debugger attachment, and local files need "Allow access
to file URLs". The URL is checked before attaching so the panel can say which of
those applies, rather than surfacing Chrome's generic refusal.

Only one debugger may attach per tab, so opening DevTools on the attached tab takes
the session away. That arrives as `onDetach`, and the panel reports what happened.

### Why session state is not held in memory

MV3 evicts the background service worker after ~30 seconds idle, taking any
module-level state with it — while Chrome's debugger session, and its banner, stay
up. A record kept only in memory therefore reports `detached` on a tab that is still
attached, so Detach is never offered for the session that is actually holding the
banner.

So the record lives in `chrome.storage.session`, which outlives the worker, and
`chrome.debugger.getTargets()` is treated as the authority on what is genuinely
attached. The stored record only answers whether a live session is *ours*. The panel
re-reads both every 2.5s, and `detach()` verifies against Chrome rather than assuming
success.

When Chrome reports a debugger the extension did not open, the badge reads
`external` — that is DevTools, another extension, or a session orphaned by a worker
restart. Detach will try to release it.

To check the ground truth yourself, run this in the background worker console:

```js
(await chrome.debugger.getTargets()).filter(t => t.attached)
```

## The page indexer

`Runtime.evaluate` injects a self-contained function that turns the page into two
separate things, and keeping them separate is the point: **the index is for acting,
the text is for reading.**

The index is a numbered list of interactive elements. The filters that matter, in
order of value:

1. **Topmost check.** Each candidate's own centre is hit-tested; if the point belongs
   to something else, the element is covered and gets dropped. This is what stops the
   agent clicking buttons behind a cookie banner — otherwise the most common and most
   confusing failure there is, because it presents as the model being stupid.
2. **Visibility** — zero size, `display:none`, `visibility:hidden`, zero opacity,
   `inert`, `aria-hidden`.
3. **Shadow DOM traversal**, including a hit test that descends through shadow roots.
   Without it the index is mysteriously empty on sites built from web components.
4. **Same-origin iframe traversal**, with coordinates offset by the frame's position.
5. **Deduplication** — a link wrapping a button wrapping a span is one thing, not
   three. Collapses to the outermost when the boxes coincide.
6. **Label truncation** at 40 characters, drawn from `aria-label`, then
   `aria-labelledby`, then text, then value, placeholder, title, alt, name.

Ordering is viewport-visible first, then document order, then capped at 40 and
renumbered. Both sorts are stable, so two runs on an unchanged page produce identical
output — a moving index would make every step a fresh guess for the model.

A full 40 elements costs ~1,364 tokens at worst and ~286 typically, against the
2,000-token budget. That budget is not cosmetic: on a free Groq tier of 8,000
tokens/minute, index size is what decides how many agent steps per minute you get.

### The injected function must stay self-contained

It is shipped by stringifying it, so a bundler hoisting one inner helper to module
scope produces code that builds, typechecks, and then throws `ReferenceError` inside
every page it touches. `npm run check:extractor` pulls the real function back out of
the built bundle and runs it against a stub DOM, so that breakage fails the build
instead of the browser.

## The test suite

[`tasks.md`](tasks.md) is the finish line: ten fixed tasks with an unambiguous pass
condition each, from "report a page title" to "search MakeMyTrip and return the
cheapest fare". It was written before any code, and every change from here is
measured against it.

A result is never a bare task score. It is a **`(task, provider, model)` triple** —
with BYOK you are never scoring one system, you are scoring a family of them, and
"it works" is only ever true of a specific backend.

## Running the harness

```bash
npm install

npm run harness                          # stub driver: everything errors, honestly
npm run harness -- --driver oracle       # canned correct answers: proves the scorer
npm run harness -- --task T02 -n 5 -v    # one task, five attempts, per-attempt detail
npm run harness -- --provider lmstudio --model gemma-4-e4b-it
npm run harness -- --help
```

Two drivers ship today and neither touches a browser or a model:

- **`stub`** — every attempt fails with `not_implemented`. The honest state of the
  project, and proof the harness runs end to end before any agent exists.
- **`oracle`** — hand-written correct answers for each auto-scored task. It exists
  so a green run can be told apart from a harness that scores everything `fail`
  because a `check` predicate is broken. Without it, "all fail" is unfalsifiable.

From M9 the real agent implements the same `AgentDriver` interface and no scoring
code changes.

Each run writes a JSON file to `harness-results/` with the backend baked into both
the filename and the payload, because the M10 matrix compares runs made hours apart.

### What gets recorded

Prompt and completion tokens separately, and wall clock split into request time,
rate-limit wait, browser time and harness overhead. A single elapsed number cannot
tell "waiting on a slow local prefill" apart from "waiting on a hosted provider's
quota", and those two want opposite fixes.

Failure modes are a closed set (`harness/types.ts`) rather than free text, because
naming the specific failure for every failure is an M10 exit gate.

## Checks

```bash
npm run check          # typecheck + task drift + secret boundary
npm run verify:tasks   # tasks.md and harness/tasks.ts agree
npm run check:secrets  # no credential can reach the extension bundle
```

`verify:tasks` guards the prose spec against the executable registry. They are
edited at different times for different reasons, so they will drift.

## Where the key lives, and why it matters

**The API key lives in the extension's settings UI and goes to `chrome.storage`.
It never comes from an `.env` file.**

Vite inlines `import.meta.env` at build time. A key read from an env var inside
extension source would be baked into the published bundle and shipped to every
user who installs it. `.env` is for the Node-side scoring harness only.

`npm run check:secrets` enforces this mechanically rather than by convention: it
fails the build if extension source reads `import.meta.env` or `process.env`,
imports from `harness/`, or if any tracked file contains a key-shaped literal. It
also scans `.output/` when a build is present, since the shipped bundle is what
the claim is actually about.

Keys are sent only to the endpoint you configure, and nowhere else.

## Layout

```
src/
  entrypoints/
    background/       service worker: message relay
      cdp.ts          the CDP session: attach, detach, screenshot, lifecycle
      extract.ts      the injected page indexer
    content/          injected into every page; probes and, later, overlays
    sidepanel/        the React panel — where the agent loop will live
  components/         panel UI: header, transcript, composer, logo
    ui/               shadcn-style primitives
  lib/                messaging protocol, CDP + index types, zustand store
  styles/theme.css    OKLCH design tokens, light and dark
public/icon/          toolbar icons, generated by `npm run icons`

tasks.md              the ten tasks — the finish line
harness/
  types.ts            the contract; failure taxonomy; the AgentDriver seam
  tasks.ts            the suite, machine-readable
  config.ts           backend presets and resolution (the only reader of .env)
  driver.ts           stub and oracle drivers
  runner.ts           execution, timing, verdicts
  report.ts           console table and the JSON artifact
  index.ts            CLI
scripts/
  check-secrets.ts    the credential boundary, enforced
  check-extractor.ts  proves the injected indexer survives bundling
  make-icons.ts       renders the mark to PNG, no image toolchain needed
docs/
  browser-agent-build-guide.md
```

## Stack

WXT (MV3, Vite), React 19, TypeScript, Tailwind v4, Zustand, Radix primitives.

## Requirements

Node 22+.
