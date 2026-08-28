import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { QubicSimulator } from "@qinit/engine";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { compileContractWithTypeScript } from "../../src/index";
import { QPI_SNAPSHOT } from "../../src/generated/qpi-snapshot";

// Narrow-signed and 32-bit semantics were guarded only by the clang differentials: dropping the 32-bit
// compare mask, or sint8/sint32 from the signed set, or the signed 32-bit wrap, each passed all 979
// unit tests. Those differentials need a core checkout and the WASI SDK, so without one `bun test` is
// 1756 pass / 712 skip and none of this is checked — while the failure mode is a wrong number, not a
// broken build. This runs on the pinned qpi.h snapshot and the simulator, so it needs neither.
//
// Expectations come from BigInt.asIntN/asUintN rather than typed-out constants: an independent
// implementation of two's complement, not a transcription of what the compiler happens to emit. Every
// case avoids signed overflow, which is undefined in C++ and so cannot be asserted either way.
const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; };
  struct X_input {}; struct X_output {};

  // A negative value narrower than 64 bits must sign-extend when it is read back.
  struct SignExtend8_input {}; struct SignExtend8_output {};
  struct SignExtend8_locals { sint8 small; sint64 wide; };
  PUBLIC_PROCEDURE_WITH_LOCALS(SignExtend8) {
    locals.small = -5;
    locals.wide = locals.small;
    state.mut().result = (uint64)locals.wide;
  }

  struct SignExtend16_input {}; struct SignExtend16_output {};
  struct SignExtend16_locals { sint16 small; sint64 wide; };
  PUBLIC_PROCEDURE_WITH_LOCALS(SignExtend16) {
    locals.small = -300;
    locals.wide = locals.small;
    state.mut().result = (uint64)locals.wide;
  }

  struct SignExtend32_input {}; struct SignExtend32_output {};
  struct SignExtend32_locals { sint32 small; sint64 wide; };
  PUBLIC_PROCEDURE_WITH_LOCALS(SignExtend32) {
    locals.small = -70000;
    locals.wide = locals.small;
    state.mut().result = (uint64)locals.wide;
  }

  // Signed compare: a negative is below a positive. Unsigned compare would put it above.
  struct SignedCompare_input {}; struct SignedCompare_output {};
  struct SignedCompare_locals { sint32 a; sint32 b; uint64 out; };
  PUBLIC_PROCEDURE_WITH_LOCALS(SignedCompare) {
    locals.a = -1; locals.b = 1; locals.out = 0;
    if (locals.a < locals.b) locals.out += 1;
    if (locals.a <= locals.b) locals.out += 10;
    if (locals.b > locals.a) locals.out += 100;
    if (locals.a >= locals.b) locals.out += 1000;
    state.mut().result = locals.out;
  }

  // Right shift of a negative is arithmetic in C++ — a logical shift turns -16 into a huge positive.
  struct ArithShift_input {}; struct ArithShift_output {};
  struct ArithShift_locals { sint32 v; sint64 wide; };
  PUBLIC_PROCEDURE_WITH_LOCALS(ArithShift) {
    locals.v = -16;
    locals.wide = locals.v >> 2;
    state.mut().result = (uint64)locals.wide;
  }

  // Unsigned 32-bit wraparound is defined, so the truncation to 32 bits is assertable.
  struct Wrap32_input {}; struct Wrap32_output {};
  struct Wrap32_locals { uint32 a; uint32 b; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Wrap32) {
    locals.a = 4294967295u;
    locals.b = locals.a + 3u;
    state.mut().result = (uint64)locals.b;
  }

  // Comparing uint32 values across the 2^31 boundary: a signed compare gets this backwards.
  struct Unsigned32Compare_input {}; struct Unsigned32Compare_output {};
  struct Unsigned32Compare_locals { uint32 low; uint32 high; uint64 out; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Unsigned32Compare) {
    locals.low = 1u; locals.high = 4000000000u; locals.out = 0;
    if (locals.low < locals.high) locals.out += 1;
    if (locals.high > locals.low) locals.out += 10;
    state.mut().result = locals.out;
  }

  // Signed division truncates toward zero, and the remainder keeps the dividend's sign.
  struct SignedDivMod_input {}; struct SignedDivMod_output {};
  struct SignedDivMod_locals { sint64 q; sint64 r; };
  PUBLIC_PROCEDURE_WITH_LOCALS(SignedDivMod) {
    locals.q = div((sint64)-7, (sint64)2);
    locals.r = mod((sint64)-7, (sint64)2);
    state.mut().result = (uint64)(locals.q * 1000 + locals.r);
  }

  // Shift-left had no unit coverage at all: making it return a constant 0 broke 34 differential tests
  // and none of the 979 unit tests. Unsigned shifts are fully defined, so they can be pinned here.
  struct Shifts_input {}; struct Shifts_output {};
  struct Shifts_locals { uint64 a; uint64 b; uint32 narrow; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Shifts) {
    locals.a = 1;
    locals.b = locals.a << 5;
    locals.b += (locals.a << 63) >> 60;
    locals.narrow = 1u;
    locals.narrow = locals.narrow << 31;
    state.mut().result = locals.b + (uint64)locals.narrow;
  }

  // C++'s usual arithmetic conversions turn the signed operand unsigned when the other side is an
  // unsigned int of the same rank, so sint32(-2) < uint32(1) is FALSE. Comparing two sint32s never
  // exercises that, which is why the 32-bit compare mask survived the first version of this file.
  struct MixedCompare_input {}; struct MixedCompare_output {};
  struct MixedCompare_locals { sint32 negative; uint32 small; uint32 big; uint64 out; };
  PUBLIC_PROCEDURE_WITH_LOCALS(MixedCompare) {
    locals.negative = -2; locals.small = 1u; locals.big = 4294967295u; locals.out = 0;
    if (locals.negative < locals.small) locals.out += 1;
    locals.negative = -1;
    if (locals.negative == locals.big) locals.out += 10;
    state.mut().result = locals.out;
  }

  // A 32-bit sum stored straight into a 64-bit field: nothing narrows it on the way, so the wrap has to
  // happen in the arithmetic. Assigning through a uint32 local hides this — storeScalar truncates.
  struct WrapToWide_input {}; struct WrapToWide_output {};
  struct WrapToWide_locals { uint32 a; };
  PUBLIC_PROCEDURE_WITH_LOCALS(WrapToWide) {
    locals.a = 4294967295u;
    state.mut().result = (uint64)(locals.a + 3u);
  }

  // uint128 is two 64-bit halves, low at offset 0. Swapping which half .low and .high read is a
  // silent wrong number, and it was caught only by the differentials. Qswap's LiquidityInfo carries a
  // uint128, so this is reachable from shipping contracts.
  struct U128Halves_input {}; struct U128Halves_output {};
  struct U128Halves_locals { uint128 v; };
  PUBLIC_PROCEDURE_WITH_LOCALS(U128Halves) {
    locals.v = uint128(7, 3);
    state.mut().result = locals.v.low * 1000 + locals.v.high;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(U128Halves, 12);
    REGISTER_USER_PROCEDURE(MixedCompare, 10);
    REGISTER_USER_PROCEDURE(WrapToWide, 11);
    REGISTER_USER_PROCEDURE(Shifts, 9);
    REGISTER_USER_PROCEDURE(SignExtend8, 1);
    REGISTER_USER_PROCEDURE(SignExtend16, 2);
    REGISTER_USER_PROCEDURE(SignExtend32, 3);
    REGISTER_USER_PROCEDURE(SignedCompare, 4);
    REGISTER_USER_PROCEDURE(ArithShift, 5);
    REGISTER_USER_PROCEDURE(Wrap32, 6);
    REGISTER_USER_PROCEDURE(Unsigned32Compare, 7);
    REGISTER_USER_PROCEDURE(SignedDivMod, 8);
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

// Two's complement, computed rather than transcribed.
const u64 = (value: bigint) => BigInt.asUintN(64, value);
const sext = (bits: number, value: bigint) => BigInt.asIntN(bits, value);

describe("width and signedness — no core checkout required", () => {
    beforeAll(async () => {
        await initK12();
        const result = await compileContractWithTypeScript({
            source: SOURCE,
            contractName: "WidthSign",
            slot: 27,
            qpiHeader: QPI_SNAPSHOT,
            arenaSizeBytes: 1 << 20,
        });
        expect(result.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
        expect(WebAssembly.validate(result.wasm)).toBe(true);
        wasm = result.wasm;
    });

    test("a negative sint8 sign-extends to 64 bits", () => expect(run(1)).toBe(u64(sext(8, -5n))));
    test("a negative sint16 sign-extends to 64 bits", () => expect(run(2)).toBe(u64(sext(16, -300n))));
    test("a negative sint32 sign-extends to 64 bits", () => expect(run(3)).toBe(u64(sext(32, -70000n))));
    // 1 + 10 + 100: the first three comparisons hold and `a >= b` does not.
    test("signed comparison puts a negative below a positive", () => expect(run(4)).toBe(111n));
    test("right-shifting a negative is arithmetic, not logical", () => expect(run(5)).toBe(u64(sext(32, -16n) >> 2n)));
    // Same expectation as the widened case below, different path: here the sum lands in a uint32
    // local, so storeScalar truncates it. That is why this one does NOT catch a missing wrapL.
    test("unsigned 32-bit addition wraps at 2^32", () => expect(run(6)).toBe(BigInt.asUintN(32, 4294967295n + 3n)));
    // 1 + 10: both hold. A signed compare would read 4000000000u as negative and fail both.
    test("unsigned comparison holds across the 2^31 boundary", () => expect(run(7)).toBe(11n));
    test("signed division truncates toward zero and the remainder keeps its sign", () => expect(run(8)).toBe(u64((-7n / 2n) * 1000n + (-7n % 2n))));
    // -2 converts to 4294967294u so it is NOT below 1; -1 converts to 4294967295u so it IS equal to big.
    test("a signed operand converts to unsigned when compared with a uint32", () => expect(run(10)).toBe(10n));
    // Nothing narrows this one on the way to a uint64 field, so the wrap must happen in the
    // arithmetic itself. This is the case that catches a missing wrapL.
    test("a 32-bit sum widened to 64 bits has already wrapped", () => expect(run(11)).toBe(BigInt.asUintN(32, 4294967295n + 3n)));
    // uint128(high, low) per qpi.h's constructor order, so .low is 3 and .high is 7.
    test("uint128 .low and .high read their own halves", () => expect(run(12)).toBe(3n * 1000n + 7n));
    test("left shift shifts, at 64-bit and 32-bit width", () =>
        expect(run(9)).toBe(BigInt.asUintN(64, 1n << 5n) + BigInt.asUintN(64, (1n << 63n) >> 60n) + BigInt.asUintN(32, 1n << 31n)));
});
