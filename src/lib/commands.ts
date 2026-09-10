export type TypeMode = "insert" | "keys";

export type Command =
  | { kind: "click"; index: number }
  | { kind: "type"; index: number; text: string; mode: TypeMode }
  | { kind: "key"; name: string }
  | { kind: "scroll"; direction: "up" | "down"; amount: number }
  | { kind: "goto"; url: string }
  | { kind: "index" }
  | { kind: "help" };

export type Parsed =
  | { ok: true; command: Command; summary: string }
  | { ok: false; error: string };

export interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
  /** Present for keys that produce a character; absent for pure control keys. */
  text?: string;
}

export const KEYS: Record<string, KeySpec> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9, text: "\t" },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  ret: "enter",
  return: "enter",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  del: "delete",
  bs: "backspace",
};

export function resolveKey(name: string): KeySpec | null {
  const k = name.toLowerCase();
  return KEYS[KEY_ALIASES[k] ?? k] ?? null;
}

const VERBS = ["click", "type", "key", "scroll", "goto", "index", "help"];

export const COMMAND_HELP = [
  "click N              click element N",
  "type N <text>        focus element N and type",
  "type -k N <text>     type per keystroke (fires autocomplete)",
  "key <name>           Enter, Tab, Escape, ArrowDown, …",
  "scroll up|down [px]  wheel the page",
  "goto <url>           navigate this tab",
  "index                rebuild the element index",
].join("\n");

/**
 * Parses a command, or returns null when the text is not one.
 *
 * A leading `/` always means "this is a command", so mistakes are reported
 * rather than silently sent to the agent. Without the prefix the grammar has to
 * match strictly — `click 7` is a command, `click the login button` is a task.
 * Without that rule every sentence starting with a verb would be swallowed.
 */
export function parseCommand(input: string): Parsed | null {
  const raw = input.trim();
  if (!raw) return null;

  const explicit = raw.startsWith("/");
  const body = explicit ? raw.slice(1).trim() : raw;

  const [verb = "", ...rest] = body.split(/\s+/);
  const lower = verb.toLowerCase();

  if (!VERBS.includes(lower)) {
    return explicit
      ? { ok: false, error: `unknown command "${verb}" — try /help` }
      : null;
  }

  const fail = (error: string): Parsed | null => (explicit ? { ok: false, error } : null);

  switch (lower) {
    case "help":
      return { ok: true, command: { kind: "help" }, summary: "show commands" };

    case "index":
      return { ok: true, command: { kind: "index" }, summary: "rebuild the index" };

    case "click": {
      const index = toIndex(rest[0]);
      if (index === null) return fail("click needs an element number, e.g. /click 7");
      if (rest.length > 1) return fail(`click takes one number, got "${rest.join(" ")}"`);
      return { ok: true, command: { kind: "click", index }, summary: `click [${index}]` };
    }

    case "type": {
      let args = rest;
      let mode: TypeMode = "insert";
      if (args[0] === "-k" || args[0] === "--keys") {
        mode = "keys";
        args = args.slice(1);
      }
      const index = toIndex(args[0]);
      if (index === null) return fail("type needs an element number, e.g. /type 3 hello");

      // Re-split off the original string so runs of spaces inside the text survive.
      const text = sliceAfterToken(body, args[0]!);
      if (!text) return fail("type needs something to type, e.g. /type 3 hello");

      return {
        ok: true,
        command: { kind: "type", index, text, mode },
        summary: `type ${JSON.stringify(text)} into [${index}]${mode === "keys" ? " per key" : ""}`,
      };
    }

    case "key": {
      const name = rest[0];
      if (!name) return fail("key needs a name, e.g. /key Enter");
      const spec = resolveKey(name);
      if (!spec) {
        return fail(`unknown key "${name}" — known: ${Object.keys(KEYS).join(", ")}`);
      }
      return { ok: true, command: { kind: "key", name: spec.key }, summary: `press ${spec.key}` };
    }

    case "scroll": {
      const dir = (rest[0] ?? "down").toLowerCase();
      if (dir !== "up" && dir !== "down") return fail('scroll takes "up" or "down"');
      const amount = rest[1] ? Number(rest[1]) : 500;
      if (!Number.isFinite(amount) || amount <= 0) {
        return fail(`scroll amount must be a positive number, got "${rest[1]}"`);
      }
      return {
        ok: true,
        command: { kind: "scroll", direction: dir, amount },
        summary: `scroll ${dir} ${amount}px`,
      };
    }

    case "goto": {
      const url = normaliseUrl(rest.join(" "));
      if (!url) return fail("goto needs a URL, e.g. /goto example.com");
      return { ok: true, command: { kind: "goto", url }, summary: `go to ${url}` };
    }
  }

  return null;
}

function toIndex(token: string | undefined): number | null {
  if (token === undefined || !/^\d+$/.test(token)) return null;
  return Number(token);
}

/** Everything after the first occurrence of `token`, verbatim. */
function sliceAfterToken(body: string, token: string): string {
  const at = body.indexOf(token);
  if (at === -1) return "";
  return body.slice(at + token.length).replace(/^\s/, "");
}

function normaliseUrl(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    return new URL(withScheme).href;
  } catch {
    return null;
  }
}
