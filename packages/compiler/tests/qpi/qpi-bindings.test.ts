import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { LHOST_ABI } from "@qinit/core";
import { QubicSimulator } from "@qinit/engine";
import { compileContract, inspectWasmModule, loadQpiHeader } from "../../src";
import { ProgramAnalysis } from "../../src/analysis/program-analysis";
import { registerLibraryMetadata } from "../../src/backend/wasm/module/library-index";
import { getQpiContext } from "../../src/driver/qpi-context";
import { SemanticAnalyzer } from "../../src/analysis/semantic-analysis";

const CORE = CORE_PATH;
const HEADER = loadQpiHeader(CORE);

const wrap = (kind: "FUNCTION" | "PROCEDURE", body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct Run_input {};
  struct Run_output { id digest; sint64 result; };
  PUBLIC_${kind}(Run) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_${kind}(Run, 1); }
};`;

describe("typed QPI bindings", () => {
  beforeAll(initK12);

  test("import registry and QPI methods come from parsed core source", () => {
    const lib = getQpiContext(HEADER).lib;
    expect([...lib.importedFunctions.keys()].map((name) => name.slice("__lhost_".length))).toEqual(
      Object.keys(LHOST_ABI),
    );
    expect(lib.templateMethods.get("QpiContextFunctionCall")?.has("epoch")).toBe(true);
    expect(lib.templateMethods.get("QpiContextFunctionCall")?.has("nextId")).toBe(true);
    expect(lib.templateMethods.get("QpiContextFunctionCall")?.has("getOcInvocationStatus")).toBe(
      true,
    );
    expect(lib.templateMethods.get("QpiContextProcedureCall")?.has("transfer")).toBe(true);
    expect(lib.templateMethods.get("QpiContextProcedureCall")?.has("__qpiInvokeOC")).toBe(true);
    expect(lib.templateMethods.get("QpiContextProcedureCall")?.has("setShareholderVotes")).toBe(
      true,
    );
  });

  test("qualified QPI context types retain inherited method lookup", () => {
    const programAnalysis = new ProgramAnalysis(new SemanticAnalyzer());
    registerLibraryMetadata(programAnalysis, getQpiContext(HEADER).lib);

    expect(programAnalysis.globalStructs.has("QPI::QpiContextFunctionCall")).toBe(true);
    expect(
      programAnalysis.hasInstanceMethod(
        "QPI::QpiContextFunctionCall",
        "invocationReward",
      ),
    ).toBe(true);
  });

  test("const-reference scalar temporaries use a real sized buffer", async () => {
    const result = await compileContract({
      source: wrap("FUNCTION", "output.digest = qpi.K12((uint32)7);"),
      contractName: "QpiTemp",
      slot: 27,
      qpiHeader: HEADER,
      arenaSizeBytes: 1 << 20,
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toEqual([]);
    const sim = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    sim.deploy(27, result.wasm);
    expect(sim.query(27, 1).slice(0, 32)).not.toEqual(new Uint8Array(32));
  });

  test("aggregate, selector-default, narrow-scalar, contract-index, and output recipes compile", async () => {
    const functionResult = await compileContract({
      source: wrap(
        "FUNCTION",
        `
        Asset asset = { SELF, 0x4142434445464748ull };
        output.result = qpi.numberOfShares(asset);
        output.result += qpi.isAssetIssued(SELF, asset.assetName);
        output.result += qpi.dayOfWeek(1, 2, 3);
        output.digest = qpi.nextId(SELF);
      `,
      ),
      contractName: "QpiFunctionRecipes",
      slot: 27,
      qpiHeader: HEADER,
      arenaSizeBytes: 1 << 20,
    });
    expect(
      functionResult.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR),
    ).toEqual([]);

    const procedureResult = await compileContract({
      source: wrap(
        "PROCEDURE",
        `
        Asset asset = { SELF, 0x4142434445464748ull };
        output.result = qpi.burn(1);
        output.result += qpi.releaseShares(asset, SELF, SELF, 1, 2, 3, 4);
      `,
      ),
      contractName: "QpiProcedureRecipes",
      slot: 27,
      qpiHeader: HEADER,
      arenaSizeBytes: 1 << 20,
    });
    expect(
      procedureResult.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR),
    ).toEqual([]);
  });

  test("signed source-wrapper results preserve negative host failures", async () => {
    const result = await compileContract({
      source: wrap(
        "PROCEDURE",
        `
        output.result = qpi.transferShareOwnershipAndPossession(0x515049ull, SELF, SELF, SELF, 1, SELF) < 0;
      `,
      ),
      contractName: "QpiSignedResult",
      slot: 27,
      qpiHeader: HEADER,
      arenaSizeBytes: 1 << 20,
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toEqual([]);
    const sim = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    sim.deploy(27, result.wasm);
    const output = sim.procedure(27, 1);
    expect(
      new DataView(output.buffer, output.byteOffset, output.byteLength).getBigInt64(32, true),
    ).toBe(1n);
  });

  test("OC invocation and status use the v5 host bindings", async () => {
    const result = await compileContract({
      source: `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct Run_input { uint64 value; };
  struct Run_output { sint64 invocationId; uint8 status; };
  struct Run_locals { OCI::Mock::OcRequest request; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Run)
  {
    setMemory(locals.request, 0);
    locals.request.value = input.value;
    output.invocationId = INVOKE_OC(OCI::Mock, locals.request);
    output.status = qpi.getOcInvocationStatus(output.invocationId);
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Run, 1); }
};`,
      contractName: "QpiOcBindings",
      slot: 27,
      qpiHeader: HEADER,
      arenaSizeBytes: 1 << 20,
    });
    expect(
      result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR),
    ).toEqual([]);
    const imports = inspectWasmModule(result.wasm).imports
      .filter((entry) => entry.module === "lhost")
      .map((entry) => entry.name);
    expect(imports).toContain("invokeOc");
    expect(imports).toContain("getOcInvocationStatus");

    const sim = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    sim.deploy(27, result.wasm);
    const output = sim.procedure(27, 1);
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    expect(view.getBigInt64(0, true)).toBe(-1n);
    expect(view.getUint8(8)).toBe(0);
  });

  test("context violations and unknown bindings fail closed even with strict false", async () => {
    const context = await compileContract({
      source: wrap("FUNCTION", "output.result = qpi.burn(1);"),
      contractName: "QpiContextReject",
      slot: 27,
      qpiHeader: HEADER,
      strict: false,
    });
    expect(context.wasm).toHaveLength(0);
    expect(
      context.diagnostics.some((diagnostic) =>
        /burn|function context|QpiContextProcedureCall/i.test(diagnostic.message),
      ),
    ).toBe(true);

    const unknown = await compileContract({
      source: wrap("FUNCTION", "output.result = qpi.notAHostBinding();"),
      contractName: "QpiUnknownReject",
      slot: 27,
      qpiHeader: HEADER,
      strict: false,
    });
    expect(unknown.wasm).toHaveLength(0);
    expect(
      unknown.diagnostics.some((diagnostic) =>
        /notAHostBinding|unknown QPI binding|unknown member/i.test(diagnostic.message),
      ),
    ).toBe(true);

    const missing = await compileContract({
      source: wrap("FUNCTION", "output.result = qpi.isAssetIssued(SELF);"),
      contractName: "QpiMissingReject",
      slot: 27,
      qpiHeader: HEADER,
      strict: false,
    });
    expect(missing.wasm).toHaveLength(0);
    expect(
      missing.diagnostics.some((diagnostic) =>
        /expects 2|missing required argument/i.test(diagnostic.message),
      ),
    ).toBe(true);

    const nonAddressable = await compileContract({
      source: wrap("FUNCTION", "output.digest = qpi.nextId(7);"),
      contractName: "QpiAddressReject",
      slot: 27,
      qpiHeader: HEADER,
      strict: false,
    });
    expect(nonAddressable.wasm).toHaveLength(0);
    expect(
      nonAddressable.diagnostics.some((diagnostic) =>
        /not (?:an )?addressable/i.test(diagnostic.message),
      ),
    ).toBe(true);
  });
});
