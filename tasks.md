# tiny-brow — the test suite

Ten fixed tasks that define "done". Written before any code. Every change to the
agent is measured against this list.

A result is never a bare task score. It is a **`(task, provider, model)` triple**.
The harness enforces that: see `harness/`.

## How to read a task

| Field | Meaning |
|---|---|
| **Prompt** | The exact plain-English string handed to the agent. Never paraphrased between runs. |
| **Human path** | What a person clicks, in order. If this is blank, the task is not specified well enough to score. |
| **Pass condition** | Unambiguous. Judged from the agent's final `done` payload plus the recorded step log. |
| **Fail-fast** | The specific way this task is expected to break. Used to label failure modes in M10. |

Scoring is `pass` / `fail` / `error` per attempt, over N attempts. A task's score is
its pass rate. Partial credit does not exist.

---

## T01 — page-title · Trivial

**Prompt:** `Go to https://example.com and tell me the page title.`

**Human path:** focus address bar → type URL → Enter → read the title from the tab.

**Pass condition:** final answer contains the exact string `Example Domain`.

**Why it is here:** proves plumbing — navigate, wait, extract, done. If this fails,
nothing else can pass.

**Fail-fast:** navigation completes but the agent extracts before load settles.

---

## T02 — wikipedia-lookup · Easy

**Prompt:** `Search Wikipedia for "Chandrayaan-3" and give me the first paragraph of the article.`

**Human path:** go to wikipedia.org → click the search box → type `Chandrayaan-3` →
Enter → land on the article → read the lead paragraph.

**Pass condition:** answer contains `Chandrayaan` and at least one of `ISRO` or
`lunar`, and is between 150 and 1200 characters.

**Why it is here:** single input, single result. The simplest real type-and-read cycle.

**Fail-fast:** agent answers from the search results snippet without opening the article.

---

## T03 — contact-form · Easy

**Prompt:** `On https://httpbin.org/forms/post, order a large pizza with bacon topping for "Test User", phone 5551234567, and submit the form.`

**Human path:** click Customer name → type → click Telephone → type → select the
Large size radio → tick the Bacon checkbox → click Submit order.

**Pass condition:** final URL is `https://httpbin.org/post` — which only happens on a
real submission — and the answer names the customer, the size and the topping. It does
not have to quote the response JSON verbatim; summarising it is a correct answer.

**Why it is here:** typing, radio buttons, checkboxes and submission — four distinct
actuation paths in one static, stable page.

**Fail-fast:** agent types into the wrong field because the index labels are drawn
from placeholder text rather than the associated label element.

---

## T04 — amazon-search · Medium

**Prompt:** `Search Amazon.in for "wireless mouse" and give me the titles and prices of the first three results.`

**Human path:** go to amazon.in → click the search box → type `wireless mouse` →
Enter → read the first three organic result cards.

**Pass condition:** the answer names at least three prices in rupees alongside their
titles. Sponsored results are acceptable. Prose is fine — the agent answers in text,
so demanding a structured payload would make this unpassable rather than hard.

**Why it is here:** a real site with a noisy DOM — thousands of nodes, heavy nesting,
lazy images. This is the first task where the M3 indexer is genuinely tested.

**Fail-fast:** element index blows past the token cap, or the agent extracts the
whole page text instead of the result cards.

---

## T05 — gmail-newest · Medium

**Prompt:** `Open Gmail and tell me who sent the newest email in my inbox.`

**Human path:** go to mail.google.com → the inbox loads → read the sender of the
top row.

**Pass condition:** answer names a sender that matches the top inbox row at run time.
Verified by the operator, not automatically. Scored manually.

**Why it is here:** a logged-in session in a heavy SPA. This is the task that only
works because we are a browser extension using the user's real cookies.

**Fail-fast:** agent reads the DOM before the SPA has painted the inbox rows.

**Note:** requires an authenticated profile. Skipped, not failed, when unauthenticated.

---

## T06 — grocery-cart · Medium

**Prompt:** `On Blinkit, add one packet of Amul butter 500g to my cart. Stop before checkout.`

**Human path:** go to blinkit.com → set/confirm location → click search → type
`amul butter` → Enter → find the 500g variant → click ADD.

**Pass condition:** cart badge reads 1 and the cart contains an Amul butter line item.
The agent must **not** reach a payment screen.

**Why it is here:** multi-step commerce with a location gate. It is also the task the
M13 safety gate is written for.

**Fail-fast:** the location modal is never dismissed, so every element behind it is
covered — the exact case the topmost hit-test filter exists to catch.

---

## T07 — price-compare · Hard

**Prompt:** `Compare the price of "Logitech M235 wireless mouse" on Amazon.in and Flipkart, and tell me which is cheaper and by how much.`

**Human path:** search Amazon.in → note price → navigate to flipkart.com → search →
note price → subtract.

**Pass condition:** both prices reported with a currency symbol, a named cheaper site,
and a difference within 1 unit of the stated prices' actual difference.

**Why it is here:** sequential navigation with state carried across sites. The agent
must remember a fact from step 4 at step 20 — this is what M11 compression must not
destroy.

**Fail-fast:** the first price is compressed out of history before the second is found.

---

## T08 — settings-dive · Hard

**Prompt:** `In my GitHub account settings, find whether "Keyboard shortcuts" are enabled under Accessibility, and report the value.`

**Human path:** github.com → avatar menu → Settings → Accessibility → read the
Keyboard shortcuts toggle state.

**Pass condition:** answer states enabled or disabled and matches the real toggle.
Scored manually against a screenshot.

**Why it is here:** deep navigation with no obvious path from the landing page. Tests
whether the agent can explore rather than pattern-match a search box.

**Fail-fast:** agent loops on the settings sidebar, re-clicking the same nav item.
This is the loop-detection case from M12.

---

## T09 — flight-search · Hard

**Prompt:** `On MakeMyTrip, search one-way flights from Delhi to Mumbai departing 15 days from today, and tell me the cheapest fare shown.`

**Human path:** makemytrip.com → dismiss the promo modal → From → type Delhi → pick
DEL → To → type Mumbai → pick BOM → open the date picker → page to the right month →
click the date → Search → read the cheapest fare.

**Pass condition:** a fare with a rupee sign is returned and the results header shows
DEL to BOM on the correct date.

**Why it is here:** date pickers, typeahead dropdowns whose options only exist after a
real keystroke, and a promo modal on entry. The hardest actuation in the suite — it is
the task that justifies the per-character `dispatchKeyEvent` fallback in M5.

**Fail-fast:** `Input.insertText` fills the city box but never fires the autocomplete,
so no airport is ever selected.

---

## T10 — recovery-gauntlet · Recovery

**Prompt:** `Search Wikipedia for "Chandrayaan-3" and give me the first paragraph of the article.`

Identical to T02, but run against a page that first presents a **cookie banner** and a
**login wall** overlay. Served from a local fixture (`fixtures/gauntlet/`) so the
interruptions are deterministic and always present.

**Human path:** dismiss the cookie banner → dismiss/skip the login wall → then the
T02 path.

**Pass condition:** identical to T02, and the run ends on the fixture. The article is
unreachable until both overlays are dealt with, so a correct answer is itself the
proof that they were.

**Why it is here:** interruption handling is the difference between a demo and a tool.
Making it a controlled fixture means it fails for one reason only.

**Fail-fast:** agent clicks an element that is visually behind the banner, the click
lands on the banner, nothing happens, and it repeats forever.

---

## Coverage check

| Capability | Covered by |
|---|---|
| Navigate + extract | T01, T02 |
| Text entry | T02, T03, T04, T09 |
| Form controls (radio, checkbox, submit) | T03 |
| Noisy real-world DOM | T04, T06, T07 |
| Authenticated SPA | T05, T08 |
| Multi-site state carry | T07 |
| Deep/exploratory navigation | T08 |
| Date picker + typeahead | T09 |
| Overlay / modal handling | T06, T09, T10 |
| Irreversible-action stop | T06 |

## Manual-scoring tasks

T05, T08 and T09 depend on live account state or live inventory, so the harness
records the answer and marks the attempt `manual`. The operator resolves it to
pass/fail. Every other task is scored automatically.
