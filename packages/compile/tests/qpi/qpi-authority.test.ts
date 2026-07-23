import { DiagnosticSeverity } from "../../src/enums";
import { CORE_PATH } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, inspectWasmModule, loadQpiHeader } from "../../src/index";
import { QPI_SNAPSHOT } from "../../src/generated/qpi-snapshot";

const CORE = CORE_PATH;
const coreOk = existsSync(join(CORE, "src", "contracts", "qpi.h"));

beforeAll(async () => {
  await initK12();
});

// Forces lazy compilation of every source-backed container and arithmetic family.
const CAPABILITY_SOURCE = `using namespace QPI;
struct CustomHash
{
  static uint64 hash(const uint64& key) { return key & 1ull; }
};
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase
{
  struct StateData
  {
    HashMap<uint64, uint64, 8, CustomHash> hm;
    HashSet<uint64, 8, CustomHash> hs;
    Collection<uint64, 8> coll;
    LinkedList<uint64, 8> list;
    uint128 wide;
    uint64 checksum;
  };
  struct Exercise_input { id who; uint64 key; uint64 value; };
  struct Exercise_output {};
  struct Exercise_locals { id who; uint128 wide; uint64 value; sint64 i; sint64 j; };

  PUBLIC_PROCEDURE_WITH_LOCALS(Exercise)
  {
    locals.i = state.mut().hm.set(input.key, input.value);
    state.mut().checksum += state.get().hm.capacity();
    state.mut().checksum += state.get().hm.population();
    state.mut().checksum += state.get().hm.contains(input.key);
    state.mut().checksum += state.get().hm.get(input.key, locals.value);
    state.mut().checksum += state.get().hm.getElementIndex(input.key);
    state.mut().checksum += state.get().hm.isEmptySlot(locals.i);
    locals.j = state.get().hm.nextElementIndex(-1);
    state.mut().checksum += state.get().hm.key(locals.j);
    state.mut().checksum += state.get().hm.value(locals.j);
    state.mut().checksum += state.mut().hm.replace(input.key, input.value + 1);
    state.mut().hm.removeByIndex(locals.i);
    state.mut().checksum += state.mut().hm.removeByKey(input.key);
    state.mut().checksum += state.get().hm.needsCleanup();
    state.mut().checksum += state.get().hm.needsCleanup(10);
    state.mut().hm.cleanupIfNeeded();
    state.mut().hm.cleanupIfNeeded(10);
    state.mut().hm.cleanup();
    state.mut().hm.reset();

    locals.i = state.mut().hs.add(input.key);
    state.mut().checksum += state.get().hs.capacity();
    state.mut().checksum += state.get().hs.population();
    state.mut().checksum += state.get().hs.contains(input.key);
    state.mut().checksum += state.get().hs.getElementIndex(input.key);
    state.mut().checksum += state.get().hs.isEmptySlot(locals.i);
    locals.j = state.get().hs.nextElementIndex(-1);
    state.mut().checksum += state.get().hs.key(locals.j);
    state.mut().hs.removeByIndex(locals.i);
    state.mut().checksum += state.mut().hs.remove(input.key);
    state.mut().checksum += state.get().hs.needsCleanup();
    state.mut().hs.cleanupIfNeeded();
    state.mut().hs.cleanup();
    state.mut().hs.reset();

    locals.i = state.mut().coll.add(input.who, input.value, (sint64)input.key);
    state.mut().checksum += state.get().coll.capacity();
    state.mut().checksum += state.get().coll.needsCleanup();
    state.mut().coll.cleanupIfNeeded();
    state.mut().coll.cleanup();
    state.mut().checksum += state.get().coll.element(locals.i);
    state.mut().checksum += state.get().coll.headIndex(input.who);
    state.mut().checksum += state.get().coll.headIndex(input.who, 7);
    state.mut().checksum += state.get().coll.nextElementIndex(locals.i);
    state.mut().checksum += state.get().coll.population();
    state.mut().checksum += state.get().coll.population(input.who);
    locals.who = state.get().coll.pov(locals.i);
    state.mut().checksum += state.get().coll.prevElementIndex(locals.i);
    state.mut().checksum += state.get().coll.priority(locals.i);
    state.mut().checksum += state.mut().coll.remove(locals.i);
    state.mut().coll.replace(locals.i, input.value);
    state.mut().coll.reset();
    state.mut().checksum += state.get().coll.tailIndex(input.who);
    state.mut().checksum += state.get().coll.tailIndex(input.who, 7);

    locals.i = state.mut().list.addHead(input.value);
    locals.j = state.mut().list.addTail(input.value + 1);
    state.mut().checksum += state.mut().list.insertAfter(locals.i, input.value + 2);
    state.mut().checksum += state.mut().list.insertBefore(locals.j, input.value + 3);
    state.mut().checksum += state.get().list.capacity();
    state.mut().checksum += state.get().list.population();
    state.mut().checksum += state.get().list.headIndex();
    state.mut().checksum += state.get().list.tailIndex();
    state.mut().checksum += state.get().list.nextElementIndex(locals.i);
    state.mut().checksum += state.get().list.prevElementIndex(locals.j);
    state.mut().checksum += state.get().list.element(locals.i);
    state.mut().checksum += state.get().list.isEmptySlot(locals.i);
    state.mut().checksum += state.mut().list.replace(locals.i, input.value + 4);
    state.mut().list.remove(locals.i);
    state.mut().list.reset();

    locals.wide = uint128(input.key, input.value);
    locals.wide = (locals.wide + (uint128)1) - (uint128)1;
    ++locals.wide;
    locals.wide = (locals.wide * (uint128)3) / (uint128)3;
    locals.wide = (locals.wide << (uint128)1) >> 1u;
    locals.wide = locals.wide & 255;
    state.mut().checksum += locals.wide == (uint128)0;
    state.mut().checksum += locals.wide < (uint128)1;
    state.mut().checksum += locals.wide > (uint128)1;
    state.mut().checksum += locals.wide <= (uint128)1;
    state.mut().checksum += locals.wide >= (uint128)1;
    state.mut().wide = div<uint128>(locals.wide, (uint128)input.value);
    state.mut().checksum += math_lib::max(input.key, input.value);
    state.mut().checksum += math_lib::min(input.key, input.value);
    state.mut().checksum += math_lib::abs((sint64)input.key);
    state.mut().checksum += math_lib::irootK64<2>(16ULL);
    state.mut().checksum += QPI::smul(input.key, input.value);
    state.mut().checksum += QPI::sadd(input.key, input.value);
    state.mut().checksum += QPI::div(input.key, input.value);
    state.mut().checksum += QPI::mod(input.key, input.value);
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Exercise, 1); }
};`;

describe("authoritative QPI capability matrix", () => {
  const variants: Array<[string, () => Promise<string> | string]> = [];
  if (coreOk) variants.push(["live core-lite", () => loadQpiHeader(CORE)]);
  variants.push(["pinned browser snapshot", () => QPI_SNAPSHOT]);

  for (const [label, header] of variants) {
    test(`compiles every supported family from ${label}`, async () => {
      const result = await compileContract({
        source: CAPABILITY_SOURCE,
        name: "QpiAuthority",
        slot: 27,
        arenaSz: 1 << 20,
        qpiHeader: await header(),
      });
      expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toEqual(
        [],
      );
      expect(result.wasm.byteLength).toBeGreaterThan(0);
      expect(inspectWasmModule(result.wasm).ok).toBe(true);
    }, 60_000);
  }

  test.if(coreOk)("loadQpiHeader fails closed for a non-core path", () => {
    expect(() => loadQpiHeader("/definitely/not/a/core/checkout")).toThrow(/not a core checkout/);
  });

  test.if(coreOk)("uses a dependent custom HashFunc body at runtime", async () => {
    const source = `using namespace QPI;
struct LowBitHash { static uint64 hash(const uint64& key) { return key & 1ull; } };
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { HashMap<uint64, uint64, 8, LowBitHash> values; sint64 first; sint64 second; };
  struct Fill_input {}; struct Fill_output {};
  struct Read_input {}; struct Read_output { sint64 first; sint64 second; };
  PUBLIC_PROCEDURE(Fill) {
    state.mut().first = state.mut().values.set(2, 11);
    state.mut().second = state.mut().values.set(4, 22);
  }
  PUBLIC_FUNCTION(Read) { output.first = state.get().first; output.second = state.get().second; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Fill, 1); REGISTER_USER_FUNCTION(Read, 1); }
};`;
    const result = await compileContract({
      source,
      name: "CustomHash",
      slot: 27,
      arenaSz: 1 << 20,
      qpiHeader: loadQpiHeader(CORE),
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toEqual([]);

    const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    sim.fund(user, 1_000_000n);
    sim.deploy(27, result.wasm);
    sim.procedure(27, 1, new Uint8Array(0), { invocator: user });
    const output = sim.query(27, 1);
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    expect(view.getBigInt64(0, true)).toBe(0n);
    expect(view.getBigInt64(8, true)).toBe(1n);
  });
});
