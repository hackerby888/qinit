import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
// qpi-layout.ts is a hand-written TypeScript mirror of core's C++ container templates, and it is what the
// decoder, `qinit state` and the IDE read live contract state with. Nothing checked it against core: the
// compiler-x-runtime matrix never touches it (both sides of that comparison derive their layout from the
// real qpi.h), so its only guard was eight hand-typed literals in qpi-layout.test.ts. A mutation sweep
// found three formulas those literals cannot see, all for the same reason — every fixture uses a capacity
// where ceil(L/32) and ceil(L/64) agree, and a value size that is already a multiple of 8.
//
// This asks core's own compiler instead. Each row instantiates the real template and compares sizeof and
// alignof against what qpi-layout computes, so the check holds at every parameter rather than the handful
// someone thought to write down.
import { describe, expect, beforeAll } from "bun:test";
import { initK12 } from "@qinit/core";
import { runContractTesting, type TestResult } from "@qinit/engine";
import { coreGtest } from "../support/core-gtest";
import { buildDifferentialRunner } from "../support/differential-runner";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { arrayGeometry, bitArrayGeometry, collectionGeometry, hashMapGeometry, hashSetGeometry, linkedListGeometry } from "@qinit/proto/qpi-layout";

const CORE = CORE_PATH;
const HEADERS = () => loadQpiHeader(CORE);

interface Layout {
    size: number;
    align: number;
}
const u8: Layout = { size: 1, align: 1 };
const u16: Layout = { size: 2, align: 2 };
const u32: Layout = { size: 4, align: 4 };
const u64: Layout = { size: 8, align: 8 };
const id: Layout = { size: 32, align: 8 };

// Core's containers static_assert a power-of-two capacity, so 64 — not 33 — is the smallest capacity
// where one flag word per 64 slots differs from one per 32.
const CAPS = [1, 2, 4, 8, 16, 32, 64, 128];
// A value whose size is not a multiple of 8 is what makes the element/node padding observable.
const VALUES: [string, Layout][] = [
    ["uint8", u8],
    ["uint16", u16],
    ["uint32", u32],
    ["uint64", u64],
    ["id", id],
];

interface Row {
    cpp: string;
    size: number;
    align: number;
}
const rows: Row[] = [];

for (const capacity of CAPS) {
    for (const [name, value] of VALUES) {
        rows.push({ cpp: `HashMap<${name}, ${name}, ${capacity}>`, ...hashMapGeometry(value, value, capacity) });
        rows.push({ cpp: `HashSet<${name}, ${capacity}>`, ...hashSetGeometry(value, capacity) });
        rows.push({ cpp: `Collection<${name}, ${capacity}>`, ...collectionGeometry(value, capacity) });
        rows.push({ cpp: `LinkedList<${name}, ${capacity}>`, ...linkedListGeometry(value, capacity) });
        rows.push({ cpp: `Array<${name}, ${capacity}>`, ...arrayGeometry(value, capacity) });
    }
}
// Mixed key/value widths, where the value's alignment decides where it sits inside a record.
for (const capacity of [2, 16]) {
    rows.push({ cpp: `HashMap<uint8, uint64, ${capacity}>`, ...hashMapGeometry(u8, u64, capacity) });
    rows.push({ cpp: `HashMap<uint64, uint8, ${capacity}>`, ...hashMapGeometry(u64, u8, capacity) });
    rows.push({ cpp: `HashMap<id, uint32, ${capacity}>`, ...hashMapGeometry(id, u32, capacity) });
    rows.push({ cpp: `HashMap<uint16, id, ${capacity}>`, ...hashMapGeometry(u16, id, capacity) });
}
for (const bits of [2, 4, 8, 64, 128, 256, 4096]) {
    rows.push({ cpp: `BitArray<${bits}>`, ...bitArrayGeometry(bits) });
}

const SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 unused; };
  struct Nop_input {}; struct Nop_output { uint64 value; };
  PUBLIC_FUNCTION(Nop) { output.value = 1; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Nop, 1); }
};`;

// sizeof and alignof cannot see an internal member offset that the element stride's final round-up
// absorbs — the container is the same total size either way. Those offsets are private, so offsetof will
// not compile from outside. Instead: place a known value through the public API and check it lands where
// qpi-layout says it does.
const ll32 = linkedListGeometry(u32, 8);
const coll32 = collectionGeometry(u32, 8);

const OFFSET_GTEST = `TEST(Geometry, InternalOffsetsLandWhereQpiLayoutSaysTheyDo) {
  // LinkedList<uint32,8>: a uint32 value leaves the node's next index padded up to 8, so a wrong
  // nextOffset reads the wrong slot even though sizeof is unchanged.
  QPI::LinkedList<QPI::uint32, 8> list;
  list.reset();
  QPI::sint64 first = list.addTail(11u);
  QPI::sint64 second = list.addTail(22u);
  EXPECT_EQ(first, 0ll);
  EXPECT_EQ(second, 1ll);

  const unsigned char* raw = (const unsigned char*)&list;
  QPI::sint64 nextOfFirst = *(const QPI::sint64*)(raw + 0 * ${ll32.nodeStride} + ${ll32.nextOffset});
  EXPECT_EQ(nextOfFirst, second) << "LinkedList<uint32,8> nextOffset ${ll32.nextOffset}";
  QPI::uint32 valueOfSecond = *(const QPI::uint32*)(raw + 1 * ${ll32.nodeStride});
  EXPECT_EQ(valueOfSecond, 22u) << "LinkedList<uint32,8> nodeStride ${ll32.nodeStride}";

  // Collection<uint32,8>: same shape, for the element's priority field.
  QPI::Collection<QPI::uint32, 8> coll;
  coll.reset();
  QPI::id pov = QPI::id(7, 0, 0, 0);
  QPI::sint64 e = coll.add(pov, 33u, 4242ll);
  EXPECT_EQ(e, 0ll);

  const unsigned char* craw = (const unsigned char*)&coll;
  QPI::sint64 priority = *(const QPI::sint64*)(craw + ${coll32.elementsOffset} + 0 * ${coll32.elementStride} + ${coll32.elementPriorityOffset});
  EXPECT_EQ(priority, 4242ll) << "Collection<uint32,8> elementPriorityOffset ${coll32.elementPriorityOffset}";
  QPI::uint32 stored = *(const QPI::uint32*)(craw + ${coll32.elementsOffset} + 0 * ${coll32.elementStride});
  EXPECT_EQ(stored, 33u) << "Collection<uint32,8> elementsOffset ${coll32.elementsOffset}";
}`;

// One TEST per family, so a failure names which container disagreed rather than just "geometry".
const familyOf = (cpp: string) => cpp.slice(0, cpp.indexOf("<"));
const FAMILIES = ["HashMap", "HashSet", "Collection", "LinkedList", "Array", "BitArray"];

const GTEST = coreGtest(
    "Geometry",
    FAMILIES.map(
        (family) => `TEST(Geometry, ${family}MatchesQpiLayout) {
${rows
    .filter((row) => familyOf(row.cpp) === family)
    .map(
        (row) => `  EXPECT_EQ(sizeof(QPI::${row.cpp}), ${row.size}ull) << "sizeof ${row.cpp}";
  EXPECT_EQ(alignof(QPI::${row.cpp}), ${row.align}ull) << "alignof ${row.cpp}";`,
    )
    .join("\n")}
}`,
    ).join("\n\n") +
        "\n\n" +
        OFFSET_GTEST,
);

const wasi = wasiToolchain();

describe.skipIf(!HAS_CORE)("differential gtest — container geometry against core's own templates", () => {
    beforeAll(async () => {
        await initK12();
    });

    toolchainTest(
        `core agrees with qpi-layout on all ${rows.length} container shapes`,
        wasi,
        async () => {
            const runnerWasm = await buildDifferentialRunner({
                corePath: CORE,
                source: SRC,
                testSource: GTEST,
                name: "Geometry",
                tempPrefix: "geometry-oracle-",
            });

            const mine = await compileContractWithTypeScript({
                source: SRC,
                contractName: "Geometry",
                slot: 28,
                qpiHeader: HEADERS(),
                arenaSizeBytes: 64 * 1024,
            });
            expect(mine.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

            const results: TestResult[] = await runContractTesting(runnerWasm, { 28: mine.wasm });
            for (const r of results) {
                console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message}`);
            }
            expect(results.length).toBe(FAMILIES.length + 1);
            expect(results.every((r) => r.passed)).toBe(true);
        },
        300000,
    );
});
