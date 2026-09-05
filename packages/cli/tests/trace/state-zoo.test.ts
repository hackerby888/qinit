// The shapes production contracts keep in state — struct and nested-struct keys, arrays and BitArrays
// as map values, bit and sub-word values, signed keys, a Collection ordered by signed priority, a
// LinkedList, containers reached through structs — filled, updated, removed, cleaned up and drained by
// real QPI code, then read back. The contract's own functions are the oracle for what an entry holds
// and in what order a container iterates; `qinit state`, a print block and --json must agree with each
// other on the same bytes; and every diff must name what moved by the key the contract wrote.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { QubicSimulator } from "@qinit/engine";
import { initK12 } from "@qinit/engine/support/k12";
import { decodeOutput } from "@qinit/proto";
import { bytesToIdentity } from "@qinit/core";
import { CORE_PATH, HAS_CORE, HAS_WASI } from "../../../../test-utils/paths";
import { loadWasmFixture, loadWasmFixtureIdl, wasmFixtureManifest } from "../../../../test-utils/wasm-fixtures";
import { stateJsonResult } from "../../src/commands/deploy-interact/state";
import { describeTrace, type DecodedCheat } from "../../src/trace/format";
import type { StateDiffLine } from "../../src/trace/state-diff";
import { flatLine, type StateLine, jstr } from "../../src/trace/state-format";
import { decodeValueBlocks, readState, type DecodedState, type StateContainer } from "../../src/trace/state-read";

const SLOT = 28;
const SEED = 11n;
const PROC = { Fill: 1, Update: 2, Churn: 3, Cleanup: 4, Drain: 5 };
// Every keyed container, in the order `Walk` reports their populations; then the two ordered ones.
const KEYED = ["byKey", "deeper.map", "only.a", "only.b", "arrayValues", "bitValues", "bitFlags", "smallKV", "signedKey", "smallSet", "idSet", "keySet"];
const ORDERED = ["orders", "list"];

type Lookup = [bigint, bigint, bigint, bigint, number[], number[], number, number, [string, bigint, number]];
type Walk = [bigint[], bigint[], bigint[], bigint[], bigint, bigint];

const u64 = (...values: bigint[]) => new Uint8Array(new BigUint64Array(values).buffer);
const toHex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const idBytes = (...words: bigint[]) => u64(...words, ...new Array(4 - words.length).fill(0n));
const keyText = (i: bigint) => `{sub: {a: ${SEED}, b: ${i}}, asset: ${i}}`;

class Zoo {
    private constructor(
        readonly sim: QubicSimulator,
        readonly idl: Awaited<ReturnType<typeof loadWasmFixtureIdl>>,
    ) {}

    static async deploy(wasm?: Uint8Array): Promise<Zoo> {
        await initK12();
        const sim = new QubicSimulator();
        sim.setDebug(true);
        sim.deploy(SLOT, wasm ?? (await loadWasmFixture("StateZoo")));

        return new Zoo(sim, await loadWasmFixtureIdl("StateZoo"));
    }

    fill(n: bigint) {
        this.sim.procedure(SLOT, PROC.Fill, u64(SEED, n));
    }
    update(n: bigint) {
        this.sim.procedure(SLOT, PROC.Update, u64(SEED, n));
    }
    churn(key: bigint, orderIndex: bigint) {
        this.sim.procedure(SLOT, PROC.Churn, u64(SEED, key, orderIndex));
    }
    cleanup() {
        this.sim.procedure(SLOT, PROC.Cleanup);
    }
    drain(n: bigint) {
        this.sim.procedure(SLOT, PROC.Drain, u64(SEED, n));
    }

    private async query<T>(name: string, input: Uint8Array): Promise<T> {
        const meta = this.idl.functions.find((candidate) => candidate.name === name)!;
        return (await decodeOutput(this.sim.query(SLOT, meta.inputType, input), meta.output)) as T;
    }
    lookup(i: bigint) {
        return this.query<Lookup>("Lookup", u64(SEED, i));
    }
    walk() {
        return this.query<Walk>("Walk", new Uint8Array(32));
    }

    // The prints of one `Dump` call, as the trace view shows them.
    async dump(): Promise<DecodedCheat[]> {
        const meta = this.idl.functions.find((candidate) => candidate.name === "Dump")!;
        this.sim.query(SLOT, meta.inputType);
        return (await this.trace()).cheats;
    }
    async diff(): Promise<StateDiffLine[]> {
        return (await this.trace()).stateDiff;
    }
    private trace() {
        return describeTrace(this.sim.getTrace().entries.at(-1)!, undefined, "StateZoo", undefined, this.idl);
    }

    stateBytes(): Uint8Array {
        return this.sim.contracts.get(SLOT)!.stateView().slice(0, this.idl.state!.size);
    }
    // Everything, the way `qinit state --all` reads it over RPC.
    state(): Promise<DecodedState> {
        const bytes = this.stateBytes();
        const rpc = { stateRead: async (_slot: number, off: number, len: number) => ({ hex: toHex(bytes.subarray(off, off + len)) }) };
        return readState(rpc, SLOT, wasmFixtureManifest.StateZoo.source, "StateZoo", undefined, undefined, { loadAllContainers: true });
    }
}

type Blocks = {
    fields: { name: string; value: string }[];
    containers: { name: string; capacity: number; occupiedSlots: number; totalEntries: number; lines: StateLine[] }[];
};

// One string per row, the header of each block included, so two surfaces can be compared whole.
const rows = (state: Blocks) => [
    ...state.fields.map((field) => `${field.name} = ${field.value}`),
    ...state.containers.flatMap((container) => [
        `${container.name} · ${container.occupiedSlots}/${container.capacity} slots · ${container.totalEntries} entries`,
        ...container.lines.map((line) => `  ${flatLine(line)}`),
    ]),
];
const container = (state: DecodedState, name: string): StateContainer => state.containers.find((candidate) => candidate.name === name)!;
const entryTexts = (state: DecodedState, name: string) =>
    container(state, name)
        .lines.filter((line) => line.filled)
        .map((line) => line.text);
const entryLabels = (state: DecodedState, name: string) =>
    container(state, name)
        .lines.filter((line) => line.filled)
        .map((line) => line.label);
const visible = (diff: StateDiffLine[]) => diff.filter((line) => !line.internal).map(flatLine);
const rootOf = (label: string) => label.replace(/[[.].*$/, "");

// A row whose two images render the same says nothing moved, so it must not exist.
function expectNoIdenticalImages(diff: StateDiffLine[]) {
    const idle = diff.filter((line) => {
        const match = line.text.match(/^(.*) → (.*)$/);
        return match && match[1] === match[2];
    });
    expect(idle.map(flatLine)).toEqual([]);
}

test("qinit state, a print block and --json draw the same rows from the same bytes", async () => {
    const zoo = await Zoo.deploy();
    zoo.fill(3n);

    const state = await zoo.state();
    const blocks = await decodeValueBlocks(zoo.stateBytes(), zoo.idl.state!);
    const json = stateJsonResult("StateZoo", SLOT, state, "");

    expect(state.complete).toBe(true);
    expect(rows(blocks)).toEqual(rows(state));
    expect(json.ok).toBe(true);
    // --json carries each field as data: the same names, the value as a JSON tree rather than its text.
    expect(json.fields.map((field) => field.name)).toEqual(state.fields.map((field) => field.name));
    expect(jstr(json.fields.find((field) => field.name === "packed")!.value)).toMatch(
        /^\{"tag":7,"wide":"11","half":513,"who":"[A-Z]{60}","flag":1,"tiny":-5\}$/,
    );
    expect(json.fields.find((field) => field.name === "umax")!.value).toBe(18446744073709551615n);
    expect(rows({ ...json, fields: state.fields })).toEqual(rows(state));
    // A whole value that is an id reads bare; one inside a struct keeps its quotes.
    expect(state.fields.find((field) => field.name === "nullish")!.value).toMatch(/^[A-Z]{60}$/);
    expect(state.fields.find((field) => field.name === "packed")!.value).toMatch(/^\{tag: 7, wide: 11, half: 513, who: "[A-Z]{60}", flag: 1, tiny: -5\}$/);
    // A struct holding a container is rows and blocks named for the path, never one line of JSON, and the
    // blocks take their numbers in declaration order like any state container.
    expect(state.fields.map((field) => field.name)).toEqual(["packed", "deeper.deep.inner", "s8", "s16", "s32", "s64", "umax", "nullish"]);
    expect(state.containers.slice(0, 4).map((block) => [block.name, block.index])).toEqual([
        ["deeper.deep.quad", 1],
        ["deeper.map", 2],
        ["only.a", 3],
        ["only.b", 4],
    ]);
});

test("a print of the whole state is the block qinit state draws, container by container", async () => {
    const zoo = await Zoo.deploy();
    zoo.fill(3n);

    const state = await zoo.state();
    const prints = await zoo.dump();

    expect(prints[0].text).toBe("state.get()");
    expect(rows(prints[0].blocks!)).toEqual(rows(state));

    for (const [index, name] of [
        [1, "byKey"],
        [2, "arrayValues"],
        [3, "bitValues"],
        [4, "orders"],
        [5, "list"],
    ] as const) {
        expect(prints[index].text).toBe(`state.get().${name}`);
        expect(prints[index].blocks!.containers.map((block) => block.lines.map(flatLine))).toEqual([container(state, name).lines.map(flatLine)]);
    }

    expect(prints[6].blocks!.fields.map((field) => field.name)).toEqual(["deep.inner"]);
    expect(prints[6].blocks!.containers.map((block) => block.name)).toEqual(["deep.quad", "map"]);
});

test("every keyed entry reads as the value the contract finds for its key", async () => {
    const zoo = await Zoo.deploy();
    zoo.fill(3n);

    const state = await zoo.state();
    const who = await bytesToIdentity(new Uint8Array(32));
    const expected: Record<string, string[]> = Object.fromEntries(KEYED.map((name) => [name, []]));

    for (const i of [0n, 1n, 2n]) {
        const [found, byKey, deeperMap, onlyA, arrayValue, bitValue, bitFlag, smallKV, [entity, amount, flags]] = await zoo.lookup(i);
        const collider = await bytesToIdentity(idBytes(3n, i));

        expect(found).toBe(4095n);
        expect(entity).toBe(who);
        expected.byKey.push(`${keyText(i)} = ${byKey}`);
        expected["deeper.map"].push(`${i} = ${deeperMap}`);
        expected["only.a"].push(`${i} = ${onlyA}`);
        expected["only.b"].push(`${i}`);
        expected.arrayValues.push(`${collider} = [${arrayValue.join(", ")}]`);
        expected.bitFlags.push(`${i} = ${bitFlag}`);
        expected.smallKV.push(`${i} = ${smallKV}`);
        expected.signedKey.push(`${-i - 1n} = {entity: "${entity}", amount: ${amount}, flags: ${flags}}`);
        expected.smallSet.push(`${i * 3n}`);
        expected.idSet.push(collider);
        expected.keySet.push(keyText(i));

        // A BitArray value lists exactly the bits the contract set.
        const set = bitValue.flatMap((bit, index) => (bit ? [`[${index}]=1`] : []));
        const row = entryTexts(state, "bitValues").find((text) => text.startsWith(`${i} = `))!;
        expect([...row.matchAll(/\[\d+\]=1/g)].map((match) => match[0])).toEqual(set);
    }

    for (const name of KEYED.filter((name) => name !== "bitValues")) {
        expect(entryTexts(state, name).sort()).toEqual(expected[name].sort());
    }
    expect((await zoo.lookup(3n))[0]).toBe(0n);
    // The colliders all hash to slot 3 of a four-slot set: the first takes it, the next two probe past
    // the end and land in slots 0 and 1.
    expect(entryLabels(state, "idSet")).toEqual(["slot[0]", "slot[1]", "slot[3]"]);
});

test("a Collection reads in the order the contract iterates it, and a list from its head", async () => {
    const zoo = await Zoo.deploy();
    zoo.fill(3n);

    const state = await zoo.state();
    const [priorities, amounts, listValues, populations, orderCount, listCount] = await zoo.walk();
    const orders = entryTexts(state, "orders");

    expect(orderCount).toBe(3n);
    expect(orders.map((text) => text.match(/\(p(-?\d+)\)$/)![1])).toEqual(priorities.slice(0, 3).map(String));
    expect(orders.map((text) => text.match(/amount: (-?\d+)/)![1])).toEqual(amounts.slice(0, 3).map(String));
    // Highest priority first, as `headIndex` walks it.
    expect(priorities.slice(0, 3)).toEqual([0n, -100n, -200n]);

    expect(listCount).toBe(3n);
    expect(entryTexts(state, "list")).toEqual(listValues.slice(0, 3).map((value) => `= ${value}`));
    expect(entryLabels(state, "list")).toEqual(["item[0] slot[2]", "item[1] slot[1]", "item[2] slot[0]"]);

    expect([...KEYED, ...ORDERED].map((name) => BigInt(container(state, name).totalEntries))).toEqual(populations.slice(0, 14));
});

test("a container at capacity has no unoccupied row, and one more set changes nothing in it", async () => {
    const zoo = await Zoo.deploy();
    zoo.fill(8n);

    const state = await zoo.state();

    for (const name of [...KEYED, "list"]) {
        expect(
            container(state, name).lines.every((line) => line.filled),
            name,
        ).toBe(true);
        expect(container(state, name).totalEntries).toBe(container(state, name).capacity);
    }
    expect(container(state, "orders").totalEntries).toBe(8);
    expect(entryTexts(state, "orders")).toHaveLength(8);

    zoo.fill(9n);
    const touched = new Set((await zoo.diff()).map((line) => rootOf(line.label)));

    expect([...touched].sort()).toEqual(["bits", "grid"]);
});

test("the Fill diff names every field the contract wrote, each keyed entry by its key", async () => {
    const zoo = await Zoo.deploy();
    zoo.fill(3n);

    const diff = await zoo.diff();
    const lines = visible(diff);
    const roots = new Set(diff.filter((line) => !line.internal).map((line) => rootOf(line.label)));

    expect([...roots].sort()).toEqual(
        [
            "arrayValues",
            "bitFlags",
            "bitGrid",
            "bitValues",
            "bits",
            "byKey",
            "deeper",
            "grid",
            "idSet",
            "keySet",
            "list",
            "only",
            "orders",
            "packed",
            "packedArray",
            "s16",
            "s32",
            "s64",
            "s8",
            "signedKey",
            "smallKV",
            "smallSet",
            "umax",
        ].sort(),
    );
    expect(diff.filter((line) => line.label.startsWith("@"))).toEqual([]);
    expectNoIdenticalImages(diff);

    // Every keyed entry is one line under its key, arrived.
    const keyed = diff.filter((line) => !line.internal && KEYED.some((name) => line.label.startsWith(`${name}[`)));
    expect(keyed.length).toBeGreaterThan(30);
    expect(keyed.every((line) => line.text.endsWith("(new)"))).toBe(true);

    // A container three structs down resolves to entries rather than a line of JSON.
    expect(lines).toContain("deeper.map[1] = 10 (new)");
    expect(lines).toContain(
        'deeper.deep.inner 0 → {tag: 7, wide: 11, half: 513, who: "' + (await bytesToIdentity(new Uint8Array(32))) + '", flag: 1, tiny: -5}',
    );
    expect(lines.some((line) => line.includes('"slot"'))).toBe(false);
    // An entry whose key and value are both zero still shows up.
    for (const name of ["deeper.map", "only.b", "bitFlags", "smallKV", "smallSet"]) {
        expect(lines).toContain(`${name}[0] (new)`);
    }
    // A BitArray value reads by its key, one row per bit, like an Array value does.
    expect(lines).toContain("bitValues[1][0] = 1 (new)");
    expect(lines).toContain("bitValues[1][1] = 1 (new)");
    expect(lines).toContain(`arrayValues[${await bytesToIdentity(idBytes(3n, 1n))}][0] = 1 (new)`);
    // Struct, nested-struct and negative keys.
    expect(lines).toContain(`byKey[${keyText(1n)}] = 12 (new)`);
    expect(lines).toContain(`keySet[${keyText(2n)}] (new)`);
    expect(lines).toContainEqual(expect.stringMatching(/^signedKey\[-3\] = \{entity: "[A-Z]{60}", amount: -2, flags: 1\} \(new\)$/));
    // Sub-word, signed and packed scalars; nested arrays; a bit two arrays down.
    expect(lines).toEqual(
        expect.arrayContaining([
            "s8 0 → -1",
            "s16 0 → -2",
            "s32 0 → -3",
            "s64 0 → -4",
            "umax 0 → 18446744073709551615",
            "smallKV[2] = -2 (new)",
            "grid[1][2] 0 → 2",
            "bitGrid[1][63] 0 → 1",
            "bits[737] 0 → 1",
        ]),
    );
    expect(lines).toEqual(expect.arrayContaining(KEYED.map((name) => `${name} 0 → 3 entries`)));
});

test("an update changes value rows only: no key, no flag, no count", async () => {
    const zoo = await Zoo.deploy();
    zoo.fill(3n);
    zoo.update(3n);

    const diff = await zoo.diff();
    const lines = visible(diff);

    expect(diff.filter((line) => line.internal)).toEqual([]);
    expect(diff.every((line) => /^[\w.]+\[.+\]/.test(line.label) && / → /.test(line.text) && !line.text.includes("(new)"))).toBe(true);
    expectNoIdenticalImages(diff);
    expect(lines).toEqual(
        expect.arrayContaining([
            `byKey[${keyText(0n)}] 11 → 11000`,
            "deeper.map[2] 20 → 22",
            "only.a[0] 11 → 5",
            "bitFlags[1] 1 → 0",
            "bitFlags[0] 0 → 1",
            "smallKV[1] -1 → 2",
            `arrayValues[${await bytesToIdentity(idBytes(3n, 1n))}][1] 0 → 2`,
        ]),
    );
    expect(lines).toContainEqual(
        expect.stringMatching(/^signedKey\[-1\] \{entity: "[A-Z]{60}", amount: 0, flags: 1\} → \{entity: "[A-Z]{60}", amount: 11, flags: 2\}$/),
    );
});

test("a removal reads as (removed) under its key, and a Collection's moved element is reported once", async () => {
    const zoo = await Zoo.deploy();
    zoo.fill(3n);
    zoo.churn(1n, 1n);

    const diff = await zoo.diff();
    const lines = visible(diff);
    const collider = await bytesToIdentity(idBytes(3n, 0n));

    expectNoIdenticalImages(diff);
    expect(lines).toEqual(
        expect.arrayContaining([
            `byKey[${keyText(1n)}] 12 → (removed)`,
            "deeper.map[1] 10 → (removed)",
            "only.a[1] 10 → (removed)",
            "only.b[1] (removed)",
            "smallSet[3] (removed)",
            "smallKV[1] -1 → (removed)",
            "bitFlags[1] 1 → (removed)",
            "bitValues[1][0] 1 → (removed)",
            `idSet[${collider}] (removed)`,
            `arrayValues[${collider}][3] 99 → (removed)`,
            `keySet[${keyText(1n)}] (removed)`,
            "byKey 3 → 2 entries",
            "orders 3 → 2 entries",
            "orders[1].priority -100 → -200",
            "list[2] 2 → 0",
            "list 3 → 2 entries",
        ]),
    );
    expect(lines).toContainEqual(expect.stringMatching(/^signedKey\[-2\] \{entity: "[A-Z]{60}", amount: -1, flags: 1\} → \(removed\)$/));
    // The last element moved into the hole: one row for it, none for the bytes a window cut through.
    expect(diff.filter((line) => line.label === "orders[1]")).toHaveLength(1);
    expect(diff.filter((line) => line.label.startsWith("orders[1]+"))).toEqual([]);
    expect(lines).toContainEqual(
        expect.stringMatching(/^orders\[1\] \{entity: "[A-Z]{60}", amount: -1, flags: 1\} → \{entity: "[A-Z]{60}", amount: -2, flags: 1\}$/),
    );
    expect(lines).toContainEqual(
        expect.stringMatching(/^orders\[0\] \{entity: "[A-Z]{60}", amount: 0, flags: 1\} → \{entity: "[A-Z]{60}", amount: 777, flags: 1\}$/),
    );
    // The bookkeeping stays behind the full view.
    expect(diff.filter((line) => line.internal).map(flatLine)).toEqual(
        expect.arrayContaining([
            "byKey._occupationFlags[3] 1 → 2",
            "byKey._markRemovalCounter 0 → 1",
            "list._headIndex 2 → 1",
            "list._freeHeadIndex -1 → 2",
            "orders.pov[0].tailIndex 2 → 1",
        ]),
    );
});

test("a tombstone renders as an unoccupied slot and the survivors keep their values", async () => {
    const zoo = await Zoo.deploy();
    zoo.fill(3n);
    zoo.churn(1n, 1n);

    const state = await zoo.state();

    expect(entryLabels(state, "byKey")).toEqual(["slot[1]", "slot[4]"]);
    expect(container(state, "byKey").lines.map(flatLine)).toContain("slots[2..3] (unoccupied ×2; skipped)");
    // Key 1 is gone everywhere but the two id-keyed containers, which lost the collider id(3, 0, 0, 0).
    expect((await zoo.lookup(1n))[0]).toBe(8n + 1024n);
    for (const i of [0n, 2n]) {
        const [found, byKey] = await zoo.lookup(i);
        expect(found).toBe(i === 0n ? 4095n - 8n - 1024n : 4095n);
        expect(entryTexts(state, "byKey")).toContain(`${keyText(i)} = ${byKey}`);
    }
    expect(entryTexts(state, "orders").map((text) => text.match(/amount: (-?\d+)/)![1])).toEqual(["777", "-2"]);
    expect(entryTexts(state, "list")).toEqual(["= 1", "= 0"]);
});

test("cleanup moves slots but no entry, and the collider it sends home shows as a removed/new pair", async () => {
    const zoo = await Zoo.deploy();
    zoo.fill(3n);
    zoo.churn(1n, 1n);
    const before = await zoo.state();
    zoo.cleanup();
    const diff = await zoo.diff();
    const after = await zoo.state();
    const wrapped = await bytesToIdentity(idBytes(3n, 1n));

    for (const name of KEYED) {
        expect(entryTexts(after, name).sort(), name).toEqual(entryTexts(before, name).sort());
    }
    // id(3, 1, 0, 0) had probed past the end into slot 0; with slot 3's tombstone gone it hashes home.
    expect(entryLabels(before, "idSet")).toEqual(["slot[0]", "slot[1]"]);
    expect(entryLabels(after, "idSet")).toEqual(["slot[0]", "slot[3]"]);
    expect(entryTexts(after, "idSet")[1]).toBe(wrapped);

    const lines = visible(diff);
    expect(lines).toContain(`idSet[${wrapped}] (new)`);
    expect(lines).toContain(`arrayValues[${wrapped}][0] = 1 (new)`);
    expect(diff.filter((line) => line.internal).map(flatLine)).toEqual(
        expect.arrayContaining(["byKey._occupationFlags[3] 2 → 1", "byKey._markRemovalCounter 1 → 0", "bitValues._occupationFlags[1] 2 → 0"]),
    );
    expectNoIdenticalImages(diff);
    // A container with nothing to move only loses its tombstone, out of the default view.
    expect(lines.filter((line) => line.startsWith("bitValues") || line.startsWith("signedKey"))).toEqual([]);
});

test("draining leaves every container empty and the bit array one zero run", async () => {
    const zoo = await Zoo.deploy();
    zoo.fill(3n);
    zoo.drain(3n);

    const diff = visible(await zoo.diff());
    const state = await zoo.state();
    const [, , , populations, orderCount, listCount] = await zoo.walk();

    for (const name of [...KEYED, ...ORDERED]) {
        expect([container(state, name).occupiedSlots, container(state, name).totalEntries], name).toEqual([0, 0]);
        expect(
            container(state, name).lines.some((line) => line.filled),
            name,
        ).toBe(false);
    }
    expect(container(state, "bits").lines.map(flatLine)).toEqual(["[0..1023] =0 ×1024 (skipped)"]);
    expect([orderCount, listCount, ...populations]).toEqual(new Array(18).fill(0n));
    expect(diff).toEqual(expect.arrayContaining(["byKey 3 → 0 entries", "orders 3 → 0 entries", "list 3 → 0 entries", "bits[700] 1 → 0"]));
});

test("a print inside a loop keeps every iteration, typed as the element it reads", async () => {
    const zoo = await Zoo.deploy();
    zoo.fill(3n);

    const prints = await zoo.dump();
    const who = await bytesToIdentity(new Uint8Array(32));
    const loop = prints.filter((print) => print.text.startsWith("order "));

    expect(loop.map((print) => print.line)).toEqual([loop[0].line, loop[0].line, loop[0].line]);
    expect(loop.map((print) => print.text)).toEqual([
        `order {entity: "${who}", amount: 0, flags: 1} priority 0`,
        `order {entity: "${who}", amount: -1, flags: 1} priority -100`,
        `order {entity: "${who}", amount: -2, flags: 1} priority -200`,
    ]);
    expect(prints[7].text).toBe(`s8 -1 who ${who} umax 18446744073709551615`);
    expect(prints).toHaveLength(11);
});

test.if(HAS_CORE && HAS_WASI)(
    "the clang build reads back the same rows after the same operations",
    async () => {
        const clang = await buildContractWithClang({
            contractPath: join(import.meta.dir, "../../../../fixtures/StateZoo.h"),
            contractName: "StateZoo",
            slot: SLOT,
            corePath: CORE_PATH,
            outDir: mkdtempSync(join(tmpdir(), "qinit-zoo-clang-")),
        });

        expect(clang.ok, clang.stderr).toBe(true);

        const zoos = [await Zoo.deploy(), await Zoo.deploy(new Uint8Array(await Bun.file(clang.wasmPath!).arrayBuffer()))];
        const seen: string[][] = [];

        for (const zoo of zoos) {
            zoo.fill(3n);
            zoo.update(3n);
            zoo.churn(1n, 1n);
            const churn = visible(await zoo.diff());
            zoo.cleanup();
            seen.push([...rows(await zoo.state()), ...churn, ...(await zoo.dump()).map((print) => print.text)]);
        }

        expect(seen[1]).toEqual(seen[0]);
    },
    120_000,
);
