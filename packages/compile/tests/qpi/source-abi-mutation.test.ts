import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CORE_PATH } from "../../../../test-utils/paths";
import { parseLiteAbiSource } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "../../src";
import { inspectLiteWasmModule } from "../../src/compiler/wasm-inspect";
import { IMPL_BOUNDARY, LITE_ABI_MARKER } from "../../src/qpi-snapshot";

const HEADER = loadQpiHeader(CORE_PATH);
const metadata = readFileSync(`${CORE_PATH}/src/extensions/wasm/lite_abi_metadata.h`, "utf8");
const shared = readFileSync(`${CORE_PATH}/src/extensions/wasm/lite_dyn_abi.h`, "utf8");

function addFunctionContextDeclaration(header: string, declaration: string): string {
  const marker = /struct QpiContextFunctionCall : public QpiContext\r?\n\s*\{/;
  if (!marker.test(header)) throw new Error("QpiContextFunctionCall declaration marker not found");
  return header.replace(marker, (match) => `${match}\n\t\t${declaration}`);
}

function mutateEmbeddedAbi(
  header: string,
  mutate: (abi: ReturnType<typeof parseLiteAbiSource>) => void,
): string {
  const pattern = new RegExp(`^${LITE_ABI_MARKER}(.+)$`, "m");
  const match = pattern.exec(header);
  if (!match) throw new Error("embedded ABI marker not found");
  const abi = JSON.parse(match[1]) as ReturnType<typeof parseLiteAbiSource>;
  mutate(abi);
  return header.replace(pattern, `${LITE_ABI_MARKER}${JSON.stringify(abi)}`);
}

function replaceRequired(source: string, pattern: RegExp, replacement: string): string {
  const changed = source.replace(pattern, replacement);
  if (changed === source) throw new Error(`ABI mutation pattern did not match: ${pattern}`);
  return changed;
}

const contract = (body: string, output = "uint64 value;") => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct Run_input {};
  struct Run_output { ${output} };
  PUBLIC_FUNCTION(Run) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Run, 1); }
};`;

describe("source-backed ABI mutations", () => {
  test("a new scalar QPI wrapper compiles without a compiler method entry", async () => {
    const declared =
      addFunctionContextDeclaration(HEADER, "inline uint32 newScalar() const;") +
      `\n${IMPL_BOUNDARY}\nextern "C" { unsigned int __lhost_newScalar(); }\nuint32 QPI::QpiContextFunctionCall::newScalar() const { return __lhost_newScalar(); }\n`;
    const header = mutateEmbeddedAbi(declared, (abi) => {
      abi.lhost.unshift({ name: "newScalar", params: [], results: ["i32"] });
    });
    const result = await compileContract({
      source: contract("output.value = qpi.newScalar();"),
      name: "ScalarWrapperMutation",
      slot: 27,
      qpiHeader: header,
      arenaSz: 1 << 20,
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const moduleBytes = new Uint8Array(result.wasm).buffer as ArrayBuffer;
    expect(WebAssembly.Module.imports(new WebAssembly.Module(moduleBytes))[0]).toMatchObject({
      module: "lhost",
      name: "newScalar",
    });
  });

  test("a new aggregate-returning QPI wrapper uses the normal parsed layout path", async () => {
    const header =
      addFunctionContextDeclaration(HEADER, "inline id nextAlias(const id& value) const;") +
      `\n${IMPL_BOUNDARY}\nQPI::id QPI::QpiContextFunctionCall::nextAlias(const QPI::id& value) const { QPI::id out; __lhost_nextId(&value, &out); return out; }\n`;
    const result = await compileContract({
      source: contract("output.value = qpi.nextAlias(SELF);", "id value;"),
      name: "AggregateWrapperMutation",
      slot: 27,
      qpiHeader: header,
      arenaSz: 1 << 20,
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  test("LHOST row order and additions are read from the canonical table", () => {
    const inserted = metadata.replace(
      'GI("beginFn",',
      `GI("newScalar", newScalar, "()i") \\
    GI("beginFn",`,
    );
    const parsed = parseLiteAbiSource(inserted, shared);
    expect(parsed.lhost[0]).toEqual({ name: "newScalar", params: [], results: ["i32"] });
    expect(parsed.lhost[1].name).toBe("beginFn");
  });

  test("record field reorder changes generated offsets and capacity comes from core", async () => {
    const reordered = shared
      .replace(
        "unsigned char owner[32];\n    unsigned char possessor[32];",
        "unsigned char possessor[32];\n    unsigned char owner[32];",
      )
      .replace(
        "#define LITE_ASSET_ENTRY_CAPACITY 1024u",
        "#define LITE_ASSET_ENTRY_CAPACITY 2048u",
      );
    const record = parseLiteAbiSource(metadata, reordered).records.LiteAssetEntry;
    expect(record.fields.possessor.offset).toBe(0);
    expect(record.fields.owner.offset).toBe(32);
    expect(record.capacity).toBe(2048);

    const iteratorContract = contract(`
      Asset asset = { SELF, 0x414243ull };
      AssetOwnershipIterator iterator;
      iterator.begin(asset);
      output.value = iterator.numberOfOwnedShares();
    `);
    const baseline = await compileContract({
      source: iteratorContract,
      name: "AssetRecordBaseline",
      slot: 27,
      qpiHeader: HEADER,
      arenaSz: 1 << 20,
    });
    const changedHeader = mutateEmbeddedAbi(HEADER, (abi) => {
      abi.records.LiteAssetEntry = record;
    });
    const changed = await compileContract({
      source: iteratorContract,
      name: "AssetRecordMutation",
      slot: 27,
      qpiHeader: changedHeader,
      arenaSz: 1 << 20,
    });
    expect(changed.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(inspectLiteWasmModule(changed.wasm).memories[0].minimumPages).toBeGreaterThan(
      inspectLiteWasmModule(baseline.wasm).memories[0].minimumPages,
    );
  });

  test("system-procedure IDs and method names follow the canonical table", async () => {
    const initializeReplaced = replaceRequired(
      metadata,
      /X\(INITIALIZE,\s*0,\s*initialize,\s*__initializeEmpty\)/,
      "X(BEGIN_EPOCH, 0, beginEpoch, __beginEpochEmpty)",
    );
    const changed = replaceRequired(
      initializeReplaced,
      /X\(BEGIN_EPOCH,\s*1,\s*beginEpoch,\s*__beginEpochEmpty\)/,
      "X(INITIALIZE, 1, initialize, __initializeEmpty)",
    );
    expect(parseLiteAbiSource(changed, shared).systemProcedures.slice(0, 2)).toEqual([
      { name: "BEGIN_EPOCH", id: 0, method: "beginEpoch" },
      { name: "INITIALIZE", id: 1, method: "initialize" },
    ]);

    const header = mutateEmbeddedAbi(HEADER, (abi) => {
      const initialize = abi.systemProcedures[0];
      const beginEpoch = abi.systemProcedures[1];
      abi.systemProcedures.splice(0, 2, { ...beginEpoch, id: 0 }, { ...initialize, id: 1 });
    });
    const source = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  INITIALIZE() {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {}
};`;
    const result = await compileContract({
      source,
      name: "SystemProcedureMutation",
      slot: 27,
      qpiHeader: header,
      arenaSz: 1 << 20,
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
    expect(sim.deploy(27, result.wasm).ex.reg_sysproc_mask()).toBe(1 << 1);
  });

  test("unsupported or ambiguous core metadata fails generation", () => {
    expect(() =>
      parseLiteAbiSource(metadata.replace('GI("endFn"', 'GI("beginFn"'), shared),
    ).toThrow(/duplicate LHOST import/);
    expect(() =>
      parseLiteAbiSource(
        metadata,
        replaceRequired(
          shared,
          /struct LiteAssetEntry\s*\{/,
          "struct LiteAssetEntry {\n    float unsupported;",
        ),
      ),
    ).toThrow(/unsupported LiteAssetEntry field/);
    expect(() =>
      parseLiteAbiSource(
        replaceRequired(
          metadata,
          /X\(BEGIN_EPOCH,\s*1,\s*beginEpoch,\s*__beginEpochEmpty\)/,
          "X(BEGIN_EPOCH, 7, beginEpoch, __beginEpochEmpty)",
        ),
        shared,
      ),
    ).toThrow(/ambiguous system-procedure order/);
  });
});
