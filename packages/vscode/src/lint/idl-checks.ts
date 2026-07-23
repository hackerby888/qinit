import type { QpiFinding } from "./qpi-rules";

export function blankComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i],
      c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && c2 === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function idlChecks(source: string): QpiFinding[] {
  const src = blankComments(source);
  const out: QpiFinding[] = [];

  const byKind = { FUNCTION: new Map<number, string>(), PROCEDURE: new Map<number, string>() };
  const registered = new Set<string>();
  for (const m of src.matchAll(
    /REGISTER_USER_(FUNCTION|PROCEDURE)\s*\(\s*(\w+)\s*,\s*(\d+)\s*\)/dg,
  )) {
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
        offset: s,
        length: e - s,
        severity: "warn",
      });
    } else if (prev === undefined) {
      map.set(index, name);
    }
  }

  const publicNames = new Set<string>();
  for (const m of src.matchAll(
    /PUBLIC_(FUNCTION|PROCEDURE)(?:_WITH_LOCALS)?\s*\(\s*(\w+)\s*\)/dg,
  )) {
    const name = m[2];
    publicNames.add(name);
    if (!registered.has(name)) {
      const [s, e] = m.indices![2];
      out.push({
        rule: "qpi/unregistered",
        message: `\`${name}\` is defined but never registered — add REGISTER_USER_${m[1]}(${name}, <index>) so it's callable on-chain.`,
        offset: s,
        length: e - s,
        severity: "warn",
      });
    }
  }

  // Public codecs cannot contain containers with internal hash or list state.
  const FORBIDDEN = /\b(Collection|LinkedList|HashMap|HashSet)\b/g;
  for (const m of src.matchAll(/\bstruct\s+(\w+)_(input|output)\b\s*\{/g)) {
    if (!publicNames.has(m[1])) continue; // only the PUBLIC interface
    let depth = 1,
      i = m.index! + m[0].length;
    const bodyStart = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    const body = src.slice(bodyStart, Math.max(bodyStart, i - 1));
    let f: RegExpExecArray | null;
    FORBIDDEN.lastIndex = 0;
    while ((f = FORBIDDEN.exec(body))) {
      out.push({
        rule: "qpi/public-complex-type",
        message: `\`${f[1]}\` is forbidden in the public interface (\`${m[1]}_${m[2]}\`) — complex types can carry inconsistent internal state across the call boundary. Use scalars, \`id\`, \`Array\`, or \`BitArray\`.`,
        offset: bodyStart + f.index,
        length: f[1].length,
        severity: "warn",
      });
    }
  }

  return out;
}
