import { describe, expect, test } from "bun:test";
import wabtInit from "../../../compile/node_modules/wabt";
import { WASM_ABI_VERSION } from "@qinit/core";
import { encodeDeploy, LITE_TX } from "@qinit/proto";
import { VirtualNode } from "../../src/transport";

type ContractIndexBody = "missing" | "malformed" | "trapping" | number;

async function artifact(contractIndex: ContractIndexBody): Promise<Uint8Array> {
  const contractIndexFunction =
    contractIndex === "missing"
      ? ""
      : contractIndex === "malformed"
        ? '  (func (export "contract_index") (param i32) (result i32) (local.get 0))'
        : contractIndex === "trapping"
          ? '  (func (export "contract_index") (result i32) unreachable)'
          : `  (func (export "contract_index") (result i32) (i32.const ${contractIndex}))`;
  const wat = `(module
  (memory (export "memory") 4 4)
  (global (export "arena_top") (mut i32) (i32.const 229376))
${contractIndexFunction}
  (func (export "state_addr") (result i32) (i32.const 0))
  (func (export "state_size") (result i32) (i32.const 8))
  (func (export "io_base") (result i32) (i32.const 65536))
  (func (export "io_size") (result i32) (i32.const 196608))
  (func (export "ctx_addr") (result i32) (i32.const 16))
  (func (export "reg_count") (result i32) (i32.const 0))
  (func (export "reg_info") (param i32 i32))
  (func (export "reg_sysproc_mask") (result i32) (i32.const 0))
  (func (export "sysproc_locals_size") (param i32) (result i32) (i32.const 0))
  (func (export "sysproc_in_size") (param i32) (result i32) (i32.const 0))
  (func (export "sysproc_out_size") (param i32) (result i32) (i32.const 0))
  (func (export "has_migrate") (result i32) (i32.const 0))
  (func (export "migrate_old_state_size") (result i32) (i32.const 0))
  (func (export "migrate_locals_size") (result i32) (i32.const 0))
  (func (export "dispatch") (param i32 i32 i32 i32 i32))
  (func (export "_initialize")))`;
  const wabt = await wabtInit();
  const module = wabt.parseWat("artifact-identity.wat", wat);
  try {
    return new Uint8Array(module.toBinary({}).buffer);
  } finally {
    module.destroy();
  }
}

describe("Wasm artifact slot identity", () => {
  test("accepts an exact () -> i32 export with the target slot", async () => {
    const node = await VirtualNode.create({ slotBase: 29, slotCount: 4 });

    expect(node.deploy(29, await artifact(29), "Exact").slot).toBe(29);
  });

  test.each([
    ["missing", "missing", "missing required contract_index export"],
    ["malformed", "malformed", "contract_index export must have signature () -> i32"],
    ["trapping", "trapping", "contract_index() failed for target 29"],
    ["wrong-index", 28, "artifact slot mismatch: compiled 28, target 29"],
  ] as const)("rejects a %s contract_index export", async (_label, value, message) => {
    const node = new VirtualNode({ slotBase: 29, slotCount: 4 });
    const wasm = await artifact(value);

    expect(() => node.deploy(29, wasm, "Rejected")).toThrow(message);
  });

  test("a mismatch leaves the resident instance, state, registry, and metadata unchanged", async () => {
    const node = await VirtualNode.create({ slotBase: 29, slotCount: 4 });
    const resident = node.deploy(29, await artifact(29), "Resident");
    resident.writeState(new Uint8Array([7, 8, 9]));
    const before = await node.dynRegistry();
    const mismatch = await artifact(28);

    expect(() => node.deploy(29, mismatch, "Replacement")).toThrow(
      "artifact slot mismatch: compiled 28, target 29",
    );

    expect(node.sim.contracts.get(29)).toBe(resident);
    expect([...resident.state().subarray(0, 3)]).toEqual([7, 8, 9]);
    expect(await node.dynRegistry()).toEqual(before);
    expect(node.slotOf("Resident")).toBe(29);
    expect(node.slotOf("Replacement")).toBeUndefined();
  });

  test("deployment transactions reject obsolete ABI versions before deployment", async () => {
    const node = new VirtualNode({ slotBase: 29, slotCount: 4 });
    const wasm = await artifact(29);
    (node as any).upload = {
      sessionId: 1n,
      totalSize: wasm.length,
      chunkCount: 1,
      buf: wasm,
      received: new Set([0]),
      finalHash: "00".repeat(32),
    };
    const deploy = encodeDeploy({
      sessionId: 1n,
      targetSlot: 29,
      finalHashHex: "00".repeat(32),
      abiVersion: WASM_ABI_VERSION - 1,
      name: "OldAbi",
    });

    expect(() => (node as any).handleDeployTx(LITE_TX.DEPLOY, deploy)).toThrow(
      `unsupported Wasm ABI version ${WASM_ABI_VERSION - 1}; expected ${WASM_ABI_VERSION}`,
    );
    expect(node.sim.contracts.has(29)).toBe(false);
    expect(node.slotOf("OldAbi")).toBeUndefined();
  });
});
