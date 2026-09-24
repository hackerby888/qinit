// a qubic asset name is up to seven bytes packed little-endian into the uint64 every asset call takes.
export const ASSET_NAME_PATTERN = /^[A-Z][A-Z0-9]{0,6}$/;

export function assetNameOrThrow(name: string): string {
    if (!ASSET_NAME_PATTERN.test(name)) {
        throw new Error(`asset name must be 1–7 chars A-Z0-9 starting with a letter, got '${name}'`);
    }
    return name;
}

export function packAssetName(name: string): bigint {
    let packed = 0n;

    for (let index = 0; index < Math.min(name.length, 7); index++) {
        packed |= BigInt(name.charCodeAt(index) & 0xff) << BigInt(index * 8);
    }

    return packed;
}

export function unpackAssetName(name: bigint): string {
    let text = "";
    let remaining = name;

    for (let index = 0; index < 8; index++) {
        const character = Number(remaining & 0xffn);
        remaining >>= 8n;

        if (character === 0) {
            break;
        }

        text += String.fromCharCode(character);
    }

    return text;
}
