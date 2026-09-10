/** UTF-16 code units, one slot per lexer offset: `[...source]` iterates code points, so an astral character collapses two units and shifts later spans left. */
export function codeUnits(source: string): string[] {
    return Array.from({ length: source.length }, (_, index) => source[index]);
}
