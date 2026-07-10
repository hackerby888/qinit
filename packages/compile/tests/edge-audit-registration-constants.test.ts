// REGISTER_USER_* accepts integral constant expressions in native C++. Registration extraction must
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "../src/index";

const HEADERS = loadQpiHeader("/home/kali/Projects/core-lite");

const wrap = (members: string, inputType: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  ${members}
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, ${inputType}); }
};`;

async function compile(source: string) {
  return compileContract({ source, name: "RegistrationConstantEdge", slot: 27, qpiHeader: HEADERS, arenaSz: 1 << 20 });
}

async function registeredInputType(source: string): Promise<number | undefined> {
  const result = await compile(source);
  expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  expect(WebAssembly.validate(result.wasm)).toBe(true);
  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  sim.deploy(27, result.wasm);
  return sim.contracts.get(27)!.entries.find((entry) => entry.kind === 1)?.it;
}

async function expectRangeRejection(source: string) {
  const result = await compile(source);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  expect(errors.some((d) => /input.?type.*range|1.*65535|registration.*constant/i.test(d.message))).toBe(true);
  expect(result.wasm).toHaveLength(0);
}

describe("edge audit — registration constant expressions", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("a folded arithmetic input type is registered", async () => {
    expect(await registeredInputType(wrap("", `1 + 1`))).toBe(2);
  });

  test("an enum constant input type is registered", async () => {
    expect(await registeredInputType(wrap(`enum InputType { GO_TYPE = 7 };`, `GO_TYPE`))).toBe(7);
  });

  test("a negative folded input type is rejected instead of dropping the entry", async () => {
    await expectRangeRejection(wrap("", `-1`));
  });

  test("a folded input type above 65535 is rejected instead of dropping the entry", async () => {
    await expectRangeRejection(wrap("", `32768 * 2`));
  });

  test("an unsigned literal suffix remains accepted", async () => {
    expect(await registeredInputType(wrap("", `7u`))).toBe(7);
  });
});
