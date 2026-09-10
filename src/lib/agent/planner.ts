import { makeProvider, type ProviderConfig, type TokenUsage } from "@/lib/provider";
import * as z from "zod";

/**
 * The step the navigator cannot take.
 *
 * A small model choosing one action at a time is good at "what do I click" and
 * bad at "which site holds which fact, and in what order". That gap is what
 * loses a two-site comparison: it searches the first site, leaves without
 * reading the price, and has nothing to compare. A plan written once, up front,
 * and re-written when the run gets stuck, costs two calls and puts that ordering
 * where the navigator can read it every step.
 */
export const PlanSchema = z.object({
  steps: z
    .array(z.string())
    .describe("2 to 5 short imperative steps, in order"),
  watch_out: z.string().describe("the one mistake most likely to ruin this task"),
});

export type Plan = z.infer<typeof PlanSchema>;

const PLANNER_PROMPT = `You break a browser task into a short ordered plan for an agent that can only see one page at a time and only remembers what it writes down.

Write 2 to 5 steps. Each is one short imperative sentence.
Name the sites and the facts explicitly. If the task needs a fact from more than one site, say which fact comes from which site, and say it must be written down before moving on — the agent cannot go back.
Do not describe clicking or scrolling. That is the agent's job, not yours.
watch_out is the single mistake most likely to ruin this particular task.`;

export interface PlanInput {
  config: ProviderConfig;
  task: string;
  /** The page the run starts on, so the plan is not written blind. */
  startUrl: string;
  /** Set when replanning after the run got stuck, so the plan can change. */
  trouble?: string;
  signal?: AbortSignal;
}

export interface PlanResult extends Plan {
  usage: TokenUsage;
  requestMs: number;
}

export async function makePlan(input: PlanInput): Promise<PlanResult> {
  const result = await makeProvider(input.config).complete({
    messages: [
      { role: "system", content: PLANNER_PROMPT },
      {
        role: "user",
        content: [
          `TASK\n${input.task.trim()}`,
          `STARTING PAGE\n${input.startUrl || "(a blank tab)"}`,
          ...(input.trouble
            ? [`WHAT WENT WRONG WITH THE LAST PLAN\n${input.trouble}\nWrite a different plan.`]
            : []),
        ].join("\n\n"),
      },
    ],
    schema: PlanSchema,
    schemaName: "plan",
    maxTokens: 400,
    signal: input.signal,
  });

  return { ...result.data, usage: result.usage, requestMs: result.requestMs };
}
