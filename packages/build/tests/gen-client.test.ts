// Client codegen: a typed method per fn/proc. A regression here produces a client that encodes the wrong
// args or maps the wrong output -> every call against the contract breaks. Drive real IDLs through
// extractIdl, then assert the generated source shape (flat-vs-raw params, single-vs-multi output, proc wiring).
import { test, expect } from "bun:test";
import { extractIdl } from "../src/idl";
import { generateClient } from "../src/gen-client";

const SRC = `
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Get_input {}; struct Get_output { uint64 value; };
  struct Sum_input { uint64 a; uint64 b; }; struct Sum_output { uint64 total; };
  struct Pair_input {}; struct Pair_output { uint64 x; uint64 y; };
  struct Blob_input { Array<uint64, 4> xs; }; struct Blob_output { uint64 n; };
  struct Inc_input {}; struct Inc_output {};
  struct Put_input { id k; uint64 v; }; struct Put_output {};
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

test("class + index default", () => { has("export class Demo {"); has("this.index = o.index ?? 28;"); });

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
  has(", 1, \"\", \"uint64\")");        // fnId 1, empty in fmt, uint64 out fmt
  has("return { value: r as bigint };");
});

test("flat scalar input: typed args + value-format template", () => {
  has("async Sum(args: Sum_input): Promise<Sum_output>");
  has("${args.a}uint64, ${args.b}uint64");
  has("return { total: r as bigint };");
});

test("multi-field output: positional array map", () => {
  has("const a = r as unknown[]; return { x: a[0] as bigint, y: a[1] as bigint };");
});

test("array/struct input falls back to a raw inFmt param", () => {
  has("async Blob(inFmt: string): Promise<Blob_output>");
});

test("procedure wiring: tick+8, confirm-by-default, typed return", () => {
  has("async Inc(opts:");                        // no-input proc: only opts
  has("procId: 1,");
  has("tick: (ti.tick ?? 0) + 8");
  has("confirm: opts.confirm !== false");
  has("async Put(args: Put_input, opts:");       // flat-input proc: typed args + opts
  has("${args.k}id, ${args.v}uint64");
});
