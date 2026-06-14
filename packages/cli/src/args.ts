// Shared CLI arg parsing + global output mode + nearest-match suggestion.
// The router uses this for global flags (--json/--plain), per-command --help, and "did you mean?";
// commands use parseArgs() so flag handling is consistent (and the old per-command off-by-ones are gone).

// ---- global output mode (--json / --plain) ---------------------------------
// json: emit a machine-readable result instead of the TUI (for scripting/CI).
// plain: no spinners/gradients/colors (auto-on when piped, NO_COLOR, or under --json) so logs stay clean.
export const output = { json: false, plain: false };
export function initOutput(args: string[]): void {
  output.json = args.includes("--json");
  output.plain = output.json || args.includes("--plain") || !process.stdout.isTTY || !!process.env.NO_COLOR;
}

// ---- parser ----------------------------------------------------------------
export interface Parsed {
  pos: string[]; // positionals (e.g. a subcommand or a file path)
  flags: Record<string, string>; // --k v  |  --bool -> ""
  multi: Record<string, string[]>; // repeated flags, e.g. --callee a --callee b
  help: boolean; // --help / -h present
  has(name: string): boolean;
  get(name: string, def?: string): string | undefined;
}
// `booleans` never consume a following token (so `qinit up --restart` works as the FIRST arg too).
// `multi` collects repeats. Everything else is `--k v` (or `--k` -> "").
export function parseArgs(args: string[], opts?: { booleans?: string[]; multi?: string[] }): Parsed {
  const booleans = new Set([...(opts?.booleans ?? []), "json", "plain"]);
  const multiKeys = new Set(opts?.multi ?? []);
  const flags: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  const pos: string[] = [];
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") { help = true; continue; }
    if (a.startsWith("--")) {
      const k = a.slice(2);
      let v = "";
      if (!booleans.has(k) && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) v = args[++i];
      if (multiKeys.has(k)) (multi[k] ??= []).push(v);
      else flags[k] = v;
    } else pos.push(a);
  }
  return {
    pos, flags, multi, help,
    has: (n) => n in flags || n in multi,
    get: (n, def) => (n in flags ? flags[n] : def),
  };
}

// ---- nearest match (did-you-mean) ------------------------------------------
function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
// Closest option, but only if it's a plausible typo (edit distance within ~40% of the input length).
export function nearest(input: string, options: string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of options) {
    const dd = lev(input, o);
    if (dd < bestD) { bestD = dd; best = o; }
  }
  return best && bestD <= Math.max(2, Math.ceil(input.length * 0.4)) ? best : undefined;
}
