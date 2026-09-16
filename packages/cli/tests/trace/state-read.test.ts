// readState turns RPC range reads into decoded state, so the failure paths matter as much: a node can answer short, garbage, or from either side of an update.
import { expect, test } from "bun:test";
import { extractIdl } from "@qinit/build";
import { hashMapGeometry } from "@qinit/proto";
import { loadStateContainer, readState, stateIsComplete, type StateReader } from "../../src/trace/state-read";
import { stateFieldsOf } from "../../src/trace/state-format";

const SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    uint64 counter;
    id owner;
    Array<uint64, 4> nums;
    HashMap<uint64, uint64, 8> map;
    BitArray<64> bits;
  };
  INITIALIZE() {}
};`;

const IDL = extractIdl(SRC, "Layout", { slot: 7 });
const FIELDS = stateFieldsOf(IDL);
const STATE_SIZE = IDL.state.size;
const MAP = FIELDS.find((field) => field.name === "map")!;
const MAP_GEOMETRY = hashMapGeometry({ size: 8, align: 8 }, { size: 8, align: 8 }, 8);

// counter = 42, and one live map entry 5 -> 6.
function stateBytes(): Uint8Array {
    const bytes = new Uint8Array(STATE_SIZE);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(0, 42n, true);
    view.setBigUint64(MAP.off, 5n, true);
    view.setBigUint64(MAP.off + MAP_GEOMETRY.elementValueOffset, 6n, true);
    view.setBigUint64(MAP.off + MAP_GEOMETRY.flagsOffset, 1n, true);
    view.setBigUint64(MAP.off + MAP_GEOMETRY.populationOffset, 1n, true);
    return bytes;
}

const readerOf = (hexFor: (offset: number, length: number) => string): StateReader => ({
    stateRead: async (_slot, offset, length) => ({ hex: hexFor(offset, length) }),
});

const honestReader = (bytes = stateBytes()) => readerOf((offset, length) => Buffer.from(bytes.slice(offset, offset + length)).toString("hex"));

const readLayout = (rpc: StateReader, options = {}) => readState(rpc, 7, SRC, "Layout", undefined, undefined, options);

test("a complete read decodes the scalars and loads every container", async () => {
    const state = await readLayout(honestReader());

    expect(state.fields[0]).toEqual({ name: "counter", value: "42", data: 42n });
    expect(state.fields[1].value).toMatch(/^[A-Z]{60}$/);
    expect(state.containers.map((container) => `${container.name}/${container.kind}/${container.status}`)).toEqual([
        "nums/array/loaded",
        "map/hashmap/loaded",
        "bits/bitarray/loaded",
    ]);
    expect(state.containers[1].occupiedSlots).toBe(1);
    expect(state.complete).toBe(true);
});

test("a malformed hex answer fails every field instead of decoding garbage", async () => {
    for (const [label, rpc] of [
        ["odd length", readerOf(() => "abc")],
        ["not hex", readerOf((_offset, length) => "zz".repeat(length))],
    ] as const) {
        const state = await readLayout(rpc);
        expect(`${label}: ${state.fields[0].value}`).toBe(`${label}: (read failed: invalid state read at 0)`);
        expect(state.containers.every((container) => container.status === "error")).toBe(true);
        expect(state.complete).toBe(false);
    }
});

test("a node that answers nothing is a short read, not an endless loop", async () => {
    const state = await readLayout(readerOf(() => ""));

    expect(state.fields[0].value).toBe("(read failed: short state read at 0: expected 8 bytes, got 0)");
    expect(state.containers[1].error).toMatch(/short state read at \d+: expected 8 bytes, got 0/);
    expect(state.complete).toBe(false);
});

test("a chunk longer than requested is refused rather than written past the field", async () => {
    const bytes = stateBytes();
    const state = await readLayout(readerOf((offset, length) => Buffer.from(bytes.slice(offset, offset + length + 8)).toString("hex")));

    expect(state.fields[0].value).toBe("(read failed: short state read at 0: expected 8 bytes, got 0)");
    expect(state.containers[1].status).toBe("error");
    expect(state.complete).toBe(false);
});

test("one inconsistent container view is retried, a second failure is reported", async () => {
    const populationOffset = MAP.off + MAP_GEOMETRY.populationOffset;
    // The population word is what the retry hinges on: a range read can catch it mid-update.
    const lyingReader = (liesForever: boolean) => {
        let populationReads = 0;
        const rpc: StateReader = {
            stateRead: async (_slot, offset, length) => {
                const window = stateBytes().slice(offset, offset + length);
                if (offset <= populationOffset && populationOffset < offset + length) {
                    populationReads++;
                    if (liesForever || populationReads === 1) {
                        new DataView(window.buffer).setBigUint64(populationOffset - offset, 2n, true);
                    }
                }
                return { hex: Buffer.from(window).toString("hex") };
            },
        };
        return { rpc, reads: () => populationReads };
    };

    const flaky = lyingReader(false);
    const recovered = await readLayout(flaky.rpc);
    expect(recovered.containers[1].status).toBe("loaded");
    expect(recovered.containers[1].occupiedSlots).toBe(1);
    expect(flaky.reads()).toBe(2); // read once, retried once

    const broken = lyingReader(true);
    const failed = await readLayout(broken.rpc);
    expect(failed.containers[1].status).toBe("error");
    expect(failed.containers[1].error).toBe("HashMap has 1 occupied slots but population 2");
    expect(broken.reads()).toBe(2); // retried exactly once, then gave up
    expect(failed.complete).toBe(false);
});

test("an incomplete read is not retried — only an inconsistent one is", async () => {
    let reads = 0;
    const state = await readLayout({
        stateRead: async () => {
            reads++;
            return { hex: "" };
        },
    });

    expect(state.containers[1].status).toBe("error");
    expect(state.containers[1].error).toMatch(/short state read/);
    // Five fields, one read each: nothing was attempted twice.
    expect(reads).toBe(FIELDS.length);
});

test("a node capped below the requested length is read in chunks", async () => {
    const CAP = 262144;
    const chunkedSrc = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    Array<uint64, 65536> big;
  };
  INITIALIZE() {}
};`;
    const chunkedIdl = extractIdl(chunkedSrc, "Chunked", { slot: 7 });
    const backing = new Uint8Array(chunkedIdl.state.size);
    new DataView(backing.buffer).setBigUint64(8, 77n, true);

    const requested: number[] = [];
    const progress: [string, number, number][] = [];
    const state = await readState(
        {
            stateRead: async (_slot, offset, length) => {
                requested.push(length);
                return { hex: Buffer.from(backing.slice(offset, offset + Math.min(length, CAP))).toString("hex") };
            },
        },
        7,
        chunkedSrc,
        "Chunked",
        undefined,
        (name, done, total) => progress.push([name, done, total]),
    );

    expect(backing.length).toBe(524288);
    expect(requested).toEqual([524288, 262144]); // one full ask, then the remainder
    expect(state.containers[0].status).toBe("loaded");
    expect(state.containers[0].lines[1]).toEqual({ label: "[1]", text: "77", filled: true });

    const totals = progress.map(([, done]) => done);
    expect(totals).toEqual([...totals].sort((left, right) => left - right)); // monotonic
    expect(progress.at(-1)).toEqual(["state", backing.length, backing.length]);
});

test("aggregate progress ends at the total even when containers report no bytes of their own", async () => {
    const progress: [string, number, number][] = [];
    await readState(honestReader(), 7, SRC, "Layout", undefined, (name, done, total) => progress.push([name, done, total]));

    expect(progress[0]).toEqual(["state", 0, STATE_SIZE]);
    expect(progress.at(-1)).toEqual(["state", STATE_SIZE, STATE_SIZE]);
    expect(progress.every(([, done, total]) => done <= total)).toBe(true);
});

test("fields land in declaration order however the reads finish", async () => {
    const bytes = stateBytes();
    // The last field answers first, the first field answers last.
    const state = await readLayout({
        stateRead: async (_slot, offset, length) => {
            await new Promise((resolve) => setTimeout(resolve, Math.max(0, 4 - Math.floor(offset / 32))));
            return { hex: Buffer.from(bytes.slice(offset, offset + length)).toString("hex") };
        },
    });

    expect(state.fields.map((field) => field.name)).toEqual(["counter", "owner"]);
    expect(state.containers.map((container) => container.name)).toEqual(["nums", "map", "bits"]);
});

test("a container index outside the container count is rejected before any read", async () => {
    for (const index of [0, 4, -1, 1.5]) {
        await expect(readLayout(honestReader(), { containerIndexes: new Set([index]) })).rejects.toThrow(RangeError);
    }
    await expect(readLayout(honestReader(), { containerIndexes: new Set([3]) })).resolves.toBeDefined();
});

test("collapsing keeps the selected containers and loadAllContainers overrides it", async () => {
    const statuses = (state: Awaited<ReturnType<typeof readLayout>>) => state.containers.map((container) => `${container.name}/${container.status}`);

    expect(statuses(await readLayout(honestReader(), { collapseContainersAtBytes: 1 }))).toEqual(["nums/collapsed", "map/collapsed", "bits/collapsed"]);
    expect(statuses(await readLayout(honestReader(), { collapseContainersAtBytes: 1, loadAllContainers: true }))).toEqual([
        "nums/loaded",
        "map/loaded",
        "bits/loaded",
    ]);
    expect(statuses(await readLayout(honestReader(), { collapseContainersAtBytes: 1, containerIndexes: new Set([2]) }))).toEqual([
        "nums/collapsed",
        "map/loaded",
        "bits/collapsed",
    ]);
    // A container below the threshold is never collapsed.
    expect(statuses(await readLayout(honestReader(), { collapseContainersAtBytes: STATE_SIZE }))).toEqual(["nums/loaded", "map/loaded", "bits/loaded"]);
});

test("loadStateContainer fills in a container that was collapsed", async () => {
    const collapsed = await readLayout(honestReader(), { collapseContainersAtBytes: 1 });
    const progress: [string, number, number][] = [];
    const loaded = await loadStateContainer(honestReader(), 7, collapsed.containers[1], (name, done, total) => progress.push([name, done, total]));

    expect(loaded.status).toBe("loaded");
    expect(loaded.occupiedSlots).toBe(1);
    expect(progress[0]).toEqual(["map", 0, MAP.size]);
    expect(progress.at(-1)).toEqual(["map", MAP.size, MAP.size]);

    await expect(loadStateContainer(honestReader(), 7, { ...collapsed.containers[1], sourceField: FIELDS[0] }, undefined)).rejects.toThrow(
        /is not a state container/,
    );
});

test("stateIsComplete treats a failed read, an undecodable field, and an errored container alike", () => {
    expect(stateIsComplete({ fields: [{ name: "a", value: "1" }], containers: [] })).toBe(true);
    expect(stateIsComplete({ fields: [{ name: "a", value: "(read failed: nope)", failed: true }], containers: [] })).toBe(false);
    expect(stateIsComplete({ fields: [{ name: "a", value: "(undecodable: Weird — fields below not shown)", failed: true }], containers: [] })).toBe(false);
    expect(
        stateIsComplete({
            fields: [],
            containers: [{ status: "error" } as never],
        }),
    ).toBe(false);
    expect(stateIsComplete({ fields: [], containers: [{ status: "collapsed" } as never] })).toBe(true);
});

// completeness used to be read off the rendered text, so a member named like a failure marker failed a read that had succeeded
test("a decoded value whose text looks like a failure marker is still complete, and a real failure is flagged", async () => {
    const source = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Flags { uint64 undecodable; uint64 other; };
  struct StateData { Flags status; };
  INITIALIZE() {}
};`;
    const bytes = new Uint8Array(16);
    bytes[0] = 5;
    bytes[8] = 6;

    const state = await readState(honestReader(bytes), 7, source, "Markers");
    expect(state.fields).toEqual([{ name: "status", value: "{undecodable: 5, other: 6}", data: { undecodable: 5n, other: 6n } }]);
    expect(state.complete).toBe(true);

    const failed = await readState(
        readerOf(() => ""),
        7,
        source,
        "Markers",
    );
    expect(failed.fields[0]).toMatchObject({ name: "status", failed: true });
    expect(failed.complete).toBe(false);
});

// A container inside a struct field takes the next number in declaration order, so every block is addressable.
const NESTED_SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Inner { HashMap<uint64, uint64, 8> map; uint64 tag; };
  struct StateData {
    Array<uint64, 4> nums;
    Inner inner;
    HashSet<uint64, 8> set;
  };
  INITIALIZE() {}
};`;

test("nested containers are numbered in one sequence with the top-level ones", async () => {
    const size = extractIdl(NESTED_SRC, "Nested", { slot: 7 }).state.size;
    const zeros = readerOf((offset, length) => "00".repeat(Math.min(length, Math.max(0, size - offset))));
    const read = (options = {}) => readState(zeros, 7, NESTED_SRC, "Nested", undefined, undefined, options);

    const state = await read();
    expect(state.containers.map((container) => [container.name, container.index])).toEqual([
        ["nums", 1],
        ["inner.map", 2],
        ["set", 3],
    ]);
    expect(state.fields.map((field) => field.name)).toEqual(["inner.tag"]);

    await expect(read({ containerIndexes: new Set([4]) })).rejects.toThrow("container index 4 is outside 1..3");
    const selected = await read({ containerIndexes: new Set([2]), collapseContainersAtBytes: 1 });
    expect(selected.containers.map((container) => `${container.name}/${container.status}`)).toEqual(["nums/collapsed", "inner.map/loaded", "set/collapsed"]);
});

// A view is stitched from several reads, each well-formed across a write, so only the version reports one.
const versionShiftingReader = (liesForever: boolean) => {
    const populationOffset = MAP.off + MAP_GEOMETRY.populationOffset;
    let attempts = 0;
    let mapReads = 0;

    const rpc: StateReader = {
        stateRead: async (_slot, offset, length) => {
            const hex = Buffer.from(stateBytes().slice(offset, offset + length)).toString("hex");
            if (offset < MAP.off || offset >= MAP.off + MAP.size) {
                return { hex, version: 1 }; // read once: nothing to compare against
            }
            if (offset <= populationOffset && populationOffset < offset + length) {
                attempts++; // the population read opens each attempt
                mapReads = 0;
            }
            mapReads++;
            return { hex, version: mapReads > 1 && (liesForever || attempts === 1) ? 2 : 1 };
        },
    };
    return { rpc, attempts: () => attempts };
};

test("a state version that moves mid-read fails the container instead of reporting a stitched view", async () => {
    const broken = versionShiftingReader(true);
    const failed = await readLayout(broken.rpc);

    expect(failed.containers[1].status).toBe("error");
    expect(failed.containers[1].error).toMatch(/map changed while it was being read \(state version 1 → 2\)/);
    expect(broken.attempts()).toBe(2); // retried exactly once, then gave up
    expect(failed.complete).toBe(false);
});

test("a state version that settles on the retry loads normally", async () => {
    const flaky = versionShiftingReader(false);
    const recovered = await readLayout(flaky.rpc);

    expect(recovered.containers[1].status).toBe("loaded");
    expect(recovered.containers[1].occupiedSlots).toBe(1);
    expect(flaky.attempts()).toBe(2);
    expect(recovered.complete).toBe(true);
});

test("a node that reports no version is read exactly as before", async () => {
    // Existing fakes omit `version`; the check stays inert for an older node.
    const state = await readLayout(honestReader());

    expect(state.containers[1].status).toBe("loaded");
    expect(state.complete).toBe(true);
});

test("an Array and a BitArray are covered too, though neither has an invariant of its own", async () => {
    // Chunked so each field takes several reads; without the version nothing here could notice a write.
    const CHUNK = 4; // even the 8-byte BitArray then takes more than one read
    const shifting = (fieldName: "nums" | "bits"): StateReader => {
        const field = FIELDS.find((candidate) => candidate.name === fieldName)!;
        let reads = 0;
        return {
            stateRead: async (_slot, offset, length) => {
                const capped = Math.min(length, CHUNK);
                const hex = Buffer.from(stateBytes().slice(offset, offset + capped)).toString("hex");
                if (offset < field.off || offset >= field.off + field.size) {
                    return { hex, version: 1 };
                }
                // Strictly increasing: every attempt sees the state move.
                return { hex, version: ++reads };
            },
        };
    };

    const nums = await readLayout(shifting("nums"));
    expect(nums.containers.find((container) => container.name === "nums")!.status).toBe("error");

    const bits = await readLayout(shifting("bits"));
    expect(bits.containers.find((container) => container.name === "bits")!.status).toBe("error");
});
