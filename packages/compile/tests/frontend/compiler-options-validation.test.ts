import { describe, expect, test } from "bun:test";
import { compileContract, type CalleeIdl, type CompileOptions } from "../../src/index";

const VALID_SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 value; };
  struct Ping_input {};
  struct Ping_output { uint64 value; };
  PUBLIC_FUNCTION(Ping) { output.value = state.get().value; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Ping, 1); }
};`;

const BASE: CompileOptions = {
  source: VALID_SOURCE,
  name: "OptionProbe",
  slot: 27,
  arenaSz: 1 << 20,
};

const CALLEE: CalleeIdl = {
  name: "Other",
  index: 28,
  functions: { Ping: { inputType: 1, inSize: 0, outSize: 8 } },
  procedures: {},
};

async function expectRejected(overrides: Partial<CompileOptions>): Promise<void> {
  const result = await compileContract({ ...BASE, ...overrides });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");

  expect(errors.length).toBeGreaterThan(0);
  expect(result.wasm.byteLength).toBe(0);
  expect(result.idl.functions).toEqual([]);
  expect(result.idl.procedures).toEqual([]);
}

describe("compiler option validation", () => {
  test("accepts a valid boundary-control request", async () => {
    const result = await compileContract(BASE);

    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(result.wasm.byteLength).toBeGreaterThan(0);
    expect(WebAssembly.validate(result.wasm)).toBe(true);
  });

  const invalidNames = [
    ["empty", ""],
    ["whitespace", "Bad Name"],
    ["punctuation", "Bad-Name"],
    ["preprocessor newline", "Bad\n#define INJECTED 1"],
    ["oversized", "C".repeat(1025)],
  ] as const;
  for (const [label, name] of invalidNames) {
    test(`rejects ${label} contract name`, () => expectRejected({ name }));
  }

  const invalidSlots = [
    ["negative", -1],
    ["fractional", 1.5],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["larger than uint32", 0x1_0000_0000],
  ] as const;
  for (const [label, slot] of invalidSlots) {
    test(`rejects ${label} slot`, () => expectRejected({ slot }));
  }

  const invalidArenaSizes = [
    ["zero", 0],
    ["negative", -1],
    ["fractional", 64.5],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["larger than wasm32", 0x1_0000_0000],
  ] as const;
  for (const [label, arenaSz] of invalidArenaSizes) {
    test(`rejects ${label} arena size`, () => expectRejected({ arenaSz }));
  }

  const invalidSharedBases = [
    ["negative", -1],
    ["unaligned", 3],
    ["fractional", 64.5],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["larger than wasm32", 0x1_0000_0000],
  ] as const;
  for (const [label, sharedMemBase] of invalidSharedBases) {
    test(`rejects ${label} shared memory base`, () => expectRejected({ sharedMemBase }));
  }

  test("rejects duplicate callee names", () =>
    expectRejected({
      callees: [CALLEE, { ...CALLEE, index: 29 }],
    }));

  test("rejects duplicate callee indices", () =>
    expectRejected({
      callees: [CALLEE, { ...CALLEE, name: "Another" }],
    }));

  test("rejects negative callee ABI sizes", () =>
    expectRejected({
      callees: [
        {
          ...CALLEE,
          functions: { Ping: { inputType: 1, inSize: -1, outSize: 8 } },
        },
      ],
    }));

  test("rejects fractional callee ABI sizes", () =>
    expectRejected({
      callees: [
        {
          ...CALLEE,
          functions: { Ping: { inputType: 1, inSize: 0, outSize: 1.5 } },
        },
      ],
    }));

  test("surfaces parser errors from callee source", () =>
    expectRejected({
      callees: [CALLEE],
      calleeSources: [
        {
          name: "Other",
          source: "struct Other : public ContractBase { struct Broken { uint64 value = ; }; };",
        },
      ],
    }));

  test("rejects callee IDL and source name mismatches", () =>
    expectRejected({
      callees: [CALLEE],
      calleeSources: [
        {
          name: "Different",
          source: "struct Different : public ContractBase {};",
        },
      ],
    }));
});
