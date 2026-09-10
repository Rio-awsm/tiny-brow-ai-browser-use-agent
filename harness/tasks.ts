/**
 * The suite, machine-readable. Mirrors `tasks.md` exactly.
 *
 * `tasks.md` is the prose spec a human reads; this is what the harness runs.
 * They drift the moment someone edits one and not the other, so
 * `npm run harness -- --verify-tasks` diffs the ids and prompts across both.
 */

import type { AgentOutcome, TaskDefinition } from "./types.js";

/** Cheap normalisation so `check` predicates are not whitespace-sensitive. */
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Matches a rupee amount: the sign, then digits with optional grouping/decimals. */
const RUPEE = /₹\s?[\d,]+(?:\.\d+)?/;

export const TASKS: TaskDefinition[] = [
  {
    id: "T01",
    slug: "page-title",
    tier: "trivial",
    scoring: "auto",
    prompt: "Go to https://example.com and tell me the page title.",
    startUrl: "about:blank",
    check: (o) => o.answer.includes("Example Domain"),
  },
  {
    id: "T02",
    slug: "wikipedia-lookup",
    tier: "easy",
    scoring: "auto",
    prompt:
      'Search Wikipedia for "Chandrayaan-3" and give me the first paragraph of the article.',
    startUrl: "https://www.wikipedia.org",
    check: (o) => {
      const a = norm(o.answer);
      return (
        /chandrayaan/i.test(a) &&
        (/isro/i.test(a) || /lunar/i.test(a)) &&
        a.length >= 150 &&
        a.length <= 1200
      );
    },
  },
  {
    id: "T03",
    slug: "contact-form",
    tier: "easy",
    scoring: "auto",
    prompt:
      'On https://httpbin.org/forms/post, order a large pizza with bacon topping for "Test User", phone 5551234567, and submit the form.',
    startUrl: "https://httpbin.org/forms/post",
    // Landing on /post proves the form was submitted; the answer only has to
    // show the agent knew what it sent. Demanding it quote the raw JSON failed
    // runs that had done the task perfectly and summarised the response.
    check: (o) =>
      o.finalUrl.startsWith("https://httpbin.org/post") &&
      /test user/i.test(o.answer) &&
      /large/i.test(o.answer) &&
      /bacon/i.test(o.answer),
  },
  {
    id: "T04",
    slug: "amazon-search",
    tier: "medium",
    scoring: "auto",
    prompt:
      'Search Amazon.in for "wireless mouse" and give me the titles and prices of the first three results.',
    startUrl: "https://www.amazon.in",
    // Read out of the answer text, not a structured payload: the action schema
    // has no data field, so requiring one made this task unpassable by
    // construction rather than difficult.
    check: (o) => {
      const prices = o.answer.match(new RegExp(RUPEE.source, "g")) ?? [];
      return prices.length >= 3 && norm(o.answer).length > 60;
    },
  },
  {
    id: "T05",
    slug: "gmail-newest",
    tier: "medium",
    scoring: "manual",
    prompt: "Open Gmail and tell me who sent the newest email in my inbox.",
    startUrl: "https://mail.google.com",
    requiresAuth: true,
  },
  {
    id: "T06",
    slug: "grocery-cart",
    tier: "medium",
    scoring: "manual",
    prompt:
      "On Blinkit, add one packet of Amul butter 500g to my cart. Stop before checkout.",
    startUrl: "https://blinkit.com",
    requiresAuth: true,
  },
  {
    id: "T07",
    slug: "price-compare",
    tier: "hard",
    scoring: "auto",
    prompt:
      'Compare the price of "Logitech M235 wireless mouse" on Amazon.in and Flipkart, and tell me which is cheaper and by how much.',
    startUrl: "https://www.amazon.in",
    check: (o) => {
      const a = norm(o.answer);
      const prices = a.match(new RegExp(RUPEE.source, "g")) ?? [];
      return (
        prices.length >= 2 &&
        /amazon/i.test(a) &&
        /flipkart/i.test(a) &&
        /cheap|less|lower/i.test(a)
      );
    },
  },
  {
    id: "T08",
    slug: "settings-dive",
    tier: "hard",
    scoring: "manual",
    prompt:
      'In my GitHub account settings, find whether "Keyboard shortcuts" are enabled under Accessibility, and report the value.',
    startUrl: "https://github.com",
    requiresAuth: true,
  },
  {
    id: "T09",
    slug: "flight-search",
    tier: "hard",
    scoring: "manual",
    prompt:
      "On MakeMyTrip, search one-way flights from Delhi to Mumbai departing 15 days from today, and tell me the cheapest fare shown.",
    startUrl: "https://www.makemytrip.com",
  },
  {
    id: "T10",
    slug: "recovery-gauntlet",
    tier: "recovery",
    scoring: "auto",
    prompt:
      'Search Wikipedia for "Chandrayaan-3" and give me the first paragraph of the article.',
    // Local fixture so the cookie banner and login wall are always present and
    // always identical. Served by `npm run fixtures`.
    startUrl: "http://127.0.0.1:5199/gauntlet/",
    // The article is unreachable until both overlays are gone, so a correct
    // answer is itself the proof. Counting keywords in the reasons only ever
    // produced false negatives on runs that had handled them fine.
    check: (o) => {
      const a = norm(o.answer);
      return (
        o.finalUrl.includes("127.0.0.1:5199") &&
        /chandrayaan/i.test(a) &&
        (/isro/i.test(a) || /lunar/i.test(a)) &&
        a.length >= 150
      );
    },
  },
];

export function taskById(id: string): TaskDefinition | undefined {
  return TASKS.find((t) => t.id.toLowerCase() === id.toLowerCase() || t.slug === id);
}

/** Applies a task's `check`, defending against a predicate that throws. */
export function judge(task: TaskDefinition, outcome: AgentOutcome): boolean {
  if (!task.check) return false;
  try {
    return task.check(outcome);
  } catch {
    return false;
  }
}
