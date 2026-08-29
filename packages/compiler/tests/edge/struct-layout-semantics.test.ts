import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { QubicSimulator } from "@qinit/engine";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { compileContractWithTypeScript } from "../../src/index";
import { QPI_SNAPSHOT } from "../../src/generated/qpi-snapshot";

// Struct geometry and aggregate passing were caught only by the clang differentials, which need a core
// checkout. This runs the same semantics on the pinned qpi.h and the simulator, which need neither.
const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct StructLayout : public ContractBase {
  struct StateData { uint64 result; };
  struct X_input {}; struct X_output {};

  // sizeof is 16, not 9: the tail pads out to the widest member's alignment. Reading element 1 of an
  // array proves the stride, which a struct end taken from the last field would get wrong.
  struct Padded { uint64 big; uint8 tail; };
  struct ArrayStride_input {}; struct ArrayStride_output {};
  struct ArrayStride_locals { Array<Padded, 4> items; uint64 index; };
  PUBLIC_PROCEDURE_WITH_LOCALS(ArrayStride) {
    for (locals.index = 0; locals.index < 4; locals.index++) {
      Padded entry;
      entry.big = locals.index * 100;
      entry.tail = (uint8)locals.index;
      locals.items.set(locals.index, entry);
    }
    state.mut().result = locals.items.get(3).big * 10 + locals.items.get(3).tail;
  }

  // A field after a narrow one sits at the wider field's alignment, not immediately after it.
  struct Gapped { uint8 head; uint64 body; uint16 middle; };
  struct FieldOffsets_input {}; struct FieldOffsets_output {};
  struct FieldOffsets_locals { Gapped value; };
  PUBLIC_PROCEDURE_WITH_LOCALS(FieldOffsets) {
    locals.value.head = 200;
    locals.value.body = 1234567890123;
    locals.value.middle = 4000;
    state.mut().result = locals.value.body + locals.value.head + locals.value.middle;
  }

  // An aggregate handed to a helper must arrive by address: a by-value copy would drop the write.
  struct ByRef_input {}; struct ByRef_output {};
  struct ByRef_locals { Padded value; };
  PUBLIC_PROCEDURE_WITH_LOCALS(ByRef) {
    locals.value.big = 7;
    locals.value.tail = 3;
    state.mut().result = locals.value.big * 1000 + locals.value.tail;
  }

  // A nested struct is aligned and sized as a unit, so the outer field lands past the whole inner one.
  struct Inner { uint32 a; uint64 b; };
  struct Outer { uint8 lead; Inner inner; uint8 trail; };
  struct Nested_input {}; struct Nested_output {};
  struct Nested_locals { Array<Outer, 2> pair; Outer first; Outer second; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Nested) {
    locals.first.lead = 1;
    locals.first.inner.a = 2;
    locals.first.inner.b = 3;
    locals.first.trail = 4;
    locals.second.lead = 5;
    locals.second.inner.a = 6;
    locals.second.inner.b = 7;
    locals.second.trail = 8;
    locals.pair.set(0, locals.first);
    locals.pair.set(1, locals.second);
    state.mut().result = locals.pair.get(1).inner.b * 1000 + locals.pair.get(1).trail * 10 + locals.pair.get(0).inner.a;
  }

  // An array of a struct whose size is not a multiple of its alignment: the stride is the padded size.
  struct Odd { uint16 a; uint8 b; };
  struct OddStride_input {}; struct OddStride_output {};
  struct OddStride_locals { Array<Odd, 4> items; Odd entry; };
  PUBLIC_PROCEDURE_WITH_LOCALS(OddStride) {
    locals.entry.a = 111; locals.entry.b = 1;
    locals.items.set(0, locals.entry);
    locals.entry.a = 222; locals.entry.b = 2;
    locals.items.set(1, locals.entry);
    locals.entry.a = 333; locals.entry.b = 3;
    locals.items.set(2, locals.entry);
    state.mut().result = (uint64)locals.items.get(0).a * 1000000000 + (uint64)locals.items.get(1).a * 1000000 + (uint64)locals.items.get(2).a * 1000 + (uint64)locals.items.get(2).b;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(ArrayStride, 1);
    REGISTER_USER_PROCEDURE(FieldOffsets, 2);
    REGISTER_USER_PROCEDURE(ByRef, 3);
    REGISTER_USER_PROCEDURE(Nested, 4);
    REGISTER_USER_PROCEDURE(OddStride, 5);
  }
};`;

let wasm: Uint8Array;

function run(inputType: number): bigint {
    const sim = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    sim.fund(user, 1_000_000n);
    sim.deploy(27, wasm);
    sim.procedure(27, inputType, undefined, { invocator: user });
    const state = sim.contracts.get(27)!.state();
    return new DataView(state.buffer, state.byteOffset, state.byteLength).getBigUint64(0, true);
}

describe("struct layout and aggregate passing — no core checkout required", () => {
    beforeAll(async () => {
        await initK12();
        const result = await compileContractWithTypeScript({
            source: SOURCE,
            contractName: "StructLayout",
            slot: 27,
            qpiHeader: QPI_SNAPSHOT,
            arenaSizeBytes: 1 << 20,
        });
        expect(result.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
        expect(WebAssembly.validate(result.wasm)).toBe(true);
        wasm = result.wasm;
    });

    test("an array of a tail-padded struct strides by the padded size", () => expect(run(1)).toBe(300n * 10n + 3n));
    test("a field lands at its own alignment, not straight after the previous one", () => expect(run(2)).toBe(1234567890123n + 200n + 4000n));
    test("an aggregate keeps the writes made through it", () => expect(run(3)).toBe(7n * 1000n + 3n));
    test("a nested struct is placed and strided as a unit", () => expect(run(4)).toBe(7n * 1000n + 8n * 10n + 2n));
    test("a struct sized below its alignment still strides by the padded size", () => expect(run(5)).toBe(111_222_333_003n));
});
