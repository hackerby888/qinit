import { expect, test } from "bun:test";
import { ASSET_NAME_PATTERN, assetNameOrThrow, packAssetName, unpackAssetName } from "../../src/asset-name";

// core packs a name little-endian into a uint64: MYTOK is 0x4b4f54594d, the number the campaign typed by hand.
test("asset names pack little-endian and unpack back", () => {
    expect(packAssetName("MYTOK")).toBe(323453475149n);
    expect(unpackAssetName(323453475149n)).toBe("MYTOK");
    expect(unpackAssetName(packAssetName("QX"))).toBe("QX");
    expect(packAssetName("ABCDEFGH")).toBe(packAssetName("ABCDEFG"));
});

test("an asset name is one to seven capitals or digits, letter first", () => {
    expect(assetNameOrThrow("QX")).toBe("QX");
    expect(assetNameOrThrow("A1B2C3D")).toBe("A1B2C3D");
    for (const bad of ["", "mytok", "1ABC", "TOOLONGX", "MY TOK"]) {
        expect(ASSET_NAME_PATTERN.test(bad)).toBe(false);
        expect(() => assetNameOrThrow(bad)).toThrow(`got '${bad}'`);
    }
});
