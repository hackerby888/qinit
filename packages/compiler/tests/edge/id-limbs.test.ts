import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { QubicSimulator } from "@qinit/engine";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { compileContractWithTypeScript } from "../../src/index";
import { QPI_SNAPSHOT } from "../../src/generated/qpi-snapshot";

// A 256-bit id is addressable as 4x uint64, 8x uint32, 16x uint16 or 32x uint8. Collapsing every limb
// offset to zero — so `.u64._1` returns the same bytes as `._0` — passed the entire suite, because
// nothing in the repo read a limb past `._0`. differential/limb-diff.test.ts closes that against clang,
// but it needs a core checkout; this covers the same ground on the pinned snapshot and the simulator so
// the fast loop catches it too.
//
// Expected values are read out of the same input bytes with a DataView — an independent implementation
// of "limb N is bytes 8N..8N+7, little-endian" rather than constants copied from the compiler's output.
const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 a; uint64 b; uint64 c; uint64 d; };
  struct Read_input { id who; }; struct Read_output {};
  PUBLIC_PROCEDURE(Read) {
    state.mut().a = input.who.u64._0;
    state.mut().b = input.who.u64._1;
    state.mut().c = input.who.u64._2;
    state.mut().d = input.who.u64._3;
  }
  struct Narrow_input { id who; }; struct Narrow_output {};
  PUBLIC_PROCEDURE(Narrow) {
    state.mut().a = input.who.u32._1;
    state.mut().b = input.who.u32._7;
    state.mut().c = input.who.u8._1;
    state.mut().d = input.who.u8._31;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Read, 1);
    REGISTER_USER_PROCEDURE(Narrow, 2);
  }
};`;

let wasm: Uint8Array;

// Deliberately distinct per byte, so a collapsed limb offset cannot coincide with the right answer.
const ID_BYTES = new Uint8Array(32).map((_, index) => (index * 7 + 3) & 0xff);
const view = new DataView(ID_BYTES.buffer, ID_BYTES.byteOffset, ID_BYTES.byteLength);

function run(inputType: number): bigint[] {
    const sim = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    sim.fund(user, 1_000_000n);
    sim.deploy(27, wasm);
    sim.procedure(27, inputType, ID_BYTES, { invocator: user });
    const state = sim.contracts.get(27)!.state();
    const out = new DataView(state.buffer, state.byteOffset, state.byteLength);
    return [0, 1, 2, 3].map((index) => out.getBigUint64(index * 8, true));
}

describe("id limb views — no core checkout required", () => {
    beforeAll(async () => {
        await initK12();
        const result = await compileContractWithTypeScript({
            source: SOURCE,
            contractName: "IdLimbs",
            slot: 27,
            qpiHeader: QPI_SNAPSHOT,
            arenaSizeBytes: 1 << 20,
        });
        expect(result.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
        wasm = result.wasm;
    });

    test("each u64 limb reads its own eight bytes", () => {
        expect(run(1)).toEqual([0, 1, 2, 3].map((index) => view.getBigUint64(index * 8, true)));
    });

    test("the four u64 limbs are not all the same value", () => {
        expect(new Set(run(1)).size).toBe(4);
    });

    test("narrower views index the same bytes", () => {
        const [u32lo, u32hi, u8lo, u8hi] = run(2);
        expect(u32lo).toBe(BigInt(view.getUint32(1 * 4, true)));
        expect(u32hi).toBe(BigInt(view.getUint32(7 * 4, true)));
        expect(u8lo).toBe(BigInt(view.getUint8(1)));
        expect(u8hi).toBe(BigInt(view.getUint8(31)));
    });
});
