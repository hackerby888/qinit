// QPI header caching must be content-addressed. Length + first 64 bytes is not sufficient:
// browser/editor clients can compile against different same-sized header snapshots in one process.
import { beforeAll, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract } from "../src/index";

const PREFIX = "/* edge-audit unique cache-key prefix */".padEnd(63, " ") + "\n";
const HEADER_8 = `${PREFIX}struct HeaderType { uint64 value; };`;
const HEADER_4 = `${PREFIX}struct HeaderType { uint32 value; };`;

const SOURCE = `struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { HeaderType value; };
};`;

async function stateSize(name: string, qpiHeader: string): Promise<number> {
  const result = await compileContract({
    source: SOURCE,
    name,
    slot: 27,
    qpiHeader,
    arenaSz: 1 << 20,
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  sim.deploy(27, result.wasm);
  return sim.contracts.get(27)!.state().byteLength;
}

beforeAll(async () => {
  await initK12();
});

test("same-length headers with the same prefix retain independent parsed layouts", async () => {
  expect(HEADER_8).toHaveLength(HEADER_4.length);
  expect(HEADER_8.slice(0, 64)).toBe(HEADER_4.slice(0, 64));

  expect(await stateSize("HeaderEight", HEADER_8)).toBe(8);
  expect(await stateSize("HeaderFour", HEADER_4)).toBe(4);
});
