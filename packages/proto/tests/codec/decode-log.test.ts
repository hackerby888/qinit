import { test, expect } from "bun:test";
import { decodeLog, loggedSizeOf } from "../../src/decode-log";
import {
  AbiScalarKind,
  AbiTypeKind,
  type AbiScalar,
  type ContractLog,
} from "../../src/contract-idl";

const hexOf = (b: number[]) => b.map((x) => (x & 0xff).toString(16).padStart(2, "0")).join("");
// little-endian bytes of n (width bytes); BigInt.asUintN handles signed inputs
const le = (n: bigint | number, width: number) => {
  let v = BigInt.asUintN(64, BigInt(n));
  const o: number[] = [];
  for (let i = 0; i < width; i++) {
    o.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return o;
};

const scalarLayout: Record<AbiScalarKind, [number, number]> = {
  [AbiScalarKind.BIT]: [1, 1],
  [AbiScalarKind.ID]: [32, 8],
  [AbiScalarKind.M256I]: [32, 8],
  [AbiScalarKind.UINT8]: [1, 1],
  [AbiScalarKind.UINT16]: [2, 2],
  [AbiScalarKind.UINT32]: [4, 4],
  [AbiScalarKind.UINT64]: [8, 8],
  [AbiScalarKind.UINT128]: [16, 8],
  [AbiScalarKind.SINT8]: [1, 1],
  [AbiScalarKind.SINT16]: [2, 2],
  [AbiScalarKind.SINT32]: [4, 4],
  [AbiScalarKind.SINT64]: [8, 8],
  [AbiScalarKind.SINT128]: [16, 8],
};

function scalar(kind: AbiScalarKind): AbiScalar {
  const [size, align] = scalarLayout[kind];
  return {
    kind: AbiTypeKind.SCALAR,
    scalar: kind,
    size,
    align,
    format: "ignored",
  };
}

function log(
  name: string,
  fields: Array<[string, AbiScalarKind]>,
): ContractLog {
  let offset = 0;
  let align = 1;
  const typedFields = fields.map(([fieldName, kind]) => {
    const type = scalar(kind);
    offset = Math.ceil(offset / type.align) * type.align;
    const field = {
      name: fieldName,
      offset,
      size: type.size,
      type,
    };
    offset += type.size;
    align = Math.max(align, type.align);
    return field;
  });
  return {
    name,
    type: {
      kind: AbiTypeKind.STRUCT,
      fields: typedFields,
      size: Math.ceil(offset / align) * align,
      align,
      format: "ignored",
    },
  };
}

// logged size = offsetof(_terminator): internal alignment padding INCLUDED, struct tail padding EXCLUDED.
test("loggedSizeOf includes internal padding but not tail padding", () => {
  expect(loggedSizeOf("uint32, uint32, uint64")).toBe(16); // Logger.h LogMsg (no pad needed)
  expect(loggedSizeOf("uint8, uint64")).toBe(16); // u8@0, u64@8 -> 7B internal pad
  expect(loggedSizeOf("uint64, uint8")).toBe(9); // u64@0, u8@8 -> NO tail pad (sizeof=16)
  expect(loggedSizeOf("uint8, uint16")).toBe(4); // u8@0, u16@2 -> 1B internal pad, end 4
  expect(loggedSizeOf("uint32, id, id, sint64, uint32")).toBe(84); // QEARNLogger (4B pad after _contractIndex)
});

const LOGGER = log("LogMsg", [
  ["_contractIndex", AbiScalarKind.UINT32],
  ["_type", AbiScalarKind.UINT32],
  ["value", AbiScalarKind.UINT64],
]);

test("decodeLog size-matches the catalog + decodes named fields + severity", async () => {
  const buf = [...le(12, 4), ...le(0, 4), ...le(99, 8)]; // ci=12, type=0, value=99 -> 16B
  const d = await decodeLog(6, 16, hexOf(buf), [LOGGER]);
  expect(d.severity).toBe("INFO");
  expect(d.name).toBe("LogMsg");
  expect(d.fields).toEqual({ _contractIndex: 12, _type: 0, value: 99n });
});

test("decodeLog reads fields at PADDED offsets (uint8 then uint64 at off 8)", async () => {
  const cat = [
    log("P", [
      ["a", AbiScalarKind.UINT8],
      ["b", AbiScalarKind.UINT64],
    ]),
  ];
  const buf = [5, 0, 0, 0, 0, 0, 0, 0, ...le(99, 8)]; // a@0=5, 7B pad, b@8=99
  const d = await decodeLog(6, 16, hexOf(buf), cat);
  expect(d.fields).toEqual({ a: 5, b: 99n });
});

test("tail vs internal padding disambiguate by logged size, not sizeof", async () => {
  const cat = [
    log("TailPad", [
      ["x", AbiScalarKind.UINT64],
      ["y", AbiScalarKind.UINT8],
    ]),
    log("IntPad", [
      ["a", AbiScalarKind.UINT8],
      ["b", AbiScalarKind.UINT64],
    ]),
  ];
  const a = await decodeLog(6, 9, hexOf([...le(7, 8), 3]), cat);
  expect(a.name).toBe("TailPad");
  expect(a.fields).toEqual({ x: 7n, y: 3 });
  const b = await decodeLog(6, 16, hexOf([1, 0, 0, 0, 0, 0, 0, 0, ...le(2, 8)]), cat);
  expect(b.name).toBe("IntPad");
  expect(b.fields).toEqual({ a: 1, b: 2n });
});

test("ambiguous size -> hex fallback (no name/fields)", async () => {
  const cat = [
    log("A", [
      ["a", AbiScalarKind.UINT32],
      ["b", AbiScalarKind.UINT32],
    ]),
    log("B", [["c", AbiScalarKind.UINT64]]),
  ];
  const d = await decodeLog(6, 8, hexOf(le(1, 8)), cat);
  expect(d.name).toBeUndefined();
  expect(d.fields).toBeUndefined();
  expect(d.hex).toBe("0x0100000000000000");
});

test("no size match -> hex fallback", async () => {
  const d = await decodeLog(4, 5, hexOf([1, 2, 3, 4, 5]), [LOGGER]);
  expect(d.severity).toBe("ERROR");
  expect(d.name).toBeUndefined();
  expect(d.hex).toBe("0x0102030405");
});

test("severity map covers ERROR/WARN/INFO/DEBUG + unknown", async () => {
  const sev = async (t: number) => (await decodeLog(t, 0, "", [])).severity;
  expect(await sev(4)).toBe("ERROR");
  expect(await sev(5)).toBe("WARN");
  expect(await sev(6)).toBe("INFO");
  expect(await sev(7)).toBe("DEBUG");
  expect(await sev(9)).toBe("type9");
});

test("decodeLog resolves the _type discriminator to its enum name", async () => {
  const cat = [LOGGER];
  const enums = { "0": "Started", "1": "Ticked", "2": "Done" };
  const buf = [...le(7, 4), ...le(2, 4), ...le(99, 8)]; // _type = 2 -> "Done"
  const d = await decodeLog(6, 16, hexOf(buf), cat, enums);
  expect(d.typeName).toBe("Done");
  expect(d.fields).toEqual({ _contractIndex: 7, _type: 2, value: 99n });
});

test("decodeLog leaves typeName undefined with no enum map or unknown value", async () => {
  const cat = [LOGGER];
  const noMap = await decodeLog(6, 16, hexOf([...le(0, 4), ...le(1, 4), ...le(1, 8)]), cat);
  expect(noMap.typeName).toBeUndefined();
  const unknownVal = await decodeLog(6, 16, hexOf([...le(0, 4), ...le(9, 4), ...le(1, 8)]), cat, {
    "0": "Started",
  });
  expect(unknownVal.typeName).toBeUndefined();
});

test("capped hex (node truncates >256B): size > available bytes -> hex fallback, no crash", async () => {
  const cat = [
    log("Big", [
      ["a", AbiScalarKind.UINT64],
      ["b", AbiScalarKind.UINT64],
      ["c", AbiScalarKind.UINT64],
    ]),
  ];
  const short = hexOf(le(1, 8).concat(le(2, 8))); // only 16 of 24 bytes present
  const d = await decodeLog(6, 24, short, cat); // size matches but decode reads OOB
  expect(d.severity).toBe("INFO");
  expect(d.name).toBeUndefined(); // decode threw -> fallback
  expect(d.fields).toBeUndefined();
  expect(d.hex).toBe("0x" + short);
});

test("m256i field in a log struct decodes as raw hex at its padded offset", async () => {
  const cat = [
    log("L", [
      ["ci", AbiScalarKind.UINT32],
      ["digest", AbiScalarKind.M256I],
    ]),
  ];
  expect(loggedSizeOf(cat[0].type)).toBe(40);
  const digest = Array.from({ length: 32 }, (_, i) => i);
  const d = await decodeLog(6, 40, hexOf([...le(1, 4), 0, 0, 0, 0, ...digest]), cat);
  expect(d.name).toBe("L");
  expect(d.fields).toEqual({
    ci: 1,
    digest: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  });
});

test("id field decodes to a 60-char identity at its padded offset", async () => {
  const cat = [
    log("Q", [
      ["ci", AbiScalarKind.UINT32],
      ["who", AbiScalarKind.ID],
      ["amt", AbiScalarKind.SINT64],
    ]),
  ];
  expect(loggedSizeOf(cat[0].type)).toBe(48); // u32@0, id@8 (4B pad), sint64@40
  const buf = [...le(1, 4), 0, 0, 0, 0, ...new Array(32).fill(0), ...le(1000, 8)];
  const d = await decodeLog(6, 48, hexOf(buf), cat);
  expect(d.name).toBe("Q");
  expect((d.fields!.who as string).length).toBe(60);
  expect(d.fields!.amt).toBe(1000n);
});
