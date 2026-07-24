import { test, expect } from "bun:test";
import { jsonToInputFmt, encodeInputJson, encodeInput, decodeOutput } from "../../src/abi-fmt";
import { callFunction } from "../../src/call";
import {
  AbiScalarKind,
  AbiTypeKind,
  type AbiStruct,
  type AbiType,
} from "../../src/contract-idl";

test("jsonToInputFmt: flat scalars by field name", () => {
  expect(jsonToInputFmt([{ name: "value", type: "uint64" }], { value: 3 })).toBe("3uint64");
  expect(
    jsonToInputFmt(
      [
        { name: "a", type: "uint32" },
        { name: "b", type: "sint64" },
      ],
      { a: 5, b: -7 },
    ),
  ).toBe("5uint32, -7sint64");
});

test("jsonToInputFmt: positional array form (order = field order)", () => {
  expect(
    jsonToInputFmt(
      [
        { name: "a", type: "uint8" },
        { name: "b", type: "uint16" },
      ],
      [1, 2],
    ),
  ).toBe("1uint8, 2uint16");
});

test("jsonToInputFmt: id field passes the identity through", () => {
  const id = "A".repeat(60);
  expect(jsonToInputFmt([{ name: "dst", type: "id" }], { dst: id })).toBe(`${id}id`);
});

test("encodeInputJson: the 60-A zero identity hint encodes to the zero id", async () => {
  const b = await encodeInputJson([{ name: "dst", type: "id" }], { dst: "A".repeat(60) });
  expect(b).toEqual(new Uint8Array(32));
});

test("jsonToInputFmt: nested struct (positional) + fixed array", () => {
  expect(jsonToInputFmt([{ name: "p", type: "{ uint64, uint32 }" }], { p: [1, 2] })).toBe(
    "{ 1uint64, 2uint32 }",
  );
  expect(jsonToInputFmt([{ name: "xs", type: "[3;uint64]" }], { xs: [1, 2, 3] })).toBe(
    "[3; 1uint64, 2uint64, 3uint64]",
  );
});

test("jsonToInputFmt: bool -> bit, big numeric string preserved", () => {
  expect(jsonToInputFmt([{ name: "f", type: "bit" }], { f: true })).toBe("1bit");
  expect(jsonToInputFmt([{ name: "n", type: "uint64" }], { n: "18446744073709551615" })).toBe(
    "18446744073709551615uint64",
  );
});

test("jsonToInputFmt: uint128 decimal string remains lossless", async () => {
  const max = (1n << 128n) - 1n;
  expect(jsonToInputFmt([{ name: "n", type: "uint128" }], { n: max.toString() })).toBe(
    `${max}uint128`,
  );
  const b = await encodeInputJson([{ name: "n", type: "uint128" }], { n: max.toString() });
  expect(await decodeOutput(b, "uint128")).toBe(max);
});

test("jsonToInputFmt: missing field + arity mismatch throw", () => {
  expect(() => jsonToInputFmt([{ name: "value", type: "uint64" }], {})).toThrow(
    /missing input field 'value'/,
  );
  expect(() => jsonToInputFmt([{ name: "xs", type: "[2;uint64]" }], { xs: [1] })).toThrow(
    /expects 2 elements/,
  );
  expect(() => jsonToInputFmt([{ name: "p", type: "{ uint64, uint32 }" }], { p: [1] })).toThrow(
    /expects 2 values/,
  );
});

test("encodeInputJson === encodeInput of the equivalent fmt (incl alignment)", async () => {
  const a = await encodeInputJson([{ name: "value", type: "uint64" }], { value: 3 });
  expect([...a]).toEqual([...(await encodeInput("3uint64"))]);
  // {uint8, uint64}: 1B + 7B pad + 8B
  const b = await encodeInputJson([{ name: "s", type: "{ uint8, uint64 }" }], { s: [5, 9] });
  expect([...b]).toEqual([...(await encodeInput("{ 5uint8, 9uint64 }"))]);
  expect(b.length).toBe(16);
});

test("jsonToInputFmt: float value is rejected (BigInt refuses non-integers)", () => {
  expect(() => jsonToInputFmt([{ name: "n", type: "uint64" }], { n: 3.5 })).toThrow();
});

test("jsonToInputFmt: null/undefined value throws", () => {
  expect(() => jsonToInputFmt([{ name: "v", type: "uint64" }], { v: null })).toThrow(
    /missing value/,
  );
});

test("jsonToInputFmt: extra JSON keys are ignored (only declared fields used)", () => {
  expect(jsonToInputFmt([{ name: "a", type: "uint64" }], { a: 1, unrelated: 99 })).toBe("1uint64");
});

test("encodeInputJson: a bad id surfaces the encode-time validation error", async () => {
  await expect(encodeInputJson([{ name: "dst", type: "id" }], { dst: "tooshort" })).rejects.toThrow(
    /id must be/,
  );
});

test("encodeInputJson: m256i field round-trips (64-hex -> 32 bytes)", async () => {
  const dg = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const b = await encodeInputJson([{ name: "d", type: "m256i" }], { d: dg });
  expect(b.length).toBe(32);
  expect(await decodeOutput(b, "m256i")).toBe(dg);
});

test("encodeInputJson: deep nested array-of-structs (positional) round-trips", async () => {
  const fields = [{ name: "xs", type: "[2;{ uint32, uint32 }]" }];
  const b = await encodeInputJson(fields, {
    xs: [
      [1, 2],
      [3, 4],
    ],
  });
  expect(await decodeOutput(b, "[2;{ uint32, uint32 }]")).toEqual([
    [1, 2],
    [3, 4],
  ]);
});

test("typed codec honors explicit field offsets", async () => {
  const padded: AbiStruct = {
    kind: AbiTypeKind.STRUCT,
    size: 24,
    align: 8,
    format: "wrong",
    fields: [
      {
        name: "tag",
        offset: 0,
        size: 1,
        type: {
          kind: AbiTypeKind.SCALAR,
          scalar: AbiScalarKind.UINT8,
          size: 1,
          align: 1,
          format: "wrong",
        },
      },
      {
        name: "value",
        offset: 16,
        size: 8,
        type: {
          kind: AbiTypeKind.SCALAR,
          scalar: AbiScalarKind.UINT64,
          size: 8,
          align: 8,
          format: "wrong",
        },
      },
    ],
  };

  const bytes = await encodeInputJson(padded, { tag: 7, value: 99n });
  expect(bytes.length).toBe(24);
  expect(bytes[0]).toBe(7);
  expect(bytes.slice(1, 16)).toEqual(new Uint8Array(15));
  expect(new DataView(bytes.buffer).getBigUint64(16, true)).toBe(99n);
  expect(await decodeOutput(bytes, padded)).toEqual([7, 99n]);
});

test("typed codec accepts direct scalar and array roots", async () => {
  const scalar: AbiType = {
    kind: AbiTypeKind.SCALAR,
    scalar: AbiScalarKind.UINT64,
    size: 8,
    align: 8,
    format: "uint64",
  };
  const array: AbiType = {
    kind: AbiTypeKind.ARRAY,
    count: 3,
    size: 6,
    align: 2,
    format: "[3;uint16]",
    element: {
      kind: AbiTypeKind.SCALAR,
      scalar: AbiScalarKind.UINT16,
      size: 2,
      align: 2,
      format: "uint16",
    },
  };

  const scalarBytes = await encodeInputJson(scalar, 42n);
  expect(await decodeOutput(scalarBytes, scalar)).toBe(42n);
  expect(jsonToInputFmt(scalar, 42n)).toBe("42uint64");
  let captured: number[] = [];
  const rpc = {
    querySmartContract: async (
      _contractIndex: number,
      _inputType: number,
      input: Uint8Array,
    ) => {
      captured = [...input];
      return input;
    },
  };
  expect(
    await callFunction(
      rpc as any,
      28,
      1,
      { type: scalar, value: 42n },
      scalar,
    ),
  ).toBe(42n);
  expect(captured).toEqual([...scalarBytes]);

  const arrayBytes = await encodeInputJson(array, [3, 5, 8]);
  expect(await decodeOutput(arrayBytes, array)).toEqual([3, 5, 8]);
  expect(jsonToInputFmt(array, [3, 5, 8])).toBe(
    "[3; 3uint16, 5uint16, 8uint16]",
  );
});

test("typed codec encodes an empty struct as one zero byte", async () => {
  const schema: AbiStruct = {
    kind: AbiTypeKind.STRUCT,
    size: 1,
    align: 1,
    format: "",
    fields: [],
  };

  expect(await encodeInputJson(schema, {})).toEqual(Uint8Array.of(0));
  expect(await decodeOutput(Uint8Array.of(0), schema)).toEqual([]);
  await expect(decodeOutput(new Uint8Array(0), schema)).rejects.toThrow(RangeError);
});

test("typed codec accepts a zero-length array", async () => {
  const schema: AbiStruct = {
    kind: AbiTypeKind.STRUCT,
    size: 0,
    align: 1,
    format: "wrong",
    fields: [
      {
        name: "values",
        offset: 0,
        size: 0,
        type: {
          kind: AbiTypeKind.ARRAY,
          count: 0,
          size: 0,
          align: 1,
          format: "wrong",
          element: {
            kind: AbiTypeKind.SCALAR,
            scalar: AbiScalarKind.UINT8,
            size: 1,
            align: 1,
            format: "wrong",
          },
        },
      },
    ],
  };

  const bytes = await encodeInputJson(schema, { values: [] });
  expect(bytes).toEqual(new Uint8Array());
  expect(await decodeOutput(bytes, schema)).toEqual([]);
});

test("overlapping input fields require one raw union view", async () => {
  const union: AbiStruct = {
    kind: AbiTypeKind.STRUCT,
    size: 8,
    align: 8,
    format: "wrong",
    fields: [
      {
        name: "wide",
        offset: 0,
        size: 8,
        type: {
          kind: AbiTypeKind.SCALAR,
          scalar: AbiScalarKind.UINT64,
          size: 8,
          align: 8,
          format: "wrong",
        },
      },
      {
        name: "narrow",
        offset: 0,
        size: 4,
        type: {
          kind: AbiTypeKind.SCALAR,
          scalar: AbiScalarKind.UINT32,
          size: 4,
          align: 4,
          format: "wrong",
        },
      },
    ],
  };

  await expect(
    encodeInputJson(union, { wide: 1n, narrow: 2 }),
  ).rejects.toThrow(/raw bytes/);

  const raw = new Uint8Array([5, 0, 0, 0, 0, 0, 0, 0]);
  expect(await encodeInputJson(union, raw)).toEqual(raw);
  expect(await encodeInputJson(union, [...raw])).toEqual(raw);
  await expect(
    encodeInputJson(union, [256, 0, 0, 0, 0, 0, 0, 0]),
  ).rejects.toThrow(/0 to 255/);
  expect(await decodeOutput(raw, union)).toEqual([5n, 5]);
});

test("typed container decode keeps nested field offsets", async () => {
  const value: AbiStruct = {
    kind: AbiTypeKind.STRUCT,
    size: 24,
    align: 8,
    format: "wrong",
    fields: [
      {
        name: "tag",
        offset: 0,
        size: 1,
        type: {
          kind: AbiTypeKind.SCALAR,
          scalar: AbiScalarKind.UINT8,
          size: 1,
          align: 1,
          format: "wrong",
        },
      },
      {
        name: "amount",
        offset: 16,
        size: 8,
        type: {
          kind: AbiTypeKind.SCALAR,
          scalar: AbiScalarKind.UINT64,
          size: 8,
          align: 8,
          format: "wrong",
        },
      },
    ],
  };
  const map: AbiType = {
    kind: AbiTypeKind.HASH_MAP,
    capacity: 1,
    key: {
      kind: AbiTypeKind.SCALAR,
      scalar: AbiScalarKind.UINT8,
      size: 1,
      align: 1,
      format: "wrong",
    },
    value,
    size: 56,
    align: 8,
    format: "wrong",
  };
  const bytes = new Uint8Array(map.size);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 3);
  view.setUint8(8, 7);
  view.setBigUint64(24, 99n, true);
  view.setBigUint64(32, 1n, true);
  view.setBigUint64(40, 2n, true);
  view.setBigUint64(48, 3n, true);

  expect(await decodeOutput(bytes, map)).toEqual([
    [[3, [7, 99n]]],
    [1n],
    2n,
    3n,
  ]);
});
