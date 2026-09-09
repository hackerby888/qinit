/**
 * UTF-16 code units, one array slot per lexer offset.
 *
 * `[...source]` iterates *code points*, so a single astral character — an emoji, CJK Ext-B, a
 * mathematical alphanumeric — collapses two UTF-16 units into one slot. Every span the lexer
 * produces is a UTF-16 offset, so indexing a code-point array with one shifts the window left by
 * one for everything after it. That silently corrupted the stripped source `--production`, `strip`
 * and `integrate` emit, and at exactly three emoji left `CC_` — which the residue guard's original
 * `/\bCC_[A-Z0-9_]/` needed one more character to catch.
 */
export function codeUnits(source: string): string[] {
    return Array.from({ length: source.length }, (_, index) => source[index]);
}
