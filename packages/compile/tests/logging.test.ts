import { CORE_PATH } from "../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { Sim, VirtualNode } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

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

describe("QPI LOG_* lowering", () => {
  beforeAll(initK12);

  test("emits all native severity imports with bytes before _terminator", async () => {
    const result = await compileContract({ source: SOURCE, name: "Logging", slot: 28, qpiHeader: HEADERS, arenaSz: 64 * 1024 });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(result.wasm as BufferSource));
    expect(imports.some((i) => i.module === "lhost" && i.name === "logBytes")).toBe(true);
    expect(imports.some((i) => i.module === "lhost" && i.name === "pauseLog")).toBe(true);
    expect(imports.some((i) => i.module === "lhost" && i.name === "resumeLog")).toBe(true);

    const sim = new Sim();
    sim.setDebug(true);
    sim.deploy(28, result.wasm);
    sim.procedure(28, 1, Uint8Array.of(42, 0, 0, 0, 0, 0, 0, 0));
    const logs = sim.getTrace().entries.at(-1)?.logs ?? [];
    expect(logs.map((l) => l.type)).toEqual([4, 5, 6, 7, 6]);
    expect(logs.every((l) => l.size === 17)).toBe(true);
    expect(logs.every((l) => l.hex.length === 34)).toBe(true);
  });

  test("the same import persists native records on VirtualNode", async () => {
    const result = await compileContract({ source: SOURCE, name: "Logging", slot: 28, qpiHeader: HEADERS, arenaSz: 64 * 1024 });
    const node = new VirtualNode({ mempool: false, fees: "off" });
    node.deploy(28, result.wasm, "Logging");
    const source = new Uint8Array(32).fill(1);
    node.fund(source, 1n);
    node.sim.applyTx(source, node.sim.contractId(28), 0n, 1, Uint8Array.of(42, 0, 0, 0, 0, 0, 0, 0), "tx");
    node.logger.finalizeTick(node.sim.tickN);
    const range = node.logger.range(node.sim.tickN, 0);
    expect(range).toEqual({ fromLogId: 0n, length: 4n });
    const records = node.logger.recordsBetween(0n, 3n)!;
    expect(new DataView(records.buffer).getUint32(26, true)).toBe(28);
  });

  test("rejects malformed payload structs", async () => {
    const source = SOURCE.replace("uint32 _contractIndex; uint32 _type; uint64 value; uint8 pad; sint8 _terminator;", "uint32 value; sint8 _terminator;");
    const result = await compileContract({ source, name: "BadLogging", slot: 28, qpiHeader: HEADERS, arenaSz: 64 * 1024 });
    expect(result.diagnostics.some((d) => d.severity === "error" && d.message.includes("at least 8 bytes"))).toBe(true);

    const missing = SOURCE.replace("sint8 _terminator;", "sint8 end;");
    const missingResult = await compileContract({ source: missing, name: "MissingTerminator", slot: 28, qpiHeader: HEADERS, arenaSz: 64 * 1024 });
    expect(missingResult.diagnostics.some((d) => d.severity === "error" && d.message.includes("must contain _terminator"))).toBe(true);

    const scalar = SOURCE.replace("LOG_ERROR(locals.message);", "LOG_ERROR(input.value);");
    const scalarResult = await compileContract({ source: scalar, name: "ScalarLog", slot: 28, qpiHeader: HEADERS, arenaSz: 64 * 1024 });
    expect(scalarResult.diagnostics.some((d) => d.severity === "error" && d.message.includes("must be a struct"))).toBe(true);
  });
});
