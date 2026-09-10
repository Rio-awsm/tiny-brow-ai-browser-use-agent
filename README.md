# tiny-brow

A Chrome extension that opens a side panel, takes a plain-English task, and drives
the current tab to completion.

The brain is **bring-your-own-key**: you supply a base URL, an API key and a model
name, and the agent runs on whatever OpenAI-compatible endpoint answers — Groq,
OpenRouter, Google AI Studio, LiteLLM, a local LM Studio server, or anything else
speaking the same wire format.

> **Status: M1.** The extension shell exists — side panel, background worker,
> content script, and messaging between them. There is no CDP access and no agent
> yet, so every harness task still reports `not_implemented`, on purpose.

## Where this is

The build runs through sixteen gated milestones (`docs/browser-agent-build-guide.md`).

| | Milestone | State |
|---|---|---|
| M0 | Test suite + scoring harness | **done** |
| M1 | Extension scaffold, side panel | **done** |
| M2 | CDP attach, first screenshot | next |
| M3–M6 | DOM indexer, overlays, manual actuation | |
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

To load a production build manually instead: `npm run build`, then
`chrome://extensions` → Developer mode → Load unpacked → `.output/chrome-mv3`.

**The agent loop will live in the side panel, not the background service worker.**
MV3 kills idle service workers after ~30 seconds, and a 40-step run would die
mid-task. The panel page stays alive as long as it is open. Background exists only
to own the CDP connection and relay messages.

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
    background/       service worker: panel behaviour, message relay
    content/          injected into every page; probes and, later, overlays
    sidepanel/        the React panel — where the agent loop will live
  components/         panel UI
    ui/               shadcn-style primitives
  lib/                messaging protocol, zustand store, utils
  styles/theme.css    OKLCH design tokens, light and dark

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
docs/
  browser-agent-build-guide.md
```

## Stack

WXT (MV3, Vite), React 19, TypeScript, Tailwind v4, Zustand, Radix primitives.

## Requirements

Node 22+.
