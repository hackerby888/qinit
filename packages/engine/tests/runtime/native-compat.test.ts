import { expect, test } from "bun:test";
import wabtInit from "../../../compile/node_modules/wabt";
import { KIND, SP } from "../../src/runtime";
import { Sim } from "../../src/sim";

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

test("dispatch zero-fills a missing registered input byte", async () => {
  const sim = new Sim();
  sim.deploy(28, await inputContract(1));

  expect([...sim.query(28, 1, new Uint8Array([9]))]).toEqual([9, 0, 0, 0]);
  expect([...sim.query(28, 1)]).toEqual([0, 0, 0, 0]);
});

test("dispatch pads short inputs and truncates oversized inputs", async () => {
  const sim = new Sim();
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
  const sim = new Sim();
  const contract = sim.deploy(28, await inputContract());

  expect([...contract.invoke(KIND.SYSPROC, SP.BEGIN_EPOCH, new Uint8Array([3]))]).toEqual([
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
