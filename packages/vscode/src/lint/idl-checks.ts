// IDL-derived diagnostics: cheap structural checks over the REGISTER_*/PUBLIC_* macros that the
// compiler/clangd won't flag (they're protocol semantics, not C++). Pure (no vscode/Bun). Uses the
// `d` regex flag for exact group offsets so diagnostics land on the right token.
import type { QpiFinding } from "./qpi-rules";

// Replace comment bodies with spaces (offsets preserved) so commented-out macros don't false-fire.
export function blankComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (c === "/" && c2 === "/") { while (i < n && src[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && c2 === "*") {
      out += "  "; i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; }
      if (i < n) { out += "  "; i += 2; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

export function idlChecks(source: string): QpiFinding[] {
  const src = blankComments(source);
  const out: QpiFinding[] = [];

  // REGISTER_USER_FUNCTION/PROCEDURE(name, index) — duplicate index within each space is a deploy bug.
  const byKind = { FUNCTION: new Map<number, string>(), PROCEDURE: new Map<number, string>() };
  const registered = new Set<string>();
  for (const m of src.matchAll(/REGISTER_USER_(FUNCTION|PROCEDURE)\s*\(\s*(\w+)\s*,\s*(\d+)\s*\)/gd)) {
    const kind = m[1] as "FUNCTION" | "PROCEDURE";
    const name = m[2];
    const index = Number(m[3]);
    registered.add(name);
    const map = byKind[kind];
    const prev = map.get(index);
    if (prev !== undefined && prev !== name) {
      const [s, e] = m.indices![3];
      out.push({
        rule: kind === "FUNCTION" ? "qpi/dup-fn-index" : "qpi/dup-proc-index",
        message: `Duplicate ${kind.toLowerCase()} index ${index} — already used by \`${prev}\`. Each ${kind.toLowerCase()} needs a unique index.`,
        offset: s, length: e - s, severity: "warn",
      });
    } else if (prev === undefined) {
      map.set(index, name);
    }
  }

  // PUBLIC_FUNCTION/PROCEDURE[_WITH_LOCALS](name) defined but never registered → unreachable on-chain.
  for (const m of src.matchAll(/PUBLIC_(FUNCTION|PROCEDURE)(?:_WITH_LOCALS)?\s*\(\s*(\w+)\s*\)/gd)) {
    const name = m[2];
    if (!registered.has(name)) {
      const [s, e] = m.indices![2];
      out.push({
        rule: "qpi/unregistered",
        message: `\`${name}\` is defined but never registered — add REGISTER_USER_${m[1]}(${name}, <index>) so it's callable on-chain.`,
        offset: s, length: e - s, severity: "warn",
      });
    }
  }

  return out;
}
