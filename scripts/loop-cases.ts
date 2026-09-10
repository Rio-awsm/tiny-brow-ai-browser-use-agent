/**
 * Scripted-model tests for the agent loop.
 *
 * The model is replaced with a list of replies and the browser with a page that
 * only changes when a case says it does. That leaves the loop's own judgement —
 * when to push back, when to give up, what to answer with — as the only thing
 * under test.
 */
import { detectAuthWall } from "../src/lib/agent/index";
import { runLoop, type ExecuteResult, type RunOutcome } from "../src/lib/agent/loop";
import type { AgentAction } from "../src/lib/agent/schema";
import type { PageIndex } from "../src/lib/page-index";

type Reply = Partial<AgentAction> & { action: AgentAction["action"] };

const config = {
  preset: "test",
  baseUrl: "http://model.test/v1",
  apiKey: "k",
  model: "scripted",
  extraParams: {},
  maxTokens: 1024,
  temperature: 0,
};

function page(url: string, over: Partial<PageIndex> = {}): PageIndex {
  return {
    url,
    title: "t",
    elements: [
      { i: 0, tag: "input", role: "textbox", label: "Search", x: 0, y: 0, w: 10, h: 10, inViewport: true, frame: "", note: "" },
      { i: 1, tag: "button", role: "button", label: "Go", x: 0, y: 0, w: 10, h: 10, inViewport: true, frame: "", note: "" },
    ],
    totalFound: 2,
    viewport: { w: 1000, h: 800, scrollX: 0, scrollY: 0, docH: 2000 },
    text: "page text",
    textChars: 9,
    tookMs: 1,
    ...over,
  };
}

interface Case {
  name: string;
  replies: Reply[];
  /** Off-schema HTTP replies to serve before the scripted ones. */
  flakes?: number;
  page?: () => PageIndex;
  execute?: () => ExecuteResult;
  expect: (out: RunOutcome, prompts: string[]) => string | true;
}

const ok = (out: RunOutcome) => out.status === "done";

const cases: Case[] = [
  {
    name: "several facts accumulate and are answered together",
    replies: [
      { action: "extract", value: "Dell WM118, Rs 674" },
      { action: "extract", value: "Zebronics Zeb-Comfort, Rs 399" },
      { action: "extract", value: "Ant Globe 35, Rs 549" },
      { action: "done", value: "Dell 674, Zebronics 399, Ant Globe 549" },
    ],
    expect: (o) =>
      (ok(o) && /674/.test(o.answer) && /399/.test(o.answer) && /549/.test(o.answer)) ||
      `status ${o.status} answer ${o.answer}`,
  },
  {
    name: "the second decision can read the first fact back",
    replies: [
      { action: "extract", value: "first fact" },
      { action: "extract", value: "second fact" },
      { action: "done", value: "both" },
    ],
    expect: (_o, prompts) =>
      /NOTES\n1\. first fact/.test(prompts[1]) ||
      `notes block missing from step 2:\n${prompts[1]?.slice(0, 400)}`,
  },
  {
    name: "re-extracting is challenged, not obeyed",
    replies: [
      { action: "extract", value: "the price is 674" },
      { action: "extract", value: "the price is 674" },
      { action: "done", value: "674" },
    ],
    expect: (o) => (ok(o) && o.answer === "674") || `status ${o.status} answer ${o.answer}`,
  },
  {
    name: "insisting answers from every note, not the repeated one",
    replies: [
      { action: "extract", value: "fact one" },
      { action: "extract", value: "fact two" },
      { action: "extract", value: "fact two" },
      { action: "extract", value: "fact two" },
    ],
    expect: (o) =>
      (ok(o) && /fact one/.test(o.answer) && /fact two/.test(o.answer)) ||
      `status ${o.status} answer ${o.answer}`,
  },
  {
    name: "an empty extract is rejected",
    replies: [
      { action: "extract", value: "" },
      { action: "extract", value: "a real fact" },
      { action: "done", value: "a real fact" },
    ],
    expect: (o) => (ok(o) && o.steps === 3) || `status ${o.status} steps ${o.steps}`,
  },
  {
    name: "done with an empty value still returns the work",
    replies: [
      { action: "extract", value: "the answer is 42" },
      { action: "done", value: "" },
    ],
    expect: (o) => (ok(o) && /42/.test(o.answer)) || `answer ${JSON.stringify(o.answer)}`,
  },
  {
    name: "a dead element is named and forbidden before anything is handed over",
    replies: [
      { action: "click", index: 1 },
      { action: "click", index: 1 },
      { action: "click", index: 0 },
      { action: "done", value: "carried on" },
    ],
    expect: (o, prompts) =>
      (ok(o) && /Element \[1\] did nothing/.test(prompts[2] ?? "")) ||
      `status ${o.status}\n${prompts[2]?.slice(-300)}`,
  },
  {
    name: "but clicking in circles is still handed over",
    replies: Array.from({ length: 8 }, () => ({ action: "click" as const, index: 1 })),
    expect: (o) => o.status === "needs_user" || `status ${o.status}`,
  },
  {
    name: "a scroll that moves the page is not a repeat",
    replies: [
      ...Array.from({ length: 4 }, () => ({ action: "scroll" as const, direction: "down" as const })),
      { action: "done" as const, value: "found it" },
    ],
    page: (() => {
      let y = 0;
      return () =>
        page("https://x.test/", {
          viewport: { w: 1000, h: 800, scrollX: 0, scrollY: (y += 600), docH: 9000 },
        });
    })(),
    expect: (o) => ok(o) || `status ${o.status}`,
  },
  {
    name: "giving up early is challenged once",
    replies: [
      { action: "fail", value: "not on Flipkart, I should go back to Amazon" },
      { action: "extract", value: "Amazon price Rs 795" },
      { action: "done", value: "Amazon Rs 795" },
    ],
    expect: (o) => (ok(o) && /795/.test(o.answer)) || `status ${o.status} answer ${o.answer}`,
  },
  {
    name: "a second give-up is believed",
    replies: [
      { action: "fail", value: "no" },
      { action: "fail", value: "genuinely nothing left" },
    ],
    expect: (o) => o.status === "failed" || `status ${o.status}`,
  },
  {
    name: "one off-schema reply is retried, not fatal",
    flakes: 1,
    replies: [{ action: "done", value: "recovered" }],
    expect: (o) => (ok(o) && o.answer === "recovered") || `status ${o.status} ${o.error ?? ""}`,
  },
  {
    name: "a run of off-schema replies still fails",
    flakes: 9,
    replies: [{ action: "done", value: "unreachable" }],
    expect: (o) => o.failure === "schema_invalid" || `status ${o.status} failure ${o.failure}`,
  },
  {
    name: "a real sign-in page still stops",
    replies: [{ action: "click", index: 1 }],
    page: () => page("https://accounts.google.com/signin"),
    expect: (o) => o.status === "needs_user" || `status ${o.status}`,
  },
];

async function run(c: Case): Promise<string | true> {
  const prompts: string[] = [];
  let call = 0;
  let flakesLeft = c.flakes ?? 0;

  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
    prompts.push(body.messages.map((m) => m.content).join("\n\n"));

    const content =
      flakesLeft-- > 0
        ? JSON.stringify({ nonsense: true })
        : JSON.stringify({
            index: null,
            value: null,
            direction: null,
            reason: "because",
            ...c.replies[Math.min(call++, c.replies.length - 1)],
          });

    return new Response(
      JSON.stringify({
        model: "scripted",
        choices: [{ finish_reason: "stop", message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const out = await runLoop({
    task: "a task",
    config,
    stepCap: 12,
    signal: new AbortController().signal,
    maxRateLimitRetries: 3,
    detectWall: detectAuthWall,
    readPage: async () => (c.page ?? (() => page("https://x.test/")))(),
    execute: async () => c.execute?.() ?? { ok: true, summary: "acted" },
    onStepStart: () => {},
    onProposal: () => {},
    onStepEnd: () => {},
    onAsk: async () => ({ action: "stop" as const, note: "" }),
    sleep: async () => {},
  });

  return c.expect(out, prompts);
}

let failed = 0;
for (const c of cases) {
  const verdict = await run(c);
  if (verdict === true) {
    console.log(`  ok   ${c.name}`);
  } else {
    failed++;
    console.log(`  FAIL ${c.name}\n       ${verdict}`);
  }
}
console.log(failed ? `\n${failed} failing` : `\nall ${cases.length} pass`);
process.exit(failed ? 1 : 0);
