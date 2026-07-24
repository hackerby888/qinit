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

export function parseArgs(
  args: string[],
  options?: { booleans?: string[]; multi?: string[] },
): Parsed {
  const booleans = new Set([...(options?.booleans ?? []), "json", "plain"]);
  const multiKeys = new Set(options?.multi ?? []);
  const flags: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  const pos: string[] = [];
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      pos.push(arg);
      continue;
    }

    const key = arg.slice(2);
    let value = "";
    const nextArg = args[i + 1];
    if (
      !booleans.has(key) &&
      nextArg !== undefined &&
      !nextArg.startsWith("--")
    ) {
      value = nextArg;
      i++;
    }

    if (multiKeys.has(key)) {
      (multi[key] ??= []).push(value);
    } else {
      flags[key] = value;
    }
  }

  return {
    pos,
    flags,
    multi,
    help,
    has: (name) => name in flags || name in multi,
    get: (name, defaultValue) => (name in flags ? flags[name] : defaultValue),
  };
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
