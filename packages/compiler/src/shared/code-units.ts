/**
 * UTF-16 code units, one array slot per lexer offset. `[...source]` iterates code points instead, so an
 * astral character collapses two units into one slot and shifts every later span left by one.
 */
export function codeUnits(source: string): string[] {
    return Array.from({ length: source.length }, (_, index) => source[index]);
}
