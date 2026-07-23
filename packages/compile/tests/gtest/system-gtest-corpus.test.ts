import { DiagnosticSeverity } from "../../src/enums";
import { CORE_PATH } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { systemContracts } from "@qinit/build";
import { initK12 } from "@qinit/core";
import { runCompiledGtest } from "@qinit/engine";
import { compileContract, compileGtest, loadQpiHeader } from "../../src";

const CORE = CORE_PATH;
const QPI = loadQpiHeader(CORE);

const SUPPORTED_SYSTEM_GTESTS = [
  {
    contract: "RANDOM",
    constructionEpoch: 88,
    file: "contract_random.cpp",
    test: "ContractRandom.FeesReturns100PerBitForFirstTenTiers",
  },
] as const;

interface TestBlock {
  name: string;
  start: number;
  end: number;
}

function testBlocks(source: string): TestBlock[] {
  const blocks: TestBlock[] = [];
  const re = /\bTEST\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)\s*\{/g;
  for (let match = re.exec(source); match; match = re.exec(source)) {
    const open = source.indexOf("{", match.index);
    let depth = 0;
    let quote = "";
    let end = -1;
    for (let i = open; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === "/" && source[i + 1] === "/") {
        i = source.indexOf("\n", i + 2);
        if (i < 0) break;
        continue;
      }
      if (ch === "/" && source[i + 1] === "*") {
        i = source.indexOf("*/", i + 2);
        if (i < 0) break;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end < 0) throw new Error(`unclosed ${match[1]}.${match[2]} test block`);
    blocks.push({ name: `${match[1]}.${match[2]}`, start: match.index, end });
    re.lastIndex = end;
  }
  return blocks;
}

function isolatedTestSource(source: string, name: string): string {
  const blocks = testBlocks(source);
  const selected = blocks.find((block) => block.name === name);
  if (!selected) throw new Error(`missing core-lite gtest ${name}`);
  return `${source.slice(0, blocks[0].start)}\n${source.slice(selected.start, selected.end)}`;
}

describe("core-lite system gtest corpus", () => {
  beforeAll(async () => initK12());

  for (const entry of SUPPORTED_SYSTEM_GTESTS) {
    test(`${entry.contract}: ${entry.test}`, async () => {
      const contract = systemContracts(CORE).find((item) => item.name === entry.contract);
      expect(contract).toBeDefined();
      expect(contract!.constructionEpoch).toBe(entry.constructionEpoch);
      const testSource = isolatedTestSource(
        readFileSync(join(CORE, "test", entry.file), "utf8"),
        entry.test,
      );

      const runner = await compileGtest({
        source: contract!.source,
        testSource,
        name: contract!.stateType,
        slot: contract!.index,
        constructionEpoch: contract!.constructionEpoch,
        qpiHeader: QPI,
      });
      expect(runner.diagnostics.filter((item) => item.severity === DiagnosticSeverity.ERROR)).toEqual([]);
      expect(runner.program?.tests.map((item) => item.name)).toEqual([entry.test]);

      const compiledContract = await compileContract({
        source: contract!.source,
        name: contract!.stateType,
        slot: contract!.index,
        qpiHeader: QPI,
        arenaSz: 16 * 1024 * 1024,
      });
      expect(compiledContract.diagnostics.filter((item) => item.severity === DiagnosticSeverity.ERROR)).toEqual([]);
      expect(
        await runCompiledGtest(runner.program!, runner.wasm!, {
          [contract!.index]: compiledContract.wasm,
        }),
      ).toEqual([{ name: entry.test, passed: true, message: "" }]);
    }, 120000);
  }
});
