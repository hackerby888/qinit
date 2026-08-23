// rangesEqual has two implementations — Buffer.compare under node, a DataView word walk in the browser —
// and every state/journal diff funnels through it. These pin both against each other, including the
// mismatched-offset case journalRegions relies on, which a same-offset test cannot catch.
import { describe, expect, test } from "bun:test";
import { bytesEqual, rangesEqual } from "../../src/support/bytes";

// The browser path, lifted out so it can be checked against Buffer.compare on the same inputs.
function wordWiseEqual(a: Uint8Array, aStart: number, b: Uint8Array, bStart: number, length: number): boolean {
    const aView = new DataView(a.buffer, a.byteOffset, a.byteLength);
    const bView = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let index = 0;
    for (; index + 4 <= length; index += 4) {
        if (aView.getUint32(aStart + index, true) !== bView.getUint32(bStart + index, true)) {
            return false;
        }
    }
    for (; index < length; index++) {
        if (a[aStart + index] !== b[bStart + index]) {
            return false;
        }
    }
    return true;
}

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

describe("rangesEqual", () => {
    test("equal and unequal ranges at the same offset", () => {
        expect(rangesEqual(bytes(1, 2, 3, 4, 5), 0, bytes(1, 2, 3, 4, 5), 0, 5)).toBe(true);
        expect(rangesEqual(bytes(1, 2, 3, 4, 5), 0, bytes(1, 2, 3, 4, 9), 0, 5)).toBe(false);
    });

    test("compares the requested window, not the whole array", () => {
        const a = bytes(9, 9, 1, 2, 3);
        const b = bytes(0, 0, 1, 2, 3);
        expect(rangesEqual(a, 2, b, 2, 3)).toBe(true);
        expect(rangesEqual(a, 0, b, 0, 3)).toBe(false);
    });

    // journalRegions compares a journal copy against live state — two different offsets in ONE buffer.
    // Passing the offsets to Buffer.compare in the wrong order still passes every same-offset test.
    test("honours differing source and target offsets", () => {
        const buf = bytes(1, 2, 3, 4, 0, 0, 1, 2, 3, 4);
        expect(rangesEqual(buf, 0, buf, 6, 4)).toBe(true);
        expect(rangesEqual(buf, 0, buf, 4, 4)).toBe(false);

        // Asymmetric on purpose: a[0..3] is 1,2,3 and b[1..4] is 2,3,4 — order matters.
        const a = bytes(1, 2, 3, 4);
        const b = bytes(0, 1, 2, 3);
        expect(rangesEqual(a, 0, b, 1, 3)).toBe(true);
        expect(rangesEqual(a, 1, b, 0, 3)).toBe(false);
    });

    test("a zero-length range is equal", () => {
        expect(rangesEqual(bytes(1), 0, bytes(2), 0, 0)).toBe(true);
    });

    test("handles lengths either side of the 4-byte word step", () => {
        for (let length = 1; length <= 9; length++) {
            const a = new Uint8Array(length).map((_, i) => i + 1);
            const b = a.slice();
            expect(rangesEqual(a, 0, b, 0, length)).toBe(true);
            b[length - 1] = 0xff;
            expect(rangesEqual(a, 0, b, 0, length)).toBe(false);
        }
    });

    test("works on a subarray view, where byteOffset is non-zero", () => {
        const backing = bytes(7, 7, 1, 2, 3, 4, 5, 6);
        const view = backing.subarray(2);
        expect(rangesEqual(view, 0, bytes(1, 2, 3, 4, 5, 6), 0, 6)).toBe(true);
        expect(rangesEqual(view, 0, bytes(1, 2, 3, 4, 5, 9), 0, 6)).toBe(false);
    });

    // The whole point of the fallback: it must agree with Buffer.compare byte for byte.
    test("the browser word walk agrees with the node Buffer path", () => {
        const a = new Uint8Array(64).map((_, i) => (i * 37) % 251);
        const b = a.slice();
        b[41] = (b[41]! + 1) % 256;
        for (let start = 0; start < 12; start++) {
            for (let length = 0; length < 40; length++) {
                expect(rangesEqual(a, start, b, start, length)).toBe(wordWiseEqual(a, start, b, start, length));
            }
        }
    });
});

// Under bun, `typeof Buffer !== "undefined"` is always true, so every case above exercised only the node
// path. Hide Buffer and replay the same matrix through the branch the browser actually runs — the one the
// IDE hit as "Buffer is not defined".
describe("rangesEqual without Buffer (the browser branch)", () => {
    const withoutBuffer = <T>(run: () => T): T => {
        const real = globalThis.Buffer;
        // @ts-expect-error — deliberately removing a global to reach the fallback.
        delete globalThis.Buffer;
        try {
            return run();
        } finally {
            globalThis.Buffer = real;
        }
    };

    test("agrees with the node path on every offset and length", () => {
        const a = new Uint8Array(64).map((_, i) => (i * 37) % 251);
        const b = a.slice();
        b[41] = (b[41]! + 1) % 256;

        const expected: boolean[] = [];
        for (let start = 0; start < 12; start++) {
            for (let length = 0; length < 40; length++) {
                expected.push(rangesEqual(a, start, b, start, length));
            }
        }

        withoutBuffer(() => {
            let index = 0;
            for (let start = 0; start < 12; start++) {
                for (let length = 0; length < 40; length++) {
                    expect(rangesEqual(a, start, b, start, length)).toBe(expected[index++]!);
                }
            }
        });
    });

    test("honours differing offsets the same way", () => {
        withoutBuffer(() => {
            const buf = bytes(1, 2, 3, 4, 0, 0, 1, 2, 3, 4);
            expect(rangesEqual(buf, 0, buf, 6, 4)).toBe(true);
            expect(rangesEqual(buf, 0, buf, 4, 4)).toBe(false);
            expect(rangesEqual(bytes(1, 2, 3, 4), 0, bytes(0, 1, 2, 3), 1, 3)).toBe(true);
            expect(rangesEqual(bytes(1, 2, 3, 4), 1, bytes(0, 1, 2, 3), 0, 3)).toBe(false);
        });
    });

    test("bytesEqual still works with no Buffer", () => {
        withoutBuffer(() => {
            expect(bytesEqual(bytes(1, 2, 3), bytes(1, 2, 3))).toBe(true);
            expect(bytesEqual(bytes(1, 2, 3), bytes(1, 2, 4))).toBe(false);
        });
    });
});

describe("bytesEqual", () => {
    test("compares whole arrays and rejects a length mismatch", () => {
        expect(bytesEqual(bytes(1, 2, 3), bytes(1, 2, 3))).toBe(true);
        expect(bytesEqual(bytes(1, 2, 3), bytes(1, 2, 4))).toBe(false);
        expect(bytesEqual(bytes(1, 2, 3), bytes(1, 2))).toBe(false);
        expect(bytesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
    });
});
