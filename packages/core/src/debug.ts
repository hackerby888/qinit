// Opt-in diagnostics for best-effort fallbacks; silent unless QINIT_DEBUG is set.
export function debug(...args: unknown[]): void {
  if (process.env.QINIT_DEBUG) {
    console.error("[qinit:debug]", ...args);
  }
}
