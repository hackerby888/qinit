import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dumpContractState, resolveDumpPath, STATE_DUMP_DIR, STATE_READ_CHUNK_BYTES, type StateDumpRpc } from "../../src/contracts/state-dump";

const workDir = mkdtempSync(join(tmpdir(), "qinit-state-dump-"));

afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
});

// Simulate an older node that still returns at most 256 KiB per request.
function stateRpc(state: Uint8Array, reads: number[] = [], requestedLengths: number[] = []): StateDumpRpc {
    return {
        stateRead: async (_slot: number, off: number, len: number) => {
            reads.push(off);
            requestedLengths.push(len);
            const chunk = state.slice(off, off + Math.min(len, 262144));
            return {
                off,
                len: chunk.length,
                stateSize: state.length,
                hex: Buffer.from(chunk).toString("hex"),
            };
        },
    };
}

test("the default dump path lives under the project's state directory", () => {
    expect(resolveDumpPath("Counter", 29)).toBe(resolve(STATE_DUMP_DIR, "Counter_dump.bin"));
});

test("--out names a file directly and an existing directory by its contents", () => {
    const outDir = join(workDir, "dumps");
    mkdirSync(outDir, { recursive: true });

    expect(resolveDumpPath("Counter", 29, join(workDir, "before.bin"))).toBe(join(workDir, "before.bin"));
    expect(resolveDumpPath("Counter", 29, outDir)).toBe(join(outDir, "Counter_dump.bin"));
    expect(resolveDumpPath("Counter", 29, join(workDir, "missing") + "/")).toBe(join(workDir, "missing", "Counter_dump.bin"));
});

// The name arrives from the node's registry, so it must not be able to steer the write.
test("dump file names are sanitized, and an empty name falls back to the slot", () => {
    expect(resolveDumpPath("../../etc/passwd", 29)).toBe(resolve(STATE_DUMP_DIR, ".._.._etc_passwd_dump.bin"));
    expect(resolveDumpPath("", 29)).toBe(resolve(STATE_DUMP_DIR, "slot-29_dump.bin"));
});

test("a dump pages the whole state to disk and reports its size", async () => {
    const state = new Uint8Array(262144 + 5000);
    for (let index = 0; index < state.length; index++) {
        state[index] = index % 251;
    }

    const reads: number[] = [];
    const requestedLengths: number[] = [];
    const path = join(workDir, "paged.bin");
    const result = await dumpContractState(stateRpc(state, reads, requestedLengths), 29, "Counter", {
        out: path,
    });

    expect(result).toEqual({
        ok: true,
        slot: 29,
        name: "Counter",
        path,
        size: state.length,
    });
    expect(reads).toEqual([0, 262144]);
    expect(requestedLengths).toEqual([STATE_READ_CHUNK_BYTES, STATE_READ_CHUNK_BYTES]);
    expect(new Uint8Array(readFileSync(path))).toEqual(state);
});

test("a dump reports progress against the node's state size", async () => {
    const progress: [number, number][] = [];
    await dumpContractState(stateRpc(new Uint8Array(300000)), 29, "Counter", {
        out: join(workDir, "progress.bin"),
        onProgress: (written, total) => progress.push([written, total]),
    });

    expect(progress).toEqual([
        [262144, 300000],
        [300000, 300000],
    ]);
});

test("a failed read leaves no truncated dump behind", async () => {
    const path = join(workDir, "failed.bin");
    const rpc = {
        stateRead: async () => ({ error: "bad slot" }) as any,
    };

    await expect(dumpContractState(rpc, 999, "Ghost", { out: path })).rejects.toThrow("state read failed for slot 999");
    expect(existsSync(path)).toBe(false);
});

test("a read that returns nothing before the end fails instead of spinning", async () => {
    const path = join(workDir, "stalled.bin");
    const rpc: StateDumpRpc = {
        stateRead: async (_slot, off) => ({ off, len: 0, stateSize: 64, hex: "" }),
    };

    await expect(dumpContractState(rpc, 29, "Counter", { out: path })).rejects.toThrow("state read stalled at 0 of 64 bytes");
    expect(existsSync(path)).toBe(false);
});

// The simulator answers for a slot it has never heard of with an empty state, not an error.
test("an empty state is reported as an undeployed slot, not an empty dump", async () => {
    const path = join(workDir, "empty.bin");

    await expect(dumpContractState(stateRpc(new Uint8Array(0)), 40, "40", { out: path })).rejects.toThrow("slot 40 has no state");
    expect(existsSync(path)).toBe(false);
});
