import { expect, test } from "bun:test";
import wabtInit from "../../../compiler/node_modules/wabt";
import { SYSTEM_PROCEDURES } from "@qinit/core";
import { CONTRACT_ENTRY_KIND } from "../../src/contract/runtime";
import {
  EngineFaultedError,
  QubicSimulator,
} from "../../src/qubic-simulator";

async function compileWat(name: string, wat: string): Promise<Uint8Array> {
  const wabt = await wabtInit();
  const module = wabt.parseWat(name, wat);
  try {
    return new Uint8Array(module.toBinary({}).buffer);
  } finally {
    module.destroy();
  }
}

async function inputContract(inputSize = 4): Promise<Uint8Array> {
  return compileWat(
    "input-compat.wat",
    `(module
  (memory (export "memory") 4 4)
  (func (export "contract_index") (result i32) (i32.const 28))
  (func (export "state_addr") (result i32) (i32.const 0))
  (func (export "state_size") (result i32) (i32.const 0))
  (func (export "io_base") (result i32) (i32.const 65536))
  (func (export "io_size") (result i32) (i32.const 196608))
  (func (export "ctx_addr") (result i32) (i32.const 16))
  (func (export "reg_count") (result i32) (i32.const 1))
  (func (export "reg_info") (param $i i32) (param $out i32)
    (i32.store (local.get $out) (i32.const 1))
    (i32.store offset=4 (local.get $out) (i32.const 0))
    (i32.store offset=8 (local.get $out) (i32.const ${inputSize}))
    (i32.store offset=12 (local.get $out) (i32.const 4)))
  (func (export "reg_sysproc_mask") (result i32) (i32.const 2))
  (func (export "sysproc_locals_size") (param i32) (result i32) (i32.const 0))
  (func (export "sysproc_in_size") (param i32) (result i32) (i32.const ${inputSize}))
  (func (export "sysproc_out_size") (param i32) (result i32) (i32.const 4))
  (func (export "has_migrate") (result i32) (i32.const 0))
  (func (export "migrate_old_state_size") (result i32) (i32.const 0))
  (func (export "migrate_locals_size") (result i32) (i32.const 0))
  (func (export "dispatch") (param $kind i32) (param $it i32) (param $in i32) (param $out i32) (param $locals i32)
    (i32.store (local.get $out) (i32.load (local.get $in))))
  (func (export "_initialize")))`,
  );
}

async function mutatingFunctionContract(): Promise<Uint8Array> {
  return compileWat(
    "mutating-function.wat",
    `(module
  (import "lhost" "markDirty" (func $markDirty (param i32)))
  (memory (export "memory") 4 4)
  (func (export "contract_index") (result i32) (i32.const 28))
  (func (export "state_addr") (result i32) (i32.const 0))
  (func (export "state_size") (result i32) (i32.const 8))
  (func (export "io_base") (result i32) (i32.const 65536))
  (func (export "io_size") (result i32) (i32.const 196608))
  (func (export "ctx_addr") (result i32) (i32.const 16))
  (func (export "reg_count") (result i32) (i32.const 1))
  (func (export "reg_info") (param i32) (param $out i32)
    (i32.store (local.get $out) (i32.const 1))
    (i32.store offset=4 (local.get $out) (i32.const 0))
    (i32.store offset=8 (local.get $out) (i32.const 0))
    (i32.store offset=12 (local.get $out) (i32.const 0)))
  (func (export "reg_sysproc_mask") (result i32) (i32.const 0))
  (func (export "sysproc_locals_size") (param i32) (result i32) (i32.const 0))
  (func (export "sysproc_in_size") (param i32) (result i32) (i32.const 0))
  (func (export "sysproc_out_size") (param i32) (result i32) (i32.const 0))
  (func (export "has_migrate") (result i32) (i32.const 0))
  (func (export "migrate_old_state_size") (result i32) (i32.const 0))
  (func (export "migrate_locals_size") (result i32) (i32.const 0))
  (func (export "dispatch") (param i32 i32 i32 i32 i32)
    (call $markDirty (i32.const 28)))
  (func (export "_initialize")))`,
  );
}

async function rawOracleContract(): Promise<Uint8Array> {
  return compileWat(
    "raw-oracle.wat",
    `(module
  (import "lhost" "queryOracle" (func $queryOracle (param i32 i32 i32 i32 i32 i32 i64) (result i64)))
  (import "lhost" "getOracleQuery" (func $getOracleQuery (param i64 i32 i32) (result i32)))
  (import "lhost" "getOracleReply" (func $getOracleReply (param i64 i32 i32) (result i32)))
  (memory (export "memory") 4 4)
  (func (export "contract_index") (result i32) (i32.const 28))
  (func (export "state_addr") (result i32) (i32.const 0))
  (func (export "state_size") (result i32) (i32.const 0))
  (func (export "io_base") (result i32) (i32.const 65536))
  (func (export "io_size") (result i32) (i32.const 196608))
  (func (export "ctx_addr") (result i32) (i32.const 16))
  (func (export "reg_count") (result i32) (i32.const 3))
  (func (export "reg_info") (param $i i32) (param $out i32)
    (if (i32.eq (local.get $i) (i32.const 0))
      (then
        (i32.store (local.get $out) (i32.const 1))
        (i32.store offset=4 (local.get $out) (i32.const 1))
        (i32.store offset=8 (local.get $out) (i32.const 8))
        (i32.store offset=12 (local.get $out) (i32.const 8)))
      (else
        (if (i32.eq (local.get $i) (i32.const 1))
          (then
            (i32.store (local.get $out) (i32.const 2))
            (i32.store offset=4 (local.get $out) (i32.const 1))
            (i32.store offset=8 (local.get $out) (i32.const 32))
            (i32.store offset=12 (local.get $out) (i32.const 0)))
          (else
            (i32.store (local.get $out) (i32.const 3))
            (i32.store offset=4 (local.get $out) (i32.const 0))
            (i32.store offset=8 (local.get $out) (i32.const 12))
            (i32.store offset=12 (local.get $out) (i32.const 32)))))))
  (func (export "reg_sysproc_mask") (result i32) (i32.const 0))
  (func (export "sysproc_locals_size") (param i32) (result i32) (i32.const 0))
  (func (export "sysproc_in_size") (param i32) (result i32) (i32.const 0))
  (func (export "sysproc_out_size") (param i32) (result i32) (i32.const 0))
  (func (export "has_migrate") (result i32) (i32.const 0))
  (func (export "migrate_old_state_size") (result i32) (i32.const 0))
  (func (export "migrate_locals_size") (result i32) (i32.const 0))
  (func (export "dispatch") (param $kind i32) (param $it i32) (param $in i32) (param $out i32) (param $locals i32)
    (if (i32.eq (local.get $it) (i32.const 1))
      (then
        (i64.store (local.get $out)
          (call $queryOracle
            (i32.const 1)
            (i32.const 1024)
            (i32.const 8)
            (i32.const 16)
            (i32.const 2)
            (i32.const 60000)
            (i64.load (local.get $in))))))
    (if (i32.eq (local.get $it) (i32.const 3))
      (then
        (i32.store (local.get $out)
          (call $getOracleQuery
            (i64.load (local.get $in))
            (i32.add (local.get $out) (i32.const 8))
            (i32.load offset=8 (local.get $in))))
        (i32.store offset=4 (local.get $out)
          (call $getOracleReply
            (i64.load (local.get $in))
            (i32.add (local.get $out) (i32.const 16))
            (i32.load offset=8 (local.get $in)))))))
  (func (export "_initialize")))`,
  );
}

test("dispatch zero-fills a missing registered input byte", async () => {
  const sim = new QubicSimulator();
  sim.deploy(28, await inputContract(1));

  expect([...sim.query(28, 1, new Uint8Array([9]))]).toEqual([9, 0, 0, 0]);
  expect([...sim.query(28, 1)]).toEqual([0, 0, 0, 0]);
});

test("dispatch pads short inputs and truncates oversized inputs", async () => {
  const sim = new QubicSimulator();
  const contract = sim.deploy(28, await inputContract());

  expect([...sim.query(28, 1, new Uint8Array([1, 2, 3, 4]))]).toEqual([1, 2, 3, 4]);
  expect([...sim.query(28, 1)]).toEqual([0, 0, 0, 0]);
  expect([...sim.query(28, 1, new Uint8Array([5]))]).toEqual([5, 0, 0, 0]);

  const oversized = new Uint8Array([6, 7, 8, 9, 99]);
  expect([...sim.query(28, 1, oversized)]).toEqual([6, 7, 8, 9]);
  expect(new Uint8Array(contract.mem.buffer)[contract.ioBase + 4]).toBe(0);
  expect([...oversized]).toEqual([6, 7, 8, 9, 99]);
});

test("system and inter-contract dispatch use registered input sizes", async () => {
  const sim = new QubicSimulator();
  const contract = sim.deploy(28, await inputContract());

  expect([
    ...contract.invoke(
      CONTRACT_ENTRY_KIND.SYSPROC,
      SYSTEM_PROCEDURES.BEGIN_EPOCH,
      new Uint8Array([3]),
    ),
  ]).toEqual([
    3,
    0,
    0,
    0,
  ]);

  const call = sim.doCallFunction(
    29,
    28,
    1,
    new Uint8Array([4]),
    new Uint8Array(32),
  );
  expect(call.error).toBe(0);
  expect([...call.output]).toEqual([4, 0, 0, 0]);
});

test("a function that calls a mutating host import faults without changing state", async () => {
  const sim = new QubicSimulator();
  const contract = sim.deploy(28, await mutatingFunctionContract());

  expect(() => sim.query(28, 1)).toThrow(EngineFaultedError);
  expect(sim.faultInfo()).toMatchObject({
    phase: "contract-function",
    slot: 28,
    kind: CONTRACT_ENTRY_KIND.FUNCTION,
    entry: 1,
  });
  expect(contract.state()).toEqual(new Uint8Array(8));
  expect(() => sim.query(28, 1)).toThrow(EngineFaultedError);
});

test("raw oracle imports derive query fees and require exact read sizes", async () => {
  const sim = new QubicSimulator();
  sim.deploy(28, await rawOracleContract());
  sim.fund(sim.contractId(28), 100n);

  const feeInput = (fee: bigint) => {
    const input = new Uint8Array(8);
    new DataView(input.buffer).setBigInt64(0, fee, true);
    return input;
  };
  const readInput = (queryId: bigint, size: number) => {
    const input = new Uint8Array(12);
    const view = new DataView(input.buffer);
    view.setBigInt64(0, queryId, true);
    view.setUint32(8, size, true);
    return input;
  };

  const underpaidOutput = sim.procedure(28, 1, feeInput(0n));
  const overpaidOutput = sim.procedure(28, 1, feeInput(1_000n));
  const underpaid = new DataView(underpaidOutput.buffer).getBigInt64(0, true);
  const overpaid = new DataView(overpaidOutput.buffer).getBigInt64(0, true);
  expect([underpaid, overpaid]).toEqual([1n, 2n]);
  expect(sim.balance(sim.contractId(28))).toBe(80n);

  expect(sim.resolveOracle(underpaid, new Uint8Array(16))).toBe(true);
  const readFlags = (size: number) => {
    const output = sim.query(28, 3, readInput(underpaid, size));
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    return [view.getUint32(0, true), view.getUint32(4, true)];
  };
  expect(readFlags(7)).toEqual([0, 0]);
  expect(readFlags(8)).toEqual([1, 0]);
  expect(readFlags(16)).toEqual([0, 1]);
});
