import { parseArgs as parseNodeArgs } from "node:util";

export const output = { json: false, plain: false };

export function initOutput(args: string[]): void {
  output.json = args.includes("--json");
  output.plain =
    output.json ||
    args.includes("--plain") ||
    !process.stdout.isTTY ||
    !!process.env.NO_COLOR;
}

export interface Parsed {
  pos: string[];
  flags: Record<string, string>;
  multi: Record<string, string[]>;
  help: boolean;
  has(name: string): boolean;
  get(name: string, def?: string): string | undefined;
}

interface ParseOptions {
  strings?: readonly string[];
  booleans?: readonly string[];
  multi?: readonly string[];
}

export function parseArgs(
  args: string[],
  options: ParseOptions = {},
): Parsed {
  const definitions: Record<
    string,
    { type: "string" | "boolean"; multiple?: boolean; short?: string }
  > = {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    plain: { type: "boolean" },
  };

  for (const name of options.strings ?? []) {
    definitions[name] = { type: "string" };
  }
  for (const name of options.booleans ?? []) {
    definitions[name] = { type: "boolean" };
  }
  for (const name of options.multi ?? []) {
    definitions[name] = { type: "string", multiple: true };
  }

  const { values, positionals } = parseNodeArgs({
    args,
    options: definitions,
    allowPositionals: true,
    strict: true,
  });

  const flags: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(values)) {
    if (name === "help" || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      multi[name] = value.map(String);
    } else {
      flags[name] = typeof value === "boolean" ? "" : String(value);
    }
  }

  return {
    pos: positionals,
    flags,
    multi,
    help: values.help === true,
    has: (name) => name in flags || name in multi,
    get: (name, defaultValue) => (name in flags ? flags[name] : defaultValue),
  };
}

export function invalidArgs(message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = "ERR_PARSE_ARGS_INVALID_POSITIONAL";
  throw error;
}

function editDistance(left: string, right: string): number {
  const leftLength = left.length;
  const rightLength = right.length;
  const distances: number[][] = Array.from(
    { length: leftLength + 1 },
    () => new Array(rightLength + 1).fill(0),
  );

  for (let i = 0; i <= leftLength; i++) {
    distances[i][0] = i;
  }
  for (let j = 0; j <= rightLength; j++) {
    distances[0][j] = j;
  }

  for (let i = 1; i <= leftLength; i++) {
    for (let j = 1; j <= rightLength; j++) {
      distances[i][j] = Math.min(
        distances[i - 1][j] + 1,
        distances[i][j - 1] + 1,
        distances[i - 1][j - 1] +
          (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
  }

  return distances[leftLength][rightLength];
}

export function nearest(input: string, options: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;

  for (const option of options) {
    const distance = editDistance(input, option);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = option;
    }
  }

  const threshold = Math.max(2, Math.ceil(input.length * 0.4));
  return best && bestDistance <= threshold ? best : undefined;
}
