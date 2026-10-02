// A library helper that names a nested struct's constant relative to its own struct (EvmLogRead::isSupportedChain reads `ChainId::ethereum`)
// compiles to the value clang computes, instead of an unknown identifier.
import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { QubicSimulator } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";

const SLOT = 27;

describe.skipIf(!HAS_CORE)("library constants named relative to their struct", () => {
    beforeAll(async () => {
        await initK12();
    });

    test("EvmLogRead::isSupportedChain answers as clang does", async () => {
        const source = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 a; };
  struct Get_input {}; struct Get_output { uint64 mask; };
  PUBLIC_FUNCTION(Get) {
    output.mask = (OI::EvmLogRead::isSupportedChain(1) ? 1 : 0) | (OI::EvmLogRead::isSupportedChain(11155111) ? 2 : 0)
        | (OI::EvmLogRead::isSupportedChain(42161) ? 4 : 0) | (OI::EvmLogRead::isSupportedChain(2) ? 8 : 0);
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
};`;
        const compiled = await compileContractWithTypeScript({ source, contractName: "T", slot: SLOT, qpiHeader: loadQpiHeader(CORE_PATH), arenaSizeBytes: 1 << 20 });
        expect(compiled.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR).map((diagnostic) => diagnostic.message)).toEqual([]);

        const sim = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
        sim.deploy(SLOT, compiled.wasm);
        const out = sim.query(SLOT, 1);
        expect(new DataView(out.buffer, out.byteOffset, out.byteLength).getBigUint64(0, true)).toBe(7n);
    });
});
