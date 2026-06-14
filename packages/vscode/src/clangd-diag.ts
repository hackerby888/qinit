// Parse `clangd --check` output for REAL code diagnostics.
//
// clangd logs each genuine diagnostic as `E[<ts>] [<code>] Line N: <message>` (e.g.
// `E[00:00:00.001] [undeclared_var_use] Line 19: use of undeclared identifier 'Counter'`). We match
// exactly that shape, on purpose NOT:
//   - `error:` / `fatal error:` — that substring never appears in clangd's diagnostic format, so the
//     gate's original filter matched nothing and silently PASSED contracts with real errors.
//   - the `All checks completed, N errors` summary — N also tallies tweak-availability probes such as
//     SpecialMembers "Class body in wrong file", which are code-action noise present on every
//     contract (the body lives in the .h, not the -include'd prefix), not errors in the source.
const DIAG = /^E\[[\d:.]+\]\s+\[\w+\]\s+Line\s+\d+:/;

export function clangdErrorLines(log: string): string[] {
  return log.split(/\r?\n/).filter((l) => DIAG.test(l));
}

export function clangdErrorCount(log: string): number {
  return clangdErrorLines(log).length;
}
