import * as z from "zod";

/**
 * The action schema. Defined once; the wire schema and the runtime check both
 * derive from it.
 *
 * Seven verbs and no more. Every extra verb is another thing the model can pick
 * wrongly, and an `enum` on the name is what stops it inventing one outright.
 *
 * Every field is required, with `null` where an action does not use it —
 * `.optional()` would drop the field out of `required`, which strict mode
 * rejects. A fixed shape also means the model never has to decide whether to
 * include a key.
 */
export const ActionSchema = z.object({
  action: z.enum(["click", "type", "scroll", "navigate", "extract", "done", "fail"]),
  index: z
    .number()
    .int()
    .nullable()
    .describe("element number from ELEMENTS, for click and type; otherwise null"),
  value: z
    .string()
    .nullable()
    .describe(
      "text to type, URL to navigate to, or the answer for extract/done/fail; otherwise null",
    ),
  direction: z
    .enum(["up", "down"])
    .nullable()
    .describe("for scroll; otherwise null"),
  reason: z.string().describe("one short sentence explaining this choice"),
});

export type AgentAction = z.infer<typeof ActionSchema>;

/** Human-readable one-liner for the transcript and the history block. */
export function describeAction(action: AgentAction): string {
  switch (action.action) {
    case "click":
      return `click [${action.index}]`;
    case "type":
      return `type ${JSON.stringify(action.value ?? "")} into [${action.index}]`;
    case "scroll":
      return `scroll ${action.direction ?? "down"}`;
    case "navigate":
      return `navigate to ${action.value ?? ""}`;
    case "extract":
      return `extract: ${action.value ?? ""}`;
    case "done":
      return `done: ${action.value ?? ""}`;
    case "fail":
      return `fail: ${action.value ?? ""}`;
  }
}

export interface ActionProblem {
  message: string;
}

/**
 * Checks the parts a JSON schema cannot express: that an index actually exists
 * in the current index, and that the fields an action needs are populated.
 *
 * Schema-constrained decoding guarantees the shape, never the meaning.
 */
export function validateAction(action: AgentAction, indexSize: number): ActionProblem | null {
  const needsIndex = action.action === "click" || action.action === "type";

  if (needsIndex) {
    if (action.index === null) {
      return { message: `${action.action} needs an element number, but index was null` };
    }
    if (action.index < 0 || action.index >= indexSize) {
      return {
        message:
          indexSize === 0
            ? `[${action.index}] was chosen but the page has no listed elements`
            : `[${action.index}] is not in the index — valid numbers are 0-${indexSize - 1}`,
      };
    }
  }

  if (action.action === "type" && !action.value) {
    return { message: "type needs the text to type, but value was null" };
  }
  if (action.action === "navigate" && !action.value) {
    return { message: "navigate needs a URL, but value was null" };
  }
  if (action.action === "scroll" && action.direction === null) {
    return { message: "scroll needs a direction, but it was null" };
  }
  if ((action.action === "done" || action.action === "fail") && !action.value) {
    return { message: `${action.action} needs an answer, but value was null` };
  }

  return null;
}

/** Actions the agent completes on, rather than continuing. */
export function isTerminal(action: AgentAction): boolean {
  return action.action === "done" || action.action === "fail";
}
