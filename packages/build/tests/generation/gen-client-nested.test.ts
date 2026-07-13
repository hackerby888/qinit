import { CORE_PATH } from "../../../../test-utils/paths";
// Nested-type client codegen, end-to-end. Asserts the generated source shape (inline nested object types,
// recursive output mapper, typed args for nested-struct inputs), that real QX/Quottery clients transpile, and —
import { test, expect, afterAll } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { Transpiler } from "bun";
import { extractIdl } from "../../src/idl";
import { generateClient } from "../../src/gen-client";

const CORE = CORE_PATH + "/src/contracts";
const have = (c: string) => existsSync(`${CORE}/${c}.h`);
const srcOf = (c: string) => readFileSync(`${CORE}/${c}.h`, "utf8");

const GEO = `
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Pt { sint64 x; sint64 y; };
  struct Holder { id who; uint64 amt; };
  struct Padded { uint64 a; uint8 b; };
  struct GetPt_input {}; struct GetPt_output { Pt p; };
  struct ListPts_input {}; struct ListPts_output { Array<Pt, 3> pts; };
  struct Echo_input { Pt to; uint64 speed; }; struct Echo_output { sint64 sum; };
  struct EchoHolder_input { Holder h; }; struct EchoHolder_output { uint64 ok; };
  struct EchoPad_input { Padded p; uint8 c; }; struct EchoPad_output { uint64 ok; };
  struct AddPts_input { Array<Pt,2> pts; }; struct AddPts_output {};
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(GetPt, 1);
    REGISTER_USER_FUNCTION(ListPts, 2);
    REGISTER_USER_FUNCTION(Echo, 3);
    REGISTER_USER_FUNCTION(EchoHolder, 4);
    REGISTER_USER_FUNCTION(EchoPad, 5);
    REGISTER_USER_PROCEDURE(AddPts, 1);
  }
};`;

const geoClient = generateClient(extractIdl(GEO, "Geo"), 5);
const incl = (s: string) => expect(geoClient.includes(s)).toBe(true);

// ---- generated-source shape ----

test("nested struct output -> inline object type", () => {
  incl("export interface GetPt_output {\n  p: { x: bigint; y: bigint };\n}");
});

test("array-of-struct output -> typed element array", () => {
  incl("export interface ListPts_output {\n  pts: { x: bigint; y: bigint }[];\n}");
});

test("nested struct input -> typed args + braced value template (no raw inFmt)", () => {
  incl("async Echo(args: Echo_input): Promise<Echo_output>");
  incl("`{ ${args.to.x}sint64, ${args.to.y}sint64 }, ${args.speed}uint64`");
});

test("nested-with-id input keeps the id token inside the brace", () => {
  incl("`{ ${args.h.who}id, ${args.h.amt}uint64 }`");
});

test("recursive output mapper turns the decoder's positional arrays into named objects", () => {
  incl("return { p: ((s) => ({ x: s[0] as bigint, y: s[1] as bigint }))(r as unknown[]) };");
  incl(
    "return { pts: (r as unknown[][]).map((e) => ({ x: e[0] as bigint, y: e[1] as bigint })) };",
  );
});

test("array INPUT still falls back to a raw inFmt param (fixed-N can't be value-templated)", () => {
  incl("async AddPts(inFmt: string, opts:");
});

test.skipIf(!have("Qx"))("real QX/Quottery clients transpile cleanly (valid TS syntax)", () => {
  const t = new Transpiler({ loader: "ts" });
  for (const c of ["Qx", "Quottery"].filter(have)) {
    const code = generateClient(extractIdl(srcOf(c), c), 1);
    expect(() => t.transformSync(code)).not.toThrow();
  }
});

test.skipIf(!have("Qx"))(
  "real QX: nested order row + Asset input are fully typed (no `unknown`)",
  () => {
    const qx = generateClient(extractIdl(srcOf("Qx"), "Qx"), 1);
    // entity order book row carries all four named fields (the scoped-resolution fix)
    expect(qx).toContain(
      "issuer: string; assetName: bigint; price: bigint; numberOfShares: bigint }[]",
    );
    // share-management procedure takes typed args, not a hand-written format string
    expect(qx).toContain("asset: { issuer: string; assetName: bigint }");
    expect(qx).not.toContain("async TransferShareManagementRights(inFmt: string");
  },
);

// ---- run the generated client against a fake RPC (byte-exact encode + typed decode) ----

const tmp: string[] = [];
async function loadGenerated(code: string, tag: string): Promise<any> {
  const path = `${import.meta.dir}/_genrun_${tag}.ts`;
  await Bun.write(path, code);
  tmp.push(path);
  return import(path);
}
afterAll(() => {
  for (const p of tmp)
    try {
      unlinkSync(p);
    } catch {}
});

const sint64 = (...vs: bigint[]) => {
  const b = new Uint8Array(vs.length * 8);
  const dv = new DataView(b.buffer);
  vs.forEach((v, i) => dv.setBigInt64(i * 8, v, true));
  return b;
};

test("RUN: nested + array-of-struct outputs decode into typed named objects", async () => {
  const mod = await loadGenerated(geoClient, "out");
  const rpc = {
    async querySmartContract(_idx: number, fnId: number): Promise<Uint8Array> {
      if (fnId === 1) return sint64(5n, 7n); // GetPt -> Pt{5,7}
      if (fnId === 2) return sint64(1n, 2n, 3n, 4n, 5n, 6n); // ListPts -> 3 Pts
      throw new Error("unexpected fn " + fnId);
    },
  };
  const c = new mod.Geo({ rpc, index: 5 });
  expect(await c.GetPt()).toEqual({ p: { x: 5n, y: 7n } });
  expect(await c.ListPts()).toEqual({
    pts: [
      { x: 1n, y: 2n },
      { x: 3n, y: 4n },
      { x: 5n, y: 6n },
    ],
  });
});

test("RUN: nested struct input is byte-exact encoded (alignment incl. trailing pad)", async () => {
  const mod = await loadGenerated(geoClient, "in");
  let captured: Uint8Array | null = null;
  const rpc = {
    async querySmartContract(_idx: number, _fnId: number, input: Uint8Array): Promise<Uint8Array> {
      captured = input;
      return sint64(99n);
    },
  };
  const c = new mod.Geo({ rpc, index: 5 });

  // Echo: { sint64 x@0, sint64 y@8 }, uint64 speed@16 -> 24 bytes
  expect(await c.Echo({ to: { x: 10n, y: 20n }, speed: 3n })).toEqual({ sum: 99n });
  let dv = new DataView(captured!.buffer, captured!.byteOffset, captured!.byteLength);
  expect(captured!.length).toBe(24);
  expect(dv.getBigInt64(0, true)).toBe(10n);
  expect(dv.getBigInt64(8, true)).toBe(20n);
  expect(dv.getBigUint64(16, true)).toBe(3n);

  // EchoPad: { uint64 a@0, uint8 b@8 } pads to 16, uint8 c@16 -> 24 bytes (proves nested trailing pad)
  await c.EchoPad({ p: { a: 100n, b: 9 }, c: 200 });
  dv = new DataView(captured!.buffer, captured!.byteOffset, captured!.byteLength);
  expect(captured!.length).toBe(24);
  expect(dv.getBigUint64(0, true)).toBe(100n);
  expect(dv.getUint8(8)).toBe(9);
  expect(dv.getUint8(16)).toBe(200);

  // EchoHolder: { id who@0 (32B), uint64 amt@32 } -> 40 bytes
  await c.EchoHolder({ h: { who: "11".repeat(32), amt: 42n } });
  dv = new DataView(captured!.buffer, captured!.byteOffset, captured!.byteLength);
  expect(captured!.length).toBe(40);
  expect([...captured!.slice(0, 32)].every((x) => x === 0x11)).toBe(true);
  expect(dv.getBigUint64(32, true)).toBe(42n);
});
