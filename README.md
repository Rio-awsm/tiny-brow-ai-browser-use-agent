# tiny-brow

A Chrome extension that opens a side panel, takes a plain-English task, and drives
the current tab to completion.

The brain is **bring-your-own-key**: you supply a base URL, an API key and a model
name, and the agent runs on whatever OpenAI-compatible endpoint answers — Groq,
OpenRouter, Google AI Studio, LiteLLM, a local LM Studio server, or anything else
speaking the same wire format.

> **Status: M10.** The harness now drives the real agent, so the suite can be scored
> on any backend and the results compared side by side. The numbers below are yours
> to generate — see [Scoring the matrix](#scoring-the-matrix).
>
> The extension is called **Tiny** in the UI; `tiny-brow` is the project name.

## Where this is

The build runs through sixteen gated milestones (`docs/browser-agent-build-guide.md`).

| | Milestone | State |
|---|---|---|
| M0 | Test suite + scoring harness | **done** |
| M1 | Extension scaffold, side panel | **done** |
| M2 | CDP attach, first screenshot | **done** |
| M3 | The DOM indexer | **done** |
| M4 | The highlight overlay | **done** |
| M5 | Manual actuation | **done** |
| M6 | The cursor overlay | **done** |
| M7 | The provider layer | **done** |
| M8 | Single-step decision | **done** |
| M9 | Close the loop | **done** |
| M10 | The provider matrix | **done** |
| M11 | Context compression | **done** |
| M12 | Repair, retry, loop breaking | **done** |
| M13 | The safety gate | **done** |
| M14 | Validator and model router | **done** |
| M15 | Packaging and release | next |

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
| **Overlay** | Re-indexes, then draws numbered boxes over every element on the page |
| **Cursor** | Toggles the animated cursor. On by default, remembered across sessions |
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

Being on such a page is not a dead end: `goto` works from anywhere, so Tiny can
navigate itself somewhere it *can* work.

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

## Driving the page by hand

The composer takes commands as well as tasks. A leading `/` always means command;
without it the grammar has to match strictly, so `click 7` runs and `click the login
button` is a task. The parsed command is echoed above the input before you commit to
it.

```
click 7              click element 7
type 3 hello         focus element 3 and type
type -k 3 hello      type per keystroke, which fires autocomplete
key Enter            Enter, Tab, Escape, ArrowDown, …
scroll up|down [px]  wheel the page
goto example.com     navigate this tab
newtab [url]         open a new tab and drive that instead
index                rebuild the element index
help                 list the above
```

**`goto` and `newtab` need no debugger session.** It uses `chrome.tabs.update` rather than
`Page.navigate`, so it works on pages Chrome refuses to attach to. Without that, a
window sitting on the new-tab page is a dead end: nothing can attach, so nothing can
navigate, so the agent can never start. Every other command needs a session;
navigation must not. `newtab` retargets Tiny onto the tab it opens.

### Waiting for the page

After every action Tiny waits for the page to be worth reading, in three layers:
main-frame loading stopped, then no network requests in flight for a quiet period,
then the element count holding steady. Each layer has its own ceiling, because a
page with a polling widget never truly goes quiet and must not hang the run — and
when a layer runs out of time that is reported rather than hidden.

A fixed sleep is the wrong shape here: too short on a slow page, wasted on a fast
one. Most apparent reasoning failures are timing failures, where the agent reads a
half-rendered SPA and then gets blamed for what it concluded from it.

### Stopping, and who owns the session

Cancellation is cooperative: the work is a promise chain in the service worker, so
there is nothing to kill and each phase instead checks whether it should stop. Every
tab always has a signal — not only during a run — because otherwise Stop would
silently do nothing for a one-off command. The longest-running parts are the ones
that need it most: per-keystroke typing and the settle wait both bail out mid-way.

A **run** is the separate concern. During one the debugger stays attached for its
whole length, because attaching per action would mean an attach/detach cycle and a
banner flash on every step of a forty-step task. `runStart` pins the session,
`runEnd` releases it, and a one-off action outside a run still closes its own session
behind it.

The panel holds a long-lived port open while it is on screen. If it closes mid-run
the background sees the disconnect and releases the debugger, rather than leaving the
banner over a page nobody is driving.

### Which tab

Every message names the tab it means. Resolving "the active tab" on each call
would let a user switching tabs mid-run silently hand the agent a different page to
drive. The panel follows the active tab while idle, and `newtab` moves it.

Every command that targets an element **scrolls it into view, then re-reads its
coordinates**. Skipping that re-read is the classic bug: the position recorded when
the index was built is stale the moment the page moves, and dispatching to it clicks
whatever slid into that spot.

After an action the page has changed, so the index is rebuilt automatically and the
overlay redrawn if it was on.

### The cursor

A pointer that glides to each target over ~340ms and ripples as the click lands.

It is styled so it can never be mistaken for your own mouse: a mint arrow with a
white edge, a breathing halo behind it, and a labelled pill reading **Tiny** with a
live status dot — the multiplayer-cursor convention, which people already read as
"someone else is driving". The label names the current action, so a click on a real
site says `Tiny · clicking button "Add to cart"`.

The click is dispatched **after** the glide resolves, not alongside it. The injected
move returns a promise that settles on `transitionend`, and `Runtime.evaluate` is
called with `awaitPromise: true` — so the animation is a truthful account of what
happened rather than decoration played over it.

It is purely cosmetic and worth building before the agent anyway. It is the
difference between a demo people understand and a wall of logs, and in practice it
is what makes you trust the thing enough to let it run on your real accounts.

Like the highlight overlay it lives in a closed shadow root under a
`data-tiny-brow` host with `pointer-events: none`, so it never appears in its own
index and never answers a hit test. It is re-created before every action, which is
also how it comes back after a navigation destroys it.

### Why not `element.click()`

Because it does not work where it matters. Modern frameworks and every bot-detection
layer check `isTrusted`, and a synthetic DOM event from a content script fails that
check — silently, on exactly the sites worth automating.

Everything here goes through `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent`,
which are dispatched at the browser's input layer and are indistinguishable from a
real mouse and keyboard. A click is mouseMoved, a pause, mousePressed, mouseReleased,
in that order and at real-world intervals.

Text entry has two strategies because one is not enough. `Input.insertText` is fast
and right for bulk, but some search boxes only open their autocomplete on a genuine
keydown and ignore a bulk insert entirely — `type -k` sends the keystrokes one at a
time for those.

## Running by itself

Type a task and press Run. Tiny observes, decides and acts until it says it is done,
gives up, hits the step cap, or you press Stop. Each step appears as a live row —
number, action, outcome — that expands to show the reason, the element count, tokens
and latency. A summary card closes the run with the answer, steps, wall time and total
tokens.

**Auto / Step** under the input switches between running to completion and proposing
one action at a time for approval. Step mode is the M8 behaviour and stays because it
is how you debug a run that went wrong.

### What the loop handles

| Situation | Behaviour |
|---|---|
| Model picks an index that is not listed | Re-prompted with the valid range, once. The retry does not consume a step; a second failure ends the run. |
| `429` from the provider | Waits the provider's own `retry-after` — backing off with jitter only when it does not say — and retries the same step. |
| Stop pressed | Halts within one step. The panel stops between steps and the background aborts whatever request or action is already in flight. |
| Step cap | Ends the run cleanly with `step_cap`, rather than running forever. |
| `extract` | Appends the fact to NOTES and keeps going. It is an observation, not an ending. |
| Page still loading | The waiting layer runs before every read, so a step never reasons about a half-rendered page. |
| An action changed nothing | The next turn is told so in words — same URL, same scroll, same elements. A model shown a page cannot see a diff, and left to infer it, it clicks the same dead button until the cap. |
| The same choice twice | The element is named and forbidden. Handing over on the third identical action was too quick: nothing had ever told the model that the thing did not work. |
| The same choice three times | Three mechanical recoveries in order — Escape, a click on the backdrop, a rewritten plan — then the run is handed to you. A stuck run is usually stuck behind an overlay, and the close buttons that defeat it are the ones with no accessible name: not in the index, so not clickable however well the model is prompted. Neither Escape nor a backdrop click needs the element to exist. |
| Off-schema reply | Retried twice. One bad decode is a provider flake, and failing the task over it scores the endpoint's hiccup as the agent being unable to do the job. |
| `fail` on the first attempt | Challenged once. Giving up is cheap for the model and expensive for you, and it often does it while its own reason names the next thing to try. |
| `done` | Checked by a second, independent call before the run ends. |

The loop takes its dependencies as arguments rather than reaching for them, so the
parts that decide whether it behaves — the cap, stopping, repair, surviving a 429 —
are tested without a browser or a model.

## Deciding what to do

Type a task and Tiny proposes **one** action, shown as a card with its stated reason
and an Execute / Reject pair. Executing runs it through the same actuation layer the
manual commands use and records a one-line summary; pressing Run again asks for the
next step. Rejecting re-asks with the rejection stated, so it proposes something
different rather than repeating itself.

### Popups

Sites throw a login or promo dialog over their content on arrival, and from the index
alone that is not obvious — the model sees a handful of elements unrelated to its task
and starts guessing at them.

Two things make this tractable. The indexer **names close controls**: an icon-only
button whose text is a glyph, or nothing at all, becomes `button "Close"` when its
class, id, test id or SVG title says so. Listed as `button ""` the model cannot know
what it does. And elements inside a modal are marked `in dialog`, so the state block
can say plainly that a dialog is covering the page and which element closes it.

A dismissible login popup is therefore **not** treated as a wall to hand over. Only a
dedicated sign-in page, or a popup with no way out, stops the run.

### When only you can do it

Tiny cannot sign in, and it should not try. A login page is the worst kind of wall for
an agent: no listed element makes progress, so every step looks locally reasonable
and the run loops until the step cap.

So a sign-in page, a captcha or a two-factor prompt **stops the run and asks you**.
You log in yourself in the tab and press **continue** — the run picks up from there
with its history intact, re-reading the page you left it on. **Skip** carries on
without, **Stop** ends the run as `needs_user`.

Detection is in code, not left to the model: known auth hosts, `/login`-shaped paths,
and any page carrying a password or one-time-code field. On top of that, a run that
proposes the same action on the same page three times hands over too, rather than
burning the cap.

**Typing a password, PIN, OTP or card number is refused in code**, whatever the page
or the prompt says. Model instructions get forgotten under long context; a check in
`validateAction` does not.

An unattended run — the scoring harness — answers "stop" immediately, because a task
that needs a human is a real result rather than something to hang on.

### The action schema

Eight verbs — `click`, `type`, `scroll`, `navigate`, `extract`, `done`, `fail` — and
no more. Every extra verb is another thing to pick wrongly, and the `enum` on the name
is what stops the model inventing one.

Every field is required, with `null` where an action does not use it. `.optional()`
would drop a field out of `required`, which strict mode rejects; a fixed shape also
means the model never has to decide whether to include a key.

Schema-constrained decoding guarantees the *shape*, never the *meaning*, so an index
the model chose is checked against the index it was actually given. An out-of-range
number is refused locally with the valid range named, and the card offers "Ask again"
instead of Execute.

`type` types only. To submit a search or a form, the model clicks the button
afterwards — which keeps the verb count down and composes correctly on multi-field
forms, where an implicit Enter would submit halfway through.

### Prompt assembly

Fixed order, and the order is the point:

```
1. system    role, actions, rules, safety     ← byte-identical, always
2. task      stated once
3. plan      the ordered steps, when a plan was written
4. history   one line per past step
5. notes     every fact extracted, verbatim
6. state     url, title, element index, page text
```

Providers cache on an **exact prefix match**, so everything that varies sits at the
end. Interleaving changing content into the system prompt destroys prefix caching
outright. It costs nothing on a fast hosted backend and is the single largest latency
win on a local one, so it is built this way unconditionally — the proposal card shows
the cached token count when the provider reports one.

History is one line per step and never a past page state. That is what keeps step 30
costing the same as step 3, and `npm run plot:tokens` is where you check it did.

**NOTES** is the exception that has to be verbatim, and it is the one part of the
prompt that is allowed to grow. History lines are truncated summaries, so a model that
found three prices thirty steps ago can no longer read them back — and what it does
instead is re-extract the first one forever, or leave a site without taking what it
came for. Facts go in whole; the block is capped per note and the model is told not to
add a fact that is already there.

**Page text is centred on the viewport, not taken from the top.** `body.innerText`
sliced from the beginning is the wrong excerpt on any long document: scroll to a table
halfway down an article and the model is still reading the lead paragraph, so it either
answers from the wrong part of the page or scrolls forever looking for what it has
already been shown. Blocks are measured in one batch — one layout pass, not a reflow
per node — and the excerpt grows outward from whichever block the viewport is centred
on, so it keeps its reading order.

### Starting from a page it cannot read

Chrome blocks CDP on its own pages, so a new-tab page cannot be indexed. That is not
a failure: `navigate` needs no debugger session, so the model is handed a page state
that says the page cannot be inspected and that navigating is the useful move. Failing
there instead would make a fresh window a dead end the agent could never start from.

### Prompt injection

Page text arrives wrapped in `<page_content>` fences, and the system prompt — the part
the model sees first and that never changes — declares everything inside them to be
untrusted data that is never an instruction.

This matters more here than for a cloud agent: Tiny runs inside a browser logged into
everything you own, and a page can contain text addressed to it. The fence is one
sentence and it is the cheapest defence available.

Behind it sits a second layer that does not depend on the model remembering anything.
Every page is scanned for text that reads as an instruction rather than as content —
*ignore all previous instructions*, *you are now*, *do not tell the user*. When any is
found the model is told, in the NOTICE line it reads first, that the page is trying it
and that the text is data. And if the model's own stated reason for an action turns out
to be quoting one of those spans back — six consecutive words is the threshold — the
action is refused before it dispatches, whatever it was.

## What Tiny will not do

The gate is [code](src/lib/agent/safety.ts), deliberately, and not a prompt rule. A
model reading forty steps of history forgets what it was told at the top; a function
does not. Every proposed action passes through it before anything else looks at the
action, so no later branch can route around it.

**Refused outright, with no way to approve it:**

| | |
|---|---|
| Passwords, PINs, OTPs, CVVs, card numbers, UPI PINs | You type those, in the tab. Tiny never touches the keyboard for them. |
| Sign-in, registration and OAuth flows | Recognised from the URL. Tiny stops and asks you to do it. |
| Anything justified by quoting the page's own instructions | See above. |
| Any site outside the run's allowed list | Off by default. When you turn it on, an allow list of host globs is the whole story and the deny list wins over it. |

**Held until you click Allow:**

Spending money and destroying things: *pay now*, *proceed to pay*, *place order*,
*checkout*, *buy now*, *confirm order*, *book now*, *transfer*, *withdraw*, *delete*,
*close account*, *unsubscribe*, *cancel subscription*. Matched on the element's own
visible label *and*, independently, on the destination URL, so a checkout reached by
link is caught the same way as one reached by button.

Not on form mechanics. A bare *submit* and *send* were on that list for one afternoon
and gated **every search box on the web** — "Go" on Amazon is an `<input
type="submit">`, and the indexer notes the input's type, so the gate read `submit` off
the note and refused the search. A gate that stops ordinary work is a gate the user
turns off, which protects nobody. It reads the label only now, and the label has to
name the commitment.

The approval card states the verb, the element's own label and the page it is on,
because an approval that only says *continue?* trains you to click yes. Nothing is
pre-selected. **With nobody watching — a scored benchmark run — it refuses rather than
allows.** A default the other way would mean the test suite could place an order.

Banks are handled by the allow list rather than a list of banks. Naming the domains to
keep out is a game you lose, because there is always one more; naming the ones a task
needs is finite, and it is also what stops a grocery task wandering into your email.

### Getting out from under a modal

Three ways, tried in that order, and the order is by how little each one assumes:

1. **Escape.** Costs nothing and closes most dialogs.
2. **A click on the backdrop.** For the ones that never listened for Escape. This is
   the only place in the codebase that clicks a raw coordinate rather than a listed
   element — deliberately, because the backdrop is not something anyone indexed, which
   is the whole reason the agent is stuck on it. Points down the sides are tried first,
   since a modal is centred far more often than not, and a candidate is rejected if it
   lands inside the modal's own bounds or on top of any listed element. If none is safe
   it does not click: a stray click navigates, and that is worse than not trying.
3. **A new plan**, if a planner route is configured.

Then the run is handed to you. What makes this necessary rather than fussy is a real
page: MakeMyTrip's login popup has a close control with no accessible name, so it never
reaches the index, and no amount of prompting can make a model click an element it was
never shown.

## Plan, navigate, check

Three roles, after Nanobrowser's split, because they want different models:

| Role | Called | Wants |
|---|---|---|
| **Planner** | Once at the start, once more if the run gets stuck | A stronger model. It runs twice a run against a step cap of forty. |
| **Navigator** | Every step | Cheap and fast. This is where the whole cost of a run is. |
| **Validator** | When the agent says `done` | Almost anything. Its prompt is tiny. |

A route is nothing but `(base URL, key, model, extraParams)` — the same triple the
provider layer already speaks — so the navigator can run on a local model while the
planner reaches for a hosted one in the same run. Each role falls back field by field
to the single configured provider, so the feature costs nothing until you want it, and
pointing one role at a better model on the same endpoint is typing a model name.

A key belongs to an endpoint: when a route names a different base URL, the base key is
**not** carried across to it.

**The validator** exists because premature completion is the most expensive failure a
browser agent has — it does not look like a failure. The run ends green, the transcript
reads sensibly, and the answer is *"I will now look for the price"*. The model that
spent thirty steps convincing itself is the worst possible judge of that, so the check
is a separate call that sees only the task, the notes and the final page — no history,
no reasoning to agree with. It argues once; a rejected answer comes back with the
reason attached, and the run carries on.

It judges against NOTES, not against the final page. On a two-site task the page the
agent stopped on is the *second* site, and the first site's fact is not on it — a
validator reading the page as evidence rejects a correct comparison for mentioning a
price that "is not there". And whatever happens, a run never falls back past an answer
the model composed to a bare join of its notes: one is a sentence with a comparison in
it, the other is two loose numbers.

**The planner** exists because a small model choosing one action at a time is good at
*what do I click* and bad at *which site holds which fact, and in what order*. That gap
is what loses a two-site comparison: it searches the first site, leaves without reading
the price, and arrives at the second with nothing to compare.

## Bringing your own key

Open **Settings** from the panel header. Pick a preset or Custom, paste an endpoint,
a key and a model name, then **Test connection**.

Presets are [data](src/lib/provider/presets.ts) — a base URL, some suggested models,
and any default `extraParams`. That file is the only place in the codebase a provider
is named. Adding one must never require touching the provider implementation; if it
does, BYOK is a marketing claim rather than an architecture.

**Custom is not an afterthought.** It is the option that keeps the rest honest,
because it is the only one that proves nothing provider-specific leaked into the code
path.

### One implementation

`POST /chat/completions`, not a Responses API — chat completions is the universal
surface that LM Studio, OpenRouter, LiteLLM and Google's compatibility mode all
implement, and choosing it is what makes BYOK real rather than aspirational.

**Structured output, not tool calling.** Models frequently fail to emit tool calls
through OpenAI-compatible layers because of chat-template mismatches, and the failure
is silent and total. Schema-constrained decoding sidesteps that whole class of bug.

The schema is defined once in Zod and both the wire schema and the runtime validation
derive from it, so they cannot drift. Strict mode has two rules that are easy to break
by accident — every object must set `additionalProperties: false`, and every declared
property must be required — so `toWireSchema` checks for both locally and names the
culprit, rather than letting it surface as a provider-side 400. `.optional()` is the
usual mistake; use `.nullable()` so the shape stays fixed.

### The `extraParams` escape hatch

Providers have non-portable parameters that materially change cost and behaviour.
They go in a passthrough bag on the config, never in the shared interface — the moment
`reasoningEffort` becomes a first-class field, the core layer has learned about one
vendor.

Groq's defaults are set for a reason: `include_reasoning: false` alone still generated
and billed 51 completion tokens for a one-word answer; adding `reasoning_effort: "low"`
brought it to 16.

### Failures, each one distinct

Every one of these produces its own actionable message rather than a generic "request
failed":

| What happened | What you see |
|---|---|
| Wrong base URL answering HTML | *answered with text/html instead of JSON* — checked by content type, not by catching a parse exception |
| Bad key | *The endpoint rejected the API key* |
| 429 | *Rate limited. Retry in 7s* — read from `retry-after` and `x-ratelimit-*`, not guessed |
| Model rejects schemas | The provider's own 400 text, surfaced verbatim |
| `finish_reason: "length"` | *hit the token ceiling before finishing* — a hard error, never an empty answer |
| Prose instead of JSON | *not JSON, despite being asked for a schema* |
| JSON of the wrong shape | Zod's own validation errors |

The truncation case is the subtle one. On a reasoning model the reasoning is generated
*before* the content, so a tight `max_tokens` is eaten by it and you receive empty
content with no error at all. It looks exactly like the model failing and it is a
budget bug.

### Permissions

Host permission is requested one origin at a time, at the moment you save an endpoint.
A BYOK tool cannot know its endpoints in advance, so the alternative is broad host
access at install; narrowing it to the origin you actually typed is more work and far
easier to defend in review.

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

### The highlight overlay

Numbered boxes over everything in the index, colour-coded by role — blue for text
entry, amber for toggles, violet for links, mint for everything else. The point is
not decoration: it finds indexer bugs in ten seconds that otherwise take a week to
notice, because they present as "the model is dumb" rather than "index 14 points at
an invisible div".

Two things make it correct rather than approximately correct:

**It re-measures live rects.** The boxes are repositioned from the real elements on
every scroll and resize, rather than being frozen at the coordinates the index
recorded. Sticky headers, modals and nested scrollers therefore work by construction.
That is only possible because the overlay is drawn in the **page's main world**,
where the indexer left its element references — a content script is in an isolated
world and cannot see them. The guide suggests drawing from the content script; this
is the one deviation, and re-measurement is the reason.

**It cannot index itself.** The host carries `data-tiny-brow` and holds its boxes in
a *closed* shadow root, so the indexer's `el.shadowRoot` check reads `null` and never
walks in. `pointer-events: none` keeps it out of `elementFromPoint`, which matters
more than it sounds: an overlay that answered hit tests would cover the page and the
topmost filter would drop every element on it.

### The injected function must stay self-contained

Everything that runs in the page — the indexer and both overlay functions — is
shipped by stringifying it. A bundler hoisting one inner helper to module scope
produces code that builds, typechecks, and then throws `ReferenceError` inside every
page it touches.

`npm run check:extractor` finds every injected function in the built bundle, pulls it
back out, and executes it against a stub DOM, so that breakage fails the build
instead of the browser. The stub is deliberately rich enough for each function to run
its whole path; an early return would exit before reaching the helper the check
exists to catch.

## The test suite

[`tasks.md`](tasks.md) is the finish line: ten fixed tasks with an unambiguous pass
condition each, from "report a page title" to "search MakeMyTrip and return the
cheapest fare". It was written before any code, and every change from here is
measured against it.

A result is never a bare task score. It is a **`(task, provider, model)` triple** —
with BYOK you are never scoring one system, you are scoring a family of them, and
"it works" is only ever true of a specific backend.

## Scoring the matrix

The harness lives in Node and the agent lives in a browser extension, so they meet
over a local HTTP bridge: the harness hands out one task at a time, the panel runs it
with the real loop against the real browser, and posts the outcome back. That keeps
the scorer as the scorer — the `(task, provider, model)` triple, the timing split, the
failure taxonomy all apply unchanged, because the bridge is just another
`AgentDriver`.

```bash
npm run fixtures   # serve the local pages T10 needs; leave it running
npm run bench      # score the whole suite on the backend in .env
npm run matrix     # compare every run recorded so far
```

T10 tests interruption handling, so its cookie banner and login wall have to be
present every time and identical every time. Pointing it at a real site would make it
fail for reasons that have nothing to do with interruptions, so it runs against a
local fixture — start `npm run fixtures` before scoring or T10 lands on an error page.

**To pass flags, run the script directly.** npm consumes `--provider` and `--model`
as its own config before they reach the harness — on Windows it drops the flag names
and forwards only the bare values, and no amount of quoting or `--` gets around it:

```bash
npx tsx harness/index.ts --driver bridge --provider lmstudio --model your-loaded-model
npx tsx harness/index.ts --driver bridge --task T01 --task T02
npx tsx harness/index.ts --compare
```

Every run prints the backend it resolved before it starts, so a lost flag is visible
immediately rather than at the end of a scored suite. Passing them through npm now
explains the problem and prints the working command instead of crashing.

Then in the browser: open the side panel, **Tools → Bench**. It asks once for
permission to reach `127.0.0.1:8787`, connects, and starts taking work.

The harness sends the backend with each task, so `--provider` actually switches what
the extension talks to. Your saved settings are untouched — but the extension still
needs host permission for that origin, so configure each backend once in Settings
before scoring it.

### What the matrix shows

```
  PASS RATE

    TASK  SLUG              A     B
    ----  ----------------  ----  --------------------
    T01   page-title        PASS  fail wrong_reasoning

  WHERE BACKENDS DISAGREE

    T01 page-title: passes on openai/gpt-oss-20b; fails on gemma-4-e4b-it (wrong_reasoning)

  STEP LATENCY, ms

    BACKEND                  STEPS  TOTAL  REQUEST  PREFILL  GEN   BROWSER
    -----------------------  -----  -----  -------  -------  ----  -------
    groq/openai/gpt-oss-20b  6.0    1180   700      110      470   480
    lmstudio/gemma-4-e4b-it  9.0    45000  44000    40000    3800  1000
```

The **gap** is the artefact, not the score. A task that passes on one backend and
fails on another is telling you something specific about that model, and the named
failure mode is the useful half.

Latency is split because a single elapsed number cannot separate prefill from
generation, and those two want opposite fixes — prefill is cut by a smaller prompt,
generation by a smaller answer or a faster model. Prefill and generation are only
filled in by providers that report them; a dash means the provider said nothing,
rather than a zero that would read as a measurement.

## Running the harness

```bash
npm install

npm run harness                          # stub driver: everything errors, honestly
npm run harness -- --driver oracle       # canned correct answers: proves the scorer
npm run harness -- --task T02 -n 5 -v    # one task, five attempts, per-attempt detail
npm run harness -- --provider lmstudio --model gemma-4-e4b-it
npm run harness -- --help
```

Three drivers ship:

- **`bridge`** — the real agent, in your browser, over the local bridge. This is what
  scores the matrix.
- **`stub`** — every attempt fails with `not_implemented`. The honest state of the
  project, and proof the harness runs end to end before any agent exists.
- **`oracle`** — hand-written correct answers for each auto-scored task. It exists
  so a green run can be told apart from a harness that scores everything `fail`
  because a `check` predicate is broken. Without it, "all fail" is unfalsifiable.

All three implement the same `AgentDriver` interface, which is why no scoring code
changed when the real agent arrived.

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
npm run check          # typecheck + drift + control chars + loop + secrets + injection
npm run verify:tasks   # tasks.md and harness/tasks.ts agree
npm run check:secrets  # no credential can reach the extension bundle
npm run check:chars    # no control characters in source
npm run check:loop     # the agent loop against a scripted model
npm run plot:tokens    # prompt tokens per step, from the last scored run
```

`plot:tokens` is the evidence for the compression claim. History is one line per past
step and the page index is only ever the current one, so the prompt should not grow with
the run; the chart says whether it actually does, and shading shows how much of each
step the provider served from its own cache.

`check:loop` replaces the model with a list of replies and the browser with a page
that only changes when the case says it does, which leaves the loop's own judgement
as the only thing under test: when it pushes back on a repeat, when it believes a
give-up, and what it answers with. These are the behaviours the benchmark measures
indirectly and expensively, so they are worth pinning down for free.

`check:chars` exists because a backspace byte written where `` was meant reads as a
word boundary in every editor and matches nothing at runtime. It reached this repo
once and silently disabled OTP detection for several milestones.

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
      overlay.ts      the injected highlight overlay
      actions.ts      click, type, key, scroll, navigate over CDP Input
      cursor.ts       the injected animated cursor
      settle.ts       the waiting layer: network quiet, then DOM stability
    content/          injected into every page; probes and, later, overlays
    sidepanel/        the React panel — where the agent loop runs
  components/         panel UI: header, transcript, composer, logo, cards
    ui/               shadcn-style primitives
  lib/                messaging protocol, command parser, types, zustand store
    settings.ts       step cap, roles, firewall — what a run is allowed to be
    agent/
      schema.ts       the eight verbs, and what a well-formed action is
      prompt.ts       prompt assembly, in a fixed order
      loop.ts         observe, decide, act — with repair, retry and loop breaking
      safety.ts       the gate: refusals, approvals, the firewall, injection
      planner.ts      the plan, written once and again when stuck
      validator.ts    the second opinion on `done`
      roles.ts        a route is (base URL, key, model, extraParams)
    provider/         the BYOK layer: one implementation, presets as data
  styles/theme.css    OKLCH design tokens, light and dark
public/icon/          toolbar icons, generated by `npm run icons`

tasks.md              the ten tasks — the finish line
harness/
  types.ts            the contract; failure taxonomy; the AgentDriver seam
  bridge.ts           local HTTP bridge to the agent in the browser
  compare.ts          the provider matrix and the gaps between backends
  tasks.ts            the suite, machine-readable
  config.ts           backend presets and resolution (the only reader of .env)
  driver.ts           stub and oracle drivers
  runner.ts           execution, timing, verdicts
  report.ts           console table and the JSON artifact
  index.ts            CLI
scripts/
  check-secrets.ts    the credential boundary, enforced
  check-extractor.ts  proves every injected function survives bundling
  check-chars.ts      no control characters in source
  loop-cases.ts       the loop against a scripted model, no browser, no key
  plot-tokens.ts      prompt tokens per step, from a scored run
  fixtures.ts         serves fixtures/gauntlet on :5199
  make-icons.ts       renders the mark to PNG, no image toolchain needed
docs/
  browser-agent-build-guide.md
```

## Stack

WXT (MV3, Vite), React 19, TypeScript, Tailwind v4, Zustand, Radix primitives.

## Which browsers

Chromium only, and that is a hard architectural limit rather than a missing
feature: everything rests on `chrome.debugger`, and Firefox does not expose CDP to
extensions at all.

| Browser | Status |
|---|---|
| Chrome | `npm run dev`, `npm run build` |
| Edge | `npm run dev:edge`, `npm run build:edge` — same code, same manifest |
| Brave, Opera, Vivaldi | load the `chrome-mv3` build unpacked |
| Firefox, Safari | not possible — no debugger API |

`npm run build:all` produces both outputs.

The one API that is not universal is `chrome.sidePanel`. Where it is missing the
panel opens in a popup window instead — and, more importantly, reaching for it
unguarded threw during background startup, which took the message listener down with
it. The extension did not merely lose its side panel there; it stopped responding at
all.

## Requirements

Node 22+.
