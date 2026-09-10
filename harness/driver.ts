/**
 * Drivers: the seam between the scoring harness and whatever is actually
 * driving a browser.
 *
 * M0 ships two, and neither touches a browser or a model:
 *
 *   stub   — every attempt fails with `not_implemented`. This is the honest
 *            state of the project and it is what proves the harness runs
 *            end to end before any agent exists.
 *   oracle — every auto-scored task returns a hand-written correct answer.
 *            Nothing to do with the agent; it exists so a green run can be
 *            distinguished from a harness that is scoring everything `fail`
 *            because the `check` predicates are broken. Without it, "all
 *            fail" is unfalsifiable.
 *
 * From M9 the real loop implements the same `AgentDriver` interface and no
 * scoring code changes.
 */

import type {
  AgentDriver,
  AgentOutcome,
  DriveOptions,
  StepRecord,
} from "./types.js";

const noUsage = { prompt: 0, completion: 0 } as const;

export class StubDriver implements AgentDriver {
  readonly name = "stub";

  async drive({ task }: DriveOptions): Promise<AgentOutcome> {
    return {
      answer: "",
      completed: false,
      finalUrl: task.startUrl ?? "",
      steps: [],
      failure: "not_implemented",
      error: "no agent yet — the loop arrives in M9",
    };
  }
}

/**
 * Canned correct answers, one per auto-scored task. These are fixtures for the
 * scorer, not expectations of the agent: their only job is to make each
 * `check` predicate return true so a broken predicate is visible immediately.
 */
const ORACLE: Record<string, Omit<AgentOutcome, "steps">> = {
  T01: {
    answer: "The page title is: Example Domain",
    completed: true,
    finalUrl: "https://example.com/",
  },
  T02: {
    answer:
      "Chandrayaan-3 is the third lunar exploration mission under the Indian Space " +
      "Research Organisation's (ISRO) Chandrayaan programme. It consists of a " +
      "lander named Vikram and a rover named Pragyan, similar to those on " +
      "Chandrayaan-2. Launched on 14 July 2023, the lander touched down near the " +
      "lunar south pole on 23 August 2023, making India the fourth country to " +
      "achieve a soft landing on the Moon.",
    completed: true,
    finalUrl: "https://en.wikipedia.org/wiki/Chandrayaan-3",
  },
  T03: {
    answer:
      'Form submitted. The response was: { "form": { "custname": "Test User", ' +
      '"custtel": "5551234567", "size": "large", "topping": "bacon" } }',
    completed: true,
    finalUrl: "https://httpbin.org/post",
  },
  T04: {
    answer: "The first three results are listed below.",
    data: [
      { title: "Logitech M235 Wireless Mouse", price: "₹795" },
      { title: "Dell MS116 Optical Wireless Mouse", price: "₹549" },
      { title: "HP X200 Wireless Mouse", price: "₹649" },
    ],
    completed: true,
    finalUrl: "https://www.amazon.in/s?k=wireless+mouse",
  },
  T07: {
    answer:
      "On Amazon.in the Logitech M235 is ₹795. On Flipkart it is ₹749. " +
      "Flipkart is cheaper, by ₹46.",
    completed: true,
    finalUrl: "https://www.flipkart.com/search?q=logitech+m235",
  },
  T10: {
    answer:
      "Chandrayaan-3 is the third lunar exploration mission under the Indian Space " +
      "Research Organisation's (ISRO) Chandrayaan programme, consisting of a lander " +
      "named Vikram and a rover named Pragyan. It launched on 14 July 2023 and the " +
      "lander touched down near the lunar south pole on 23 August 2023.",
    completed: true,
    finalUrl: "https://en.wikipedia.org/wiki/Chandrayaan-3",
  },
};

/** Step log the oracle reports for T10, whose check inspects the steps. */
const ORACLE_STEPS: Record<string, StepRecord[]> = {
  T10: [
    {
      n: 1,
      url: "http://127.0.0.1:5199/gauntlet/",
      action: "click(3)",
      reason: "Accept the cookie banner so it stops covering the page",
      indexSize: 4,
      usage: noUsage,
      requestMs: 0,
    },
    {
      n: 2,
      url: "http://127.0.0.1:5199/gauntlet/",
      action: "click(1)",
      reason: "Dismiss the login wall overlay",
      indexSize: 6,
      usage: noUsage,
      requestMs: 0,
    },
  ],
};

export class OracleDriver implements AgentDriver {
  readonly name = "oracle";

  async drive({ task }: DriveOptions): Promise<AgentOutcome> {
    const canned = ORACLE[task.id];
    if (!canned) {
      // Manual-scored tasks have no oracle; the operator judges those.
      return {
        answer: "(no oracle answer — this task is scored manually)",
        completed: true,
        finalUrl: task.startUrl ?? "",
        steps: [],
      };
    }
    return { ...canned, steps: ORACLE_STEPS[task.id] ?? [] };
  }
}

export const DRIVERS: Record<string, () => AgentDriver> = {
  stub: () => new StubDriver(),
  oracle: () => new OracleDriver(),
};

export function makeDriver(name: string): AgentDriver {
  const factory = DRIVERS[name];
  if (!factory) {
    throw new Error(
      `unknown driver "${name}" — available: ${Object.keys(DRIVERS).join(", ")}`,
    );
  }
  return factory();
}
