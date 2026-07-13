// Pure quick-fix transforms for Tier-A findings (no vscode). Each returns the replacement text for a
// single line, or null when the line doesn't match the expected shape — so the editor only offers the
import { enclosingFunction, blankCommentsAndStrings } from "./lint/qpi-rules";

export interface SourceEdit {
  start: number;
  end: number;
  newText: string;
} // [start,end) -> newText; start==end inserts

// `<type> <name>[<size>];`  ->  `Array<<type>, <size>> <name>;`  (a member array declaration).
// Bails on multi-var decls / nested brackets so it never mangles ambiguous lines.
export function arrayFixForLine(line: string): string | null {
  const m = line.match(
    /^(\s*)([A-Za-z_][\w:<>,\s]*?)\s+([A-Za-z_]\w*)\s*\[\s*([^\]]+?)\s*\]\s*;(.*)$/,
  );
  if (!m) return null;
  const [, indent, type, name, size, tail] = m;
  if (/[\[\],]/.test(type)) return null; // multi-var or already array-ish — don't touch
  return `${indent}Array<${type.trim()}, ${size.trim()}> ${name};${tail}`;
}

const OPERAND = "[A-Za-z_]\\w*(?:\\.\\w+)*|\\d+"; // identifier / dotted member / integer literal

// `a / b` -> `div(a, b)` and `a % b` -> `mod(a, b)`, for qpi/no-division / qpi/no-modulo. `col` is the
// operator's column on `line`. CONSERVATIVE: only when both operands are simple primaries (so `/` `%`'s
export function divModFixForLine(
  line: string,
  col: number,
  op: "/" | "%",
): { start: number; end: number; text: string } | null {
  if (line[col] !== op || line[col + 1] === "=" || line[col + 1] === op || line[col - 1] === op)
    return null; // not a bare binary op
  const left = line.slice(0, col).match(new RegExp(`(${OPERAND})\\s*$`));
  const right = line.slice(col + 1).match(new RegExp(`^\\s*(${OPERAND})`));
  if (!left || !right) return null;
  const start = col - left[0].length; // left operand start (left[0] = operand + trailing ws)
  const end = col + 1 + right[0].length; // right operand end   (right[0] = leading ws + operand)
  if (/[.)\]>]/.test(line[start - 1] ?? "")) return null; // left operand is the tail of a bigger expr
  if (/[.(\[]/.test(line[end] ?? "")) return null; // right operand continues into a call/member
  return { start, end, text: `${op === "/" ? "div" : "mod"}(${left[1]}, ${right[1]})` };
}

const TYPE_RE = "[A-Za-z_]\\w*(?:::[A-Za-z_]\\w*)*(?:\\s*<(?:[^<>]|<[^<>]*>)*>)?"; // mirrors the lexer's TYPE

// Move a flagged stack local (qpi/stack-local) into its function's `<fn>_locals` struct: switch the
// macro to *_WITH_LOCALS, create or extend `struct <fn>_locals`, drop the declaration (keeping any
export function moveLocalToWithLocalsEdits(
  source: string,
  nameOffset: number,
  nameLength: number,
): SourceEdit[] | null {
  const fn = enclosingFunction(source, nameOffset);
  if (!fn || !fn.name) return null;
  const v = source.slice(nameOffset, nameOffset + nameLength);
  if (!/^[A-Za-z_]\w*$/.test(v)) return null;

  // the declaration head: `<TYPE> <v>` ending exactly at the name
  const before = source.slice(0, nameOffset);
  const typeM = before.match(new RegExp(`(${TYPE_RE})\\s+$`));
  if (!typeM) return null;
  if (/\bfor\s*\(\s*$/.test(before.slice(0, before.length - typeM[0].length))) return null; // for-init: not this fix
  const type = typeM[1].trim();
  const typeStart = nameOffset - typeM[0].length;

  // walk to the terminating ';' on the blanked source; bail on anything that isn't a plain single decl
  const blanked = blankCommentsAndStrings(source);
  let j = nameOffset + nameLength,
    eq = -1;
  while (j < fn.bodyEnd && blanked[j] !== ";") {
    if ("{}(),[".includes(blanked[j])) return null; // block / call-init / multi-declarator / array
    if (blanked[j] === "=" && eq < 0) eq = j;
    j++;
  }
  if (blanked[j] !== ";") return null;
  const semi = j;
  const initText = eq >= 0 ? source.slice(eq + 1, semi).trim() : "";

  const edits: SourceEdit[] = [];

  // 1. macro -> *_WITH_LOCALS (insert `_WITH_LOCALS` right before the macro's `(`)
  if (!fn.withLocals) {
    const paren = source.indexOf("(", fn.macroStart);
    if (paren < 0 || paren >= fn.bodyStart) return null;
    edits.push({ start: paren, end: paren, newText: "_WITH_LOCALS" });
  }

  // 2. `struct <fn>_locals`: extend if it exists, else create one just before the macro
  const field = `${type} ${v};`;
  const structM = blanked.match(new RegExp(`\\bstruct\\s+${fn.name}_locals\\b\\s*\\{`));
  if (structM && structM.index !== undefined) {
    const brace = structM.index + structM[0].length; // just past the `{`
    edits.push({ start: brace, end: brace, newText: ` ${field}` });
  } else {
    const indent = (source
      .slice(source.lastIndexOf("\n", fn.macroStart - 1) + 1, fn.macroStart)
      .match(/^\s*/) ?? [""])[0];
    edits.push({
      start: fn.macroStart,
      end: fn.macroStart,
      newText: `struct ${fn.name}_locals { ${field} };\n${indent}`,
    });
  }

  // 3. drop the declaration (keep an initializer as `locals.<v> = …;`)
  if (eq >= 0) {
    edits.push({ start: typeStart, end: semi + 1, newText: `locals.${v} = ${initText};` });
  } else {
    const lineStart = source.lastIndexOf("\n", typeStart - 1) + 1;
    const nl = source.indexOf("\n", semi);
    const lineEnd = nl < 0 ? source.length : nl + 1;
    const alone =
      source.slice(lineStart, typeStart).trim() === "" &&
      source.slice(semi + 1, lineEnd).trim() === "";
    edits.push(
      alone
        ? { start: lineStart, end: lineEnd, newText: "" }
        : { start: typeStart, end: semi + 1, newText: "" },
    );
  }

  // 4. prefix every in-body use of <v> with `locals.` (skip the decl, member access `.`/`->`/`::`)
  const useRe = new RegExp(`\\b${v}\\b`, "g");
  useRe.lastIndex = fn.bodyStart;
  let u: RegExpExecArray | null;
  while ((u = useRe.exec(blanked)) && u.index < fn.bodyEnd) {
    const p = u.index;
    if (p >= typeStart && p <= semi) continue; // the declaration itself
    const pc = source[p - 1];
    if (pc === "." || pc === ":" || (pc === ">" && source[p - 2] === "-")) continue;
    edits.push({ start: p, end: p, newText: "locals." });
  }

  return edits;
}
