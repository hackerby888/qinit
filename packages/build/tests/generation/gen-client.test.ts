// Verify that each generated method encodes typed inputs and maps outputs correctly.
import { test, expect } from "bun:test";
import {
  AbiScalarKind,
  AbiTypeKind,
  type AbiType,
} from "@qinit/proto/contract-idl";
import { Transpiler } from "bun";
import { extractIdl } from "../../src/idl";
import { generateClient } from "../../src/gen-client";

const SRC = `
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Get_input {}; struct Get_output { uint64 value; };
  struct Sum_input { uint64 a; uint64 b; }; struct Sum_output { uint64 total; };
  struct Pair_input {}; struct Pair_output { uint64 x; uint64 y; };
  struct Blob_input { Array<uint64, 4> xs; }; struct Blob_output { uint64 n; };
  struct Inc_input {}; struct Inc_output {};
  struct Put_input { id k; uint64 v; }; struct Put_output {};
  PUBLIC_FUNCTION(Get) {}
  PUBLIC_FUNCTION(Sum) {}
  PUBLIC_FUNCTION(Pair) {}
  PUBLIC_FUNCTION(Blob) {}
  PUBLIC_PROCEDURE(Inc) {}
  PUBLIC_PROCEDURE(Put) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Get, 1);
    REGISTER_USER_FUNCTION(Sum, 2);
    REGISTER_USER_FUNCTION(Pair, 3);
    REGISTER_USER_FUNCTION(Blob, 4);
    REGISTER_USER_PROCEDURE(Inc, 1);
    REGISTER_USER_PROCEDURE(Put, 2);
  }
};`;
const out = generateClient(extractIdl(SRC, "Demo"), 28);

const has = (s: string) => expect(out.includes(s)).toBe(true);

const uint64Root: AbiType = {
  kind: AbiTypeKind.SCALAR,
  scalar: AbiScalarKind.UINT64,
  size: 8,
  align: 8,
  format: "uint64",
};
const uint16ArrayRoot: AbiType = {
  kind: AbiTypeKind.ARRAY,
  count: 2,
  size: 4,
  align: 2,
  format: "[2;uint16]",
  element: {
    kind: AbiTypeKind.SCALAR,
    scalar: AbiScalarKind.UINT16,
    size: 2,
    align: 2,
    format: "uint16",
  },
};
const rowArrayRoot: AbiType = {
  kind: AbiTypeKind.ARRAY,
  count: 2,
  size: 16,
  align: 8,
  format: "[2;{uint64}]",
  element: {
    kind: AbiTypeKind.STRUCT,
    size: 8,
    align: 8,
    format: "uint64",
    fields: [
      {
        name: "amount",
        offset: 0,
        size: 8,
        type: uint64Root,
      },
    ],
  },
};
const rootBase = extractIdl(SRC, "RootDemo");
const directRootClient = generateClient(
  {
    ...rootBase,
    functions: [
      {
        ...rootBase.functions[0],
        name: "DirectScalar",
        inputType: 10,
        inSize: uint64Root.size,
        outSize: uint64Root.size,
        input: uint64Root,
        output: uint64Root,
      },
      {
        ...rootBase.functions[1],
        name: "DirectRows",
        inputType: 11,
        inSize: uint16ArrayRoot.size,
        outSize: rowArrayRoot.size,
        input: uint16ArrayRoot,
        output: rowArrayRoot,
      },
      {
        ...rootBase.functions[0],
        name: "Empty",
        inputType: 12,
        inSize: 0,
        outSize: 0,
        input: rootBase.functions[0].input,
        output: rootBase.procedures[0].output,
      },
    ],
    procedures: [
      {
        ...rootBase.procedures[0],
        name: "DirectProcedure",
        inputType: 10,
        inSize: uint64Root.size,
        input: uint64Root,
      },
    ],
  },
  28,
);

test("class + index default", () => {
  has("export class Demo {");
  has("this.index = o.index ?? 28;");
});

test("runtimeImport emits a self-contained client (./runtime, no unpublished @qinit/* imports)", () => {
  // `qinit gen` / `qinit test` pass runtimeImport so the output works outside the monorepo (the @qinit/*
  // packages are unpublished); without it the client imports @qinit/core + @qinit/proto.
  const sc = generateClient(extractIdl(SRC, "Demo"), 28, { runtimeImport: "./runtime" });
  expect(sc).toContain('import { LiteRpc, callFunction, invokeProcedure } from "./runtime";');
  expect(sc).not.toContain("@qinit/");
  expect(out).toContain("@qinit/"); // the default (no runtimeImport) does import @qinit/*
});

test("no-input function: no args param, single-output map", () => {
  has("async Get(): Promise<Get_output>");
  has(
    "1, { type: Get_function_input_schema, value: {} }, Get_function_output_schema)",
  );
  has("return { value: r as bigint };");
});

test("flat scalar input uses the embedded typed schema", () => {
  has("async Sum(args: Sum_input): Promise<Sum_output>");
  has(
    "2, { type: Sum_function_input_schema, value: args }, Sum_function_output_schema)",
  );
  has("return { total: r as bigint };");
});

test("multi-field output: positional array map", () => {
  has("const a = r as unknown[]; return { x: a[0] as bigint, y: a[1] as bigint };");
});

test("array input stays typed", () => {
  has("async Blob(args: Blob_input): Promise<Blob_output>");
  has(
    "4, { type: Blob_function_input_schema, value: args }, Blob_function_output_schema)",
  );
});

test("scalar and array roots use direct aliases, arguments, and results", () => {
  expect(() => {
    new Transpiler({ loader: "ts" }).transformSync(directRootClient);
  }).not.toThrow();
  expect(directRootClient).toContain("export type DirectScalar_input = bigint;");
  expect(directRootClient).toContain("export type DirectScalar_output = bigint;");
  expect(directRootClient).toContain(
    "async DirectScalar(args: DirectScalar_input): Promise<DirectScalar_output>",
  );
  expect(directRootClient).toContain("value: args");
  expect(directRootClient).toContain("return r as bigint;");

  expect(directRootClient).toContain("export type DirectRows_input = number[];");
  expect(directRootClient).toContain(
    "export type DirectRows_output = { amount: bigint }[];",
  );
  expect(directRootClient).toContain(
    "async DirectRows(args: DirectRows_input): Promise<DirectRows_output>",
  );
  expect(directRootClient).toContain(
    "return (r as unknown[]).map((element) => ((s) => ({ amount: s[0] as bigint }))(element as unknown[]));",
  );

  expect(directRootClient).toContain("export interface Empty_input {}");
  expect(directRootClient).toContain("export interface Empty_output {}");
  expect(directRootClient).toContain("async Empty(): Promise<Empty_output>");
  expect(directRootClient).toContain("return {};");

  expect(directRootClient).toContain(
    "export type DirectProcedure_input = bigint;",
  );
  expect(directRootClient).toContain(
    "async DirectProcedure(args: DirectProcedure_input, opts:",
  );
  expect(directRootClient).toContain(
    "input: { type: DirectProcedure_procedure_input_schema, value: args }",
  );
});

test("procedure wiring: tick+8, confirm-by-default, typed return", () => {
  has("async Inc(opts:"); // no-input proc: only opts
  has("procId: 1,");
  has("tick: (ti.tick ?? 0) + 8");
  has("confirm: opts.confirm !== false");
  has("async Put(args: Put_input, opts:"); // flat-input proc: typed args + opts
  has("input: { type: Put_procedure_input_schema, value: args }");
});

test("overlapping procedure input is exposed as raw bytes", () => {
  const base = extractIdl(SRC, "Demo");
  const procedure = base.procedures.find((entry) => entry.name === "Put")!;
  const unionClient = generateClient(
    {
      ...base,
      procedures: [
        {
          ...procedure,
          inSize: 8,
          input: {
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
          },
        },
      ],
    },
    28,
  );

  expect(unionClient).toContain("export type Put_input = Uint8Array;");
  expect(unionClient).toContain("async Put(args: Put_input, opts:");
});
