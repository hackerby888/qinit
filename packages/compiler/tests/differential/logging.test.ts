import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { QubicSimulator, VirtualNode } from "@qinit/engine";
import { QUBIC_LOG_TYPE } from "@qinit/proto";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = () => loadQpiHeader(CORE);

const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct LogMessage { uint32 _contractIndex; uint32 _type; uint64 value; uint8 pad; sint8 _terminator; };
  struct StateData { uint32 calls; };
  struct Emit_input { uint64 value; }; struct Emit_output {};
  struct Emit_locals { LogMessage message; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Emit) {
    locals.message._type = 9;
    locals.message.value = input.value;
    locals.message.pad = 3;
    LOG_ERROR(locals.message);
    LOG_WARNING(locals.message);
    LOG_INFO(locals.message);
    LOG_DEBUG(locals.message);
    LOG_PAUSE();
    LOG_INFO(locals.message);
    LOG_RESUME();
    state.mut().calls += 1;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Emit, 1); }
};`;

describe.skipIf(!HAS_CORE)("QPI LOG_* lowering", () => {
    beforeAll(initK12);

    test("emits all native severity imports with bytes before _terminator", async () => {
        const result = await compileContractWithTypeScript({
            source: SOURCE,
            contractName: "Logging",
            slot: 28,
            qpiHeader: HEADERS(),
            arenaSizeBytes: 64 * 1024,
        });
        expect(result.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toEqual([]);
        const imports = WebAssembly.Module.imports(new WebAssembly.Module(result.wasm as BufferSource));
        expect(imports.some((i) => i.module === "lhost" && i.name === "logBytes")).toBe(true);
        expect(imports.some((i) => i.module === "lhost" && i.name === "pauseLog")).toBe(true);
        expect(imports.some((i) => i.module === "lhost" && i.name === "resumeLog")).toBe(true);

        const sim = new QubicSimulator();
        sim.setDebug(true);
        sim.deploy(28, result.wasm);
        sim.procedure(28, 1, Uint8Array.of(42, 0, 0, 0, 0, 0, 0, 0));
        const logs = sim.getTrace().entries.at(-1)?.logs ?? [];
        expect(logs.map((l) => l.type)).toEqual([
            QUBIC_LOG_TYPE.CONTRACT_ERROR_MESSAGE,
            QUBIC_LOG_TYPE.CONTRACT_WARNING_MESSAGE,
            QUBIC_LOG_TYPE.CONTRACT_INFORMATION_MESSAGE,
            QUBIC_LOG_TYPE.CONTRACT_DEBUG_MESSAGE,
            QUBIC_LOG_TYPE.CONTRACT_INFORMATION_MESSAGE,
        ]);
        expect(logs.every((l) => l.size === 17)).toBe(true);
        expect(logs.every((l) => l.hex.length === 34)).toBe(true);
    });

    // The wasm SDK hands the payload to lh_logBytes untouched, so everything the contract wrote has
    // to survive being logged. Only the leading word moves, and only because the host owns it.
    test("every record carries the host's contract index, not the word the contract wrote", async () => {
        const source = SOURCE.replace("locals.message._type = 9;", "locals.message._contractIndex = 7;\n    locals.message._type = 9;");
        const result = await compileContractWithTypeScript({
            source,
            contractName: "Logging",
            slot: 28,
            qpiHeader: HEADERS(),
            arenaSizeBytes: 64 * 1024,
        });
        expect(result.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toEqual([]);

        const sim = new QubicSimulator();
        sim.setDebug(true);
        sim.deploy(28, result.wasm);
        sim.procedure(28, 1, Uint8Array.of(42, 0, 0, 0, 0, 0, 0, 0));
        const logs = sim.getTrace().entries.at(-1)?.logs ?? [];

        expect(logs).toHaveLength(5);
        // Core stamps the index before it records the payload, so the contract's own 7 reaches no record.
        expect(logs.map((l) => l.hex.slice(0, 8))).toEqual(["1c000000", "1c000000", "1c000000", "1c000000", "1c000000"]);
        // A zero here instead would be emission clobbering the word the host owns.
        expect(new Set(logs.map((l) => l.hex.slice(8))).size).toBe(1);
    });

    // The other half of core's contract: the stamp is cleared once the record is taken, so a contract
    // reading the word back sees a zero rather than its own index.
    test("the host clears the leading word once the record is taken", async () => {
        const source = SOURCE.replace("uint32 _contractIndex; uint32 _type;", "uint32 _contractIndex; uint32 seen;")
            .replace("locals.message._type = 9;", "locals.message.seen = 9;")
            .replace("LOG_WARNING(locals.message);", "locals.message.seen = locals.message._contractIndex;\n    LOG_WARNING(locals.message);");
        const result = await compileContractWithTypeScript({
            source,
            contractName: "Logging",
            slot: 28,
            qpiHeader: HEADERS(),
            arenaSizeBytes: 64 * 1024,
        });
        expect(result.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toEqual([]);

        const sim = new QubicSimulator();
        sim.setDebug(true);
        sim.deploy(28, result.wasm);
        sim.procedure(28, 1, Uint8Array.of(42, 0, 0, 0, 0, 0, 0, 0));
        const logs = sim.getTrace().entries.at(-1)?.logs ?? [];

        expect(logs).toHaveLength(5);
        // `seen` sits right behind the header word and holds what LOG_ERROR left there.
        expect(logs[1]!.hex.slice(8, 16)).toBe("00000000");
    });

    test("the same import persists native records on VirtualNode", async () => {
        const result = await compileContractWithTypeScript({
            source: SOURCE,
            contractName: "Logging",
            slot: 28,
            qpiHeader: HEADERS(),
            arenaSizeBytes: 64 * 1024,
        });
        const node = new VirtualNode({ mempool: false, fees: "off" });
        node.deploy(28, result.wasm, "Logging");
        const source = new Uint8Array(32).fill(1);
        node.fund(source, 1n);
        node.sim.processTickTransaction(source, node.sim.contractId(28), 0n, 1, Uint8Array.of(42, 0, 0, 0, 0, 0, 0, 0), "tx");
        node.advanceTick(1);
        const range = node.logger.range(node.sim.currentTick, 0);
        expect(range).toEqual({ fromLogId: 0n, length: 5n });
        const records = node.logger.recordsBetween(range.fromLogId + 1n, range.fromLogId + range.length - 1n)!;
        expect(new DataView(records.buffer).getUint32(26, true)).toBe(28);
    });

    // Analysis reports the misplaced header word as a fidelity finding; the compile driver is what
    // turns it into a rejection, so the corpus can still build a known-violating core contract.
    test("rejects a payload that parks data in the reserved word unless strict is off", async () => {
        const source = SOURCE.replace("uint32 _contractIndex; uint32 _type;", "uint64 counter;");
        const options = {
            source,
            contractName: "HeaderWord",
            slot: 28,
            qpiHeader: HEADERS(),
            arenaSizeBytes: 64 * 1024,
        };

        const strict = await compileContractWithTypeScript(options);
        const rejected = strict.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR);
        expect(rejected.map((d) => d.message)).toContain("__qinit_log_error payload must open with a 4-byte word reserved for the contract index");

        const relaxed = await compileContractWithTypeScript({ ...options, strict: false });
        expect(relaxed.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toEqual([]);
        expect(relaxed.wasm.length).toBeGreaterThan(0);
    });

    test("rejects malformed payload structs", async () => {
        const source = SOURCE.replace("uint32 _contractIndex; uint32 _type; uint64 value; uint8 pad; sint8 _terminator;", "uint32 value; sint8 _terminator;");
        const result = await compileContractWithTypeScript({
            source,
            contractName: "BadLogging",
            slot: 28,
            qpiHeader: HEADERS(),
            arenaSizeBytes: 64 * 1024,
        });
        expect(result.diagnostics.some((d) => d.severity === DiagnosticSeverity.ERROR && d.message.includes("at least 8 bytes"))).toBe(true);

        const missing = SOURCE.replace("sint8 _terminator;", "sint8 end;");
        const missingResult = await compileContractWithTypeScript({
            source: missing,
            contractName: "MissingTerminator",
            slot: 28,
            qpiHeader: HEADERS(),
            arenaSizeBytes: 64 * 1024,
        });
        expect(missingResult.diagnostics.some((d) => d.severity === DiagnosticSeverity.ERROR && d.message.includes("must contain _terminator"))).toBe(true);

        const scalar = SOURCE.replace("LOG_ERROR(locals.message);", "LOG_ERROR(input.value);");
        const scalarResult = await compileContractWithTypeScript({
            source: scalar,
            contractName: "ScalarLog",
            slot: 28,
            qpiHeader: HEADERS(),
            arenaSizeBytes: 64 * 1024,
        });
        expect(scalarResult.diagnostics.some((d) => d.severity === DiagnosticSeverity.ERROR && d.message.includes("must be a struct"))).toBe(true);
    });
});
