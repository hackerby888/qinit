// Pure quick-fix transforms for Tier-A findings (no vscode). Each returns the replacement text for a
// single line, or null when the line doesn't match the expected shape — so the editor only offers the
// action when the rewrite is safe.

// `<type> <name>[<size>];`  ->  `Array<<type>, <size>> <name>;`  (a member array declaration).
// Bails on multi-var decls / nested brackets so it never mangles ambiguous lines.
export function arrayFixForLine(line: string): string | null {
  const m = line.match(/^(\s*)([A-Za-z_][\w:<>,\s]*?)\s+([A-Za-z_]\w*)\s*\[\s*([^\]]+?)\s*\]\s*;(.*)$/);
  if (!m) return null;
  const [, indent, type, name, size, tail] = m;
  if (/[\[\],]/.test(type)) return null; // multi-var or already array-ish — don't touch
  return `${indent}Array<${type.trim()}, ${size.trim()}> ${name};${tail}`;
}
