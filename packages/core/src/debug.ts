// Opt-in diagnostic logging: silent by default, prints to stderr only when QINIT_DEBUG is set. Lets the
// many best-effort `catch {}` sites record WHY they fell back (node down vs transient vs malformed JSON)
export function debug(...args: unknown[]): void {
  if (process.env.QINIT_DEBUG) console.error("[qinit:debug]", ...args);
}
