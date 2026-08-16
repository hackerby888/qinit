// The structural Wasm parser throws in 26 places and the suite only ever fed it one truncated header, so
// a wrong or missing parse error was invisible. Each case here pins the message and the byte offset.
import { describe, expect, test } from "bun:test";
import { inspectWasmModule } from "../../src/driver/wasm-inspection";

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

// Every body below is under 128 bytes, so a section length is always a single LEB byte.
const section = (id: number, body: number[]): number[] => [id, body.length, ...body];
const moduleBytes = (...sections: number[][]): Uint8Array => new Uint8Array([...HEADER, ...sections.flat()]);
const funcBody = (code: number[]): number[] => section(10, [0x01, code.length, ...code]);

const TYPE = section(1, [0x01, 0x60, 0x00, 0x00]);
const FUNC = section(3, [0x01, 0x00]);

const PARSE_ERRORS: Record<string, { bytes: Uint8Array; message: string; offset: number }> = {
    "rejects a corrupt magic byte": {
        bytes: new Uint8Array([0x00, 0x61, 0x73, 0x6e, 0x01, 0x00, 0x00, 0x00]),
        message: "invalid Wasm magic or version",
        offset: 3,
    },
    "rejects an unsupported version word": {
        bytes: new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]),
        message: "invalid Wasm magic or version",
        offset: 4,
    },
    "rejects a truncated header": {
        bytes: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
        message: "unexpected end while reading Wasm header",
        offset: 4,
    },
    "rejects a duplicated section id": {
        bytes: moduleBytes(section(1, [0x00]), section(1, [0x00])),
        message: "duplicate section 1",
        offset: 11,
    },
    "rejects trailing bytes inside a section": {
        bytes: moduleBytes(section(1, [0x00, 0x99])),
        message: "section 1 has 1 unread bytes",
        offset: 11,
    },
    "rejects a non-function type form": {
        bytes: moduleBytes(section(1, [0x01, 0x5f, 0x00, 0x00])),
        message: "type is not a function type",
        offset: 11,
    },
    "rejects a v128 parameter": {
        bytes: moduleBytes(section(1, [0x01, 0x60, 0x01, 0x7b, 0x00])),
        message: "parameter uses v128",
        offset: 13,
    },
    "rejects a reference-typed parameter": {
        bytes: moduleBytes(section(1, [0x01, 0x60, 0x01, 0x70, 0x00])),
        message: "parameter uses a reference value type",
        offset: 13,
    },
    "rejects an unknown value type": {
        bytes: moduleBytes(section(1, [0x01, 0x60, 0x01, 0x00, 0x00])),
        message: "parameter has an unknown value type",
        offset: 13,
    },
    "rejects an unknown import kind": {
        bytes: moduleBytes(section(2, [0x01, 0x01, 0x65, 0x01, 0x66, 0x05])),
        message: "unknown import kind 5",
        offset: 15,
    },
    "rejects an unknown export kind": {
        bytes: moduleBytes(section(7, [0x01, 0x01, 0x65, 0x09, 0x00])),
        message: "unknown export kind 9",
        offset: 13,
    },
    "rejects unsupported memory limit flags": {
        bytes: moduleBytes(section(5, [0x01, 0x08, 0x01])),
        message: "memory has unsupported limits flags 0x8",
        offset: 11,
    },
    "rejects unsupported table limit flags": {
        bytes: moduleBytes(section(4, [0x01, 0x70, 0x03, 0x01, 0x02])),
        message: "table has unsupported limits flags 0x3",
        offset: 12,
    },
    "rejects an unsupported table element type": {
        bytes: moduleBytes(section(4, [0x01, 0x71, 0x00, 0x01])),
        message: "table has an unsupported element type",
        offset: 11,
    },
    "rejects a non-boolean global mutability byte": {
        bytes: moduleBytes(section(6, [0x01, 0x7f, 0x02, 0x41, 0x00, 0x0b])),
        message: "global mutability must be 0 or 1",
        offset: 12,
    },
    "rejects a non-MVP constant expression": {
        bytes: moduleBytes(section(6, [0x01, 0x7f, 0x00, 0x45, 0x0b])),
        message: "constant expression is outside the MVP subset",
        offset: 13,
    },
    "rejects a multi-instruction constant expression": {
        bytes: moduleBytes(section(6, [0x01, 0x7f, 0x00, 0x41, 0x00, 0x41, 0x00])),
        message: "constant expression has more than one instruction",
        offset: 15,
    },
    "rejects a reference-typed constant expression": {
        bytes: moduleBytes(section(6, [0x01, 0x7f, 0x00, 0xd0, 0x70, 0x0b])),
        message: "constant expression uses reference types",
        offset: 13,
    },
    "rejects a non-UTF-8 import module name": {
        bytes: moduleBytes(section(2, [0x01, 0x01, 0xff, 0x01, 0x66, 0x00, 0x00])),
        message: "import module is not valid UTF-8",
        offset: 12,
    },
    "rejects a section size above uint32": {
        bytes: new Uint8Array([...HEADER, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff]),
        message: "section size exceeds uint32",
        offset: 13,
    },
    "rejects an overlong signed LEB128": {
        bytes: moduleBytes(section(6, [0x01, 0x7f, 0x00, 0x41, 0x80, 0x80, 0x80, 0x80, 0x80, 0x0b])),
        message: "i32.const has an overlong LEB128 encoding",
        offset: 19,
    },
    "rejects a dangling function type index": {
        bytes: moduleBytes(section(3, [0x01, 0x07])),
        message: "defined function refers to missing type 7",
        offset: 11,
    },
    "rejects a truncated section body": {
        bytes: new Uint8Array([...HEADER, 0x01, 0x05, 0x01, 0x60]),
        message: "unexpected end while reading section 1",
        offset: 10,
    },
    "rejects a v128 local": {
        bytes: moduleBytes(TYPE, FUNC, section(10, [0x01, 0x04, 0x01, 0x01, 0x7b, 0x0b])),
        message: "local uses v128",
        offset: 24,
    },
    "rejects a function body that runs past its end": {
        bytes: moduleBytes(TYPE, FUNC, section(10, [0x01, 0x03, 0x00, 0x01])),
        message: "unexpected end while reading function body",
        offset: 22,
    },
};

// These parse cleanly but leave the module outside the portable profile.
const FEATURE_CASES: Record<string, { bytes: Uint8Array; feature: string }> = {
    "flags a simd opcode": { bytes: moduleBytes(TYPE, FUNC, funcBody([0x00, 0xfd, 0x00, 0x0b])), feature: "simd" },
    "flags an atomic opcode": { bytes: moduleBytes(TYPE, FUNC, funcBody([0x00, 0xfe, 0x00, 0x0b])), feature: "threads/atomics" },
    "flags a tail call": { bytes: moduleBytes(TYPE, FUNC, funcBody([0x00, 0x12, 0x00, 0x0b])), feature: "tail-calls" },
    "flags a typed select": { bytes: moduleBytes(TYPE, FUNC, funcBody([0x00, 0x1c, 0x01, 0x7f, 0x0b])), feature: "typed-select" },
    "flags a non-zero call_indirect table": { bytes: moduleBytes(TYPE, FUNC, funcBody([0x00, 0x11, 0x00, 0x01, 0x0b])), feature: "multiple-tables" },
    "flags the memarg alignment extension": {
        bytes: moduleBytes(TYPE, FUNC, funcBody([0x00, 0x28, 0x40, 0x00, 0x0b])),
        feature: "multiple-memories/memarg-extension",
    },
    "flags memory64 limits": { bytes: moduleBytes(section(5, [0x01, 0x04, 0x01])), feature: "memory64" },
    "flags multiple memories": { bytes: moduleBytes(section(5, [0x02, 0x00, 0x01, 0x00, 0x01])), feature: "multiple-memories" },
    "flags reference-typed element segments": { bytes: moduleBytes(section(9, [0x01, 0x02])), feature: "bulk-memory/reference-type-elements" },
    "flags non-MVP data segment flags": { bytes: moduleBytes(section(11, [0x01, 0x02])), feature: "bulk-memory/data-segments" },
    "flags the data count section": { bytes: moduleBytes(section(12, [0x00])), feature: "bulk-memory/data-count" },
    "flags the tag section": { bytes: moduleBytes(section(13, [0x00])), feature: "exception-handling/tags" },
};

const diagnosticFor = (bytes: Uint8Array, code: string) => inspectWasmModule(bytes).diagnostics.find((diagnostic) => diagnostic.code === code);

describe("Wasm module inspection — malformed bytes", () => {
    for (const [name, testCase] of Object.entries(PARSE_ERRORS)) {
        test(name, () => {
            const result = inspectWasmModule(testCase.bytes);
            const diagnostic = result.diagnostics.find((entry) => entry.code === "malformed-module");

            expect(result.ok).toBe(false);
            expect(diagnostic?.message).toBe(testCase.message);
            expect(diagnostic?.offset).toBe(testCase.offset);
        });
    }

    // The feature sweep still runs after a throw, so a v128 parameter reports both problems.
    test("a rejected module still reports the feature that broke it", () => {
        const result = inspectWasmModule(moduleBytes(section(1, [0x01, 0x60, 0x01, 0x7b, 0x00])));

        expect(result.features).toContain("simd");
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("unsupported-feature");
    });
});

describe("Wasm module inspection — non-portable features", () => {
    for (const [name, testCase] of Object.entries(FEATURE_CASES)) {
        test(name, () => {
            const result = inspectWasmModule(testCase.bytes);

            expect(result.ok).toBe(false);
            expect(result.features).toContain(testCase.feature);
            expect(result.diagnostics).toContainEqual(
                expect.objectContaining({ code: "unsupported-feature", message: `unsupported Wasm feature: ${testCase.feature}` }),
            );
        });
    }

    test("flags an unknown section id", () => {
        const diagnostic = diagnosticFor(moduleBytes(section(14, [0x01])), "unsupported-section");

        expect(diagnostic?.message).toBe("section 14 is outside the portable MVP profile");
        expect(diagnostic?.offset).toBe(8);
    });

    test("flags an unknown opcode", () => {
        const diagnostic = diagnosticFor(moduleBytes(TYPE, FUNC, funcBody([0x00, 0xff, 0x0b])), "unsupported-opcode");

        expect(diagnostic?.message).toBe("opcode 0xff is outside the portable MVP profile");
        expect(diagnostic?.offset).toBe(23);
    });

    test("reports a code and function section count mismatch", () => {
        const diagnostic = diagnosticFor(moduleBytes(TYPE, section(10, [0x01, 0x02, 0x00, 0x0b])), "malformed-module");

        expect(diagnostic?.message).toBe("function section declares 0 bodies but code section has 1");
        expect(diagnostic?.offset).toBeUndefined();
    });
});
