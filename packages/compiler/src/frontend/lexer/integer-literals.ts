// Parse an integer literal with C++ base prefixes, suffixes, and digit separators.
export function parseIntLiteral(literalText: string): bigint {
    let normalizedText = literalText.toLowerCase();
    let base: number;
    // Strip suffixes and C++14 digit separators.
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
    // Preserve the detected base when converting the normalized digits.
    let prefix = "";
    if (base === 16)
        prefix = "0x";
    else if (base === 2)
        prefix = "0b";
    else if (base === 8)
        prefix = "0o";
    return BigInt(prefix + (normalizedText || "0"));
}
