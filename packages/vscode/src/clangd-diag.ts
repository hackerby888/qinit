// Parse `clangd --check` output for REAL code diagnostics.
//
const DIAG = /^E\[[\d:.]+\]\s+\[\w+\]\s+Line\s+\d+:/;

export function clangdErrorLines(log: string): string[] {
  return log.split(/\r?\n/).filter((l) => DIAG.test(l));
}

export function clangdErrorCount(log: string): number {
  return clangdErrorLines(log).length;
}
