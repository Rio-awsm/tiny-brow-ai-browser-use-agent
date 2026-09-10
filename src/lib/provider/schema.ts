import * as z from "zod";

/**
 * Turns a Zod schema into the JSON Schema sent on the wire.
 *
 * Defining it once is the point: the schema the provider constrains decoding
 * with and the schema the response is validated against cannot drift apart,
 * because they are the same object.
 */
export function toWireSchema(schema: z.ZodType, name: string): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
    unrepresentable: "throw",
  }) as Record<string, unknown>;

  const problems = strictModeProblems(json);
  if (problems.length) {
    throw new Error(
      `schema "${name}" is not usable with strict mode:\n  ${problems.join("\n  ")}`,
    );
  }
  return json;
}

/**
 * Strict mode has two rules that are easy to break by accident and produce a
 * provider-side 400 rather than a local error: every object must forbid
 * additional properties, and every declared property must be required.
 *
 * `.optional()` is the usual culprit — it drops a field out of `required`. Use
 * a nullable field instead, so the shape stays fixed and the model says "null".
 */
export function strictModeProblems(node: unknown, path = "root"): string[] {
  if (typeof node !== "object" || node === null) return [];

  const problems: string[] = [];
  const schema = node as Record<string, unknown>;

  if (schema.type === "object") {
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    const keys = Object.keys(properties);

    if (schema.additionalProperties !== false) {
      problems.push(`${path}: needs "additionalProperties": false`);
    }

    const required = new Set((schema.required as string[] | undefined) ?? []);
    const missing = keys.filter((k) => !required.has(k));
    if (missing.length) {
      problems.push(
        `${path}: every property must be required, missing ${missing.join(", ")} — ` +
          `use .nullable() rather than .optional()`,
      );
    }

    for (const key of keys) {
      problems.push(...strictModeProblems(properties[key], `${path}.${key}`));
    }
  }

  if (schema.items) problems.push(...strictModeProblems(schema.items, `${path}[]`));

  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branch = schema[key];
    if (Array.isArray(branch)) {
      branch.forEach((b, i) => problems.push(...strictModeProblems(b, `${path}.${key}[${i}]`)));
    }
  }

  return problems;
}

/** The tiny schema behind "Test connection". */
export const ProbeSchema = z.object({
  ok: z.literal(true).describe("always true"),
  word: z.string().describe("the single word: tiny"),
});

export type Probe = z.infer<typeof ProbeSchema>;
