// Parse an integer literal value (handles 0x, 0b, 0 prefixes and suffixes)
export function parseIntLiteral(literalText: string): bigint {
    let normalizedText = literalText.toLowerCase();
    let base: number;
    // Strip suffix and C++14 digit separators
    normalizedText = normalizedText.replace(/(ull?|ll?u?|u|l)$/, "").replace(/'/g, "");
    if (normalizedText.startsWith("0x")) {
        base = 16;
        normalizedText = normalizedText.slice(2);
    }
    else if (normalizedText.startsWith("0b")) {
        base = 2;
        normalizedText = normalizedText.slice(2);
    }
    else if (normalizedText.startsWith("0") && normalizedText.length > 1 && !normalizedText.includes(".")) {
        base = 8;
        normalizedText = normalizedText.slice(1);
    }
    else {
        base = 10;
    }
    // Convert with the detected base. Earlier this reparsed `s` as decimal regardless of base, so
    const prefix = base === 16 ? "0x" : base === 2 ? "0b" : base === 8 ? "0o" : "";
    return BigInt(prefix + (normalizedText || "0"));
}
