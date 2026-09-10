import * as z from "zod";
import type { IndexedElement } from "@/lib/page-index";

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
  action: z.enum([
    "click",
    "type",
    "scroll",
    "navigate",
    "extract",
    "ask",
    "done",
    "fail",
  ]),
  index: z
    .number()
    .int()
    .nullable()
    .describe("element number from ELEMENTS, for click and type; otherwise null"),
  value: z
    .string()
    .nullable()
    .describe(
      "text to type, URL to navigate to, the question for ask, or the answer for extract/done/fail; otherwise null",
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
    case "ask":
      return `ask: ${action.value ?? ""}`;
    case "done":
      return `done: ${action.value ?? ""}`;
    case "fail":
      return `fail: ${action.value ?? ""}`;
  }
}

export interface ActionProblem {
  message: string;
}

/** Fields no agent may ever fill in, whatever the page or the prompt says. */
const SECRET_FIELD = /password|passcode|\botp\b|\bpin\b|one[- ]?time|\bcvv\b|\bcvc\b|security code|card number|credit card/i;

/**
 * Checks the parts a JSON schema cannot express: that an index exists, that the
 * fields an action needs are populated, and that the target is something the
 * agent is allowed to touch.
 *
 * Schema-constrained decoding guarantees the shape, never the meaning. The
 * secret-field refusal is here, in code, rather than as a prompt rule — model
 * instructions get forgotten under long context and code does not.
 */
export function validateAction(
  action: AgentAction,
  elements: IndexedElement[],
): ActionProblem | null {
  const needsIndex = action.action === "click" || action.action === "type";
  const indexSize = elements.length;

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

  if (action.action === "type" && action.index !== null) {
    const target = elements[action.index];
    const describes = `${target?.role ?? ""} ${target?.note ?? ""} ${target?.label ?? ""}`;
    if (target && SECRET_FIELD.test(describes)) {
      return {
        message:
          `[${action.index}] is a secret field (${target.label || target.role}). ` +
          "Tiny never types passwords, PINs, OTPs or card details — use ask so the user can type it.",
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
  if (action.action === "ask" && !action.value) {
    return { message: "ask needs a question for the user, but value was null" };
  }

  return null;
}

/** Actions the agent completes on, rather than continuing. */
export function isTerminal(action: AgentAction): boolean {
  return action.action === "done" || action.action === "fail";
}
