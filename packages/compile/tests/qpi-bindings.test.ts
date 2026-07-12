import { CORE_PATH } from "../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "../src";
import { QPI_AGGREGATE_LAYOUTS, QPI_BINDINGS } from "../src/codegen/calls/qpi";

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

  test("registry names and compiler symbols are unique and fully typed", () => {
    const names = Object.keys(QPI_BINDINGS);
    const symbols = Object.values(QPI_BINDINGS).map((binding) => binding.fwd);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(symbols).size).toBe(symbols.length);
    for (const binding of Object.values(QPI_BINDINGS)) {
      expect(binding.source.length).toBeGreaterThan(0);
      expect(["function", "procedure", "both"]).toContain(binding.context);
      expect(["value", "address", "void"]).toContain(binding.channel);
      if (binding.ret === "out") expect(binding.outSize).toBeGreaterThan(0);
    }
    expect(QPI_AGGREGATE_LAYOUTS.Asset.fields).toEqual({ issuer: 0, assetName: 32 });
    expect(QPI_AGGREGATE_LAYOUTS.AssetSelect.fields).toEqual({ id: 0, managingContract: 32, anyId: 34, anyManagingContract: 35 });
  });

  test("const-reference scalar temporaries use a real sized buffer", async () => {
    const result = await compileContract({
      source: wrap("FUNCTION", "output.digest = qpi.K12((uint32)7);"),
      name: "QpiTemp",
      slot: 27,
      qpiHeader: HEADER,
      arenaSz: 1 << 20,
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
    sim.deploy(27, result.wasm);
    expect(sim.query(27, 1).slice(0, 32)).not.toEqual(new Uint8Array(32));
  });

  test("aggregate, selector-default, narrow-scalar, contract-index, and output recipes compile", async () => {
    const functionResult = await compileContract({
      source: wrap("FUNCTION", `
        Asset asset = { SELF, 0x4142434445464748ull };
        output.result = qpi.numberOfShares(asset);
        output.result += qpi.isAssetIssued(SELF, asset.assetName);
        output.result += qpi.dayOfWeek(1, 2, 3);
        output.digest = qpi.nextId(SELF);
      `),
      name: "QpiFunctionRecipes",
      slot: 27,
      qpiHeader: HEADER,
      arenaSz: 1 << 20,
    });
    expect(functionResult.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    const procedureResult = await compileContract({
      source: wrap("PROCEDURE", `
        Asset asset = { SELF, 0x4142434445464748ull };
        output.result = qpi.burn(1);
        output.result += qpi.releaseShares(asset, SELF, SELF, 1, 2, 3, 4);
      `),
      name: "QpiProcedureRecipes",
      slot: 27,
      qpiHeader: HEADER,
      arenaSz: 1 << 20,
    });
    expect(procedureResult.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  test("context violations and unknown bindings fail closed even with strict false", async () => {
    const context = await compileContract({
      source: wrap("FUNCTION", "output.result = qpi.burn(1);"),
      name: "QpiContextReject",
      slot: 27,
      qpiHeader: HEADER,
      strict: false,
    });
    expect(context.wasm).toHaveLength(0);
    expect(context.diagnostics.some((diagnostic) => /burn|function context|QpiContextProcedureCall/i.test(diagnostic.message))).toBe(true);

    const unknown = await compileContract({
      source: wrap("FUNCTION", "output.result = qpi.notAHostBinding();"),
      name: "QpiUnknownReject",
      slot: 27,
      qpiHeader: HEADER,
      strict: false,
    });
    expect(unknown.wasm).toHaveLength(0);
    expect(unknown.diagnostics.some((diagnostic) => /notAHostBinding|unknown QPI binding|unknown member/i.test(diagnostic.message))).toBe(true);

    const missing = await compileContract({
      source: wrap("FUNCTION", "output.result = qpi.isAssetIssued(SELF);"),
      name: "QpiMissingReject",
      slot: 27,
      qpiHeader: HEADER,
      strict: false,
    });
    expect(missing.wasm).toHaveLength(0);
    expect(missing.diagnostics.some((diagnostic) => /expects 2|missing required argument/i.test(diagnostic.message))).toBe(true);

    const nonAddressable = await compileContract({
      source: wrap("FUNCTION", "output.digest = qpi.nextId(7);"),
      name: "QpiAddressReject",
      slot: 27,
      qpiHeader: HEADER,
      strict: false,
    });
    expect(nonAddressable.wasm).toHaveLength(0);
    expect(nonAddressable.diagnostics.some((diagnostic) => /not (?:an )?addressable/i.test(diagnostic.message))).toBe(true);
  });
});
