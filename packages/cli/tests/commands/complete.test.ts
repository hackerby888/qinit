import { test, expect } from "bun:test";
import {
  AbiScalarKind,
  AbiTypeKind,
  type AbiField,
  type AbiStruct,
  type AbiType,
} from "@qinit/proto/contract-idl";
import { completerFor, zeroSample, tmplOf } from "../../src/commands/call-interactive";

const SIZES: Record<AbiScalarKind, number> = {
  [AbiScalarKind.BIT]: 1,
  [AbiScalarKind.ID]: 32,
  [AbiScalarKind.M256I]: 32,
  [AbiScalarKind.UINT8]: 1,
  [AbiScalarKind.UINT16]: 2,
  [AbiScalarKind.UINT32]: 4,
  [AbiScalarKind.UINT64]: 8,
  [AbiScalarKind.UINT128]: 16,
  [AbiScalarKind.SINT8]: 1,
  [AbiScalarKind.SINT16]: 2,
  [AbiScalarKind.SINT32]: 4,
  [AbiScalarKind.SINT64]: 8,
  [AbiScalarKind.SINT128]: 16,
};

const scalar = (kind: AbiScalarKind): AbiType => ({
  kind: AbiTypeKind.SCALAR,
  scalar: kind,
  size: SIZES[kind],
  align: Math.min(SIZES[kind], 8),
  format: kind,
});

const field = (name: string, type: AbiType, offset = 0): AbiField => ({
  name,
  offset,
  size: type.size,
  type,
});

const input = (...fields: AbiField[]): AbiStruct => ({
  kind: AbiTypeKind.STRUCT,
  size: fields.reduce((size, item) => Math.max(size, item.offset + item.size), 0),
  align: fields.length ? Math.max(...fields.map((item) => item.type.align)) : 1,
  format: fields.map((item) => item.type.format).join(", "),
  fields,
});

const entry = (schema?: AbiType) => ({
  kind: "fn" as const,
  inputType: 1,
  inputSize: schema?.size ?? 0,
  outputSize: 0,
  input: schema,
});

test("zeroSample builds typed schema-matched values", () => {
  expect(
    zeroSample(entry(input(field("value", scalar(AbiScalarKind.UINT64))))),
  ).toBe("0uint64");

  const array: AbiType = {
    kind: AbiTypeKind.ARRAY,
    count: 64,
    element: scalar(AbiScalarKind.UINT64),
    size: 512,
    align: 8,
    format: "[64;uint64]",
  };
  expect(
    zeroSample(
      entry(
        input(
          field("values", array),
          field("owner", scalar(AbiScalarKind.ID), 512),
        ),
      ),
    ),
  ).toBe(`[64; 0uint64 ×64], ${"0".repeat(64)}id`);
});

test("zeroSample handles empty and uint128 inputs", () => {
  expect(zeroSample(entry(input()))).toBe(null);
  expect(zeroSample(entry())).toBe(null);
  expect(
    zeroSample(entry(scalar(AbiScalarKind.UINT128))),
  ).toBe("0uint128");
});

test("zeroSample uses one raw byte view for overlapping input", () => {
  const wide = scalar(AbiScalarKind.UINT64);
  const union = input(
    field("wide", wide),
    field("narrow", scalar(AbiScalarKind.UINT32)),
  );

  expect(zeroSample(entry(input(field("data", union))))).toBe(
    "[8; 0uint8 ×8]",
  );
});

test("tmplOf shows field names and formats", () => {
  const fields = [
    field("reveal", {
      kind: AbiTypeKind.ARRAY,
      count: 64,
      element: scalar(AbiScalarKind.UINT64),
      size: 512,
      align: 8,
      format: "[64; uint64]",
    }),
    field("commit", scalar(AbiScalarKind.ID), 512),
  ];
  expect(tmplOf(fields)).toBe("<reveal>[64; uint64], <commit>id");
  expect(tmplOf([])).toBeUndefined();
  expect(tmplOf(undefined)).toBeUndefined();
});

test("completerFor prefers the field's scalar type", () => {
  const complete = completerFor([
    field("who", scalar(AbiScalarKind.ID)),
    field("amount", scalar(AbiScalarKind.UINT32), 32),
  ]);
  expect(complete("<id>id, 1u")).toBe("<id>id, 1uint32");
  expect(complete("1u")).toBe("1uint64");
});

test("completerFor falls back to generic scalar types", () => {
  const complete = completerFor(undefined);
  expect(complete("1u")).toBe("1uint64");
  expect(complete("5sint")).toBe("5sint64");
  expect(complete("9")).toBe(null);

  const expected = completerFor([field("n", scalar(AbiScalarKind.UINT32))]);
  expect(expected("1uint6")).toBe("1uint64");
});
