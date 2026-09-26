// `--state` parsing and the chunked upload: a wrong name or a short read must fail here, before a node is asked to deploy anything.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ContractIdl } from "@qinit/build";
import { STATE_STAGE_CHUNK_BYTES, parseInitialStates, stageContractState } from "../../src/contracts/state-stage";
import { initialStateRejection } from "../../src/ops/deploy/state-layout";

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateFile(name: string, bytes: Uint8Array): string {
    const dir = mkdtempSync(join(tmpdir(), "qinit-stage-"));
    dirs.push(dir);
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
}

test("parseInitialStates: a bare path names the main contract, Name=path any other", () => {
    const mainPath = stateFile("main.bin", new Uint8Array(8));
    const calleePath = stateFile("callee.bin", new Uint8Array(8));
    // an '=' only splits off an identifier, so a path may carry one
    const oddPath = stateFile("a=b.bin", new Uint8Array(8));

    expect(parseInitialStates([mainPath, `Callee=${calleePath}`], "Main")).toEqual({ Main: resolve(mainPath), Callee: resolve(calleePath) });
    expect(parseInitialStates([oddPath], "Main")).toEqual({ Main: resolve(oddPath) });
    expect(parseInitialStates(undefined, "Main")).toEqual({});

    expect(() => parseInitialStates([mainPath])).toThrow("expected Name=path");
    expect(() => parseInitialStates([mainPath, `Main=${calleePath}`], "Main")).toThrow("duplicate --state for 'Main'");
    expect(() => parseInitialStates([join(tmpdir(), "qinit-no-such-state.bin")], "Main")).toThrow("--state file not found");
});

test("stageContractState streams the file as ordered chunks against one total", async () => {
    const image = new Uint8Array(STATE_STAGE_CHUNK_BYTES * 2 + 5).map((_, index) => index % 251);
    const path = stateFile("big.bin", image);
    const received = new Uint8Array(image.length);
    const offsets: number[] = [];
    const rpc = {
        stageState: async (slot: number, offset: number, total: number, chunk: Uint8Array) => {
            expect(slot).toBe(7);
            expect(total).toBe(image.length);
            offsets.push(offset);
            received.set(chunk, offset);
            return { ok: true, received: offset + chunk.length, total };
        },
    };

    expect(await stageContractState(rpc, 7, path)).toBe(image.length);
    expect(offsets).toEqual([0, STATE_STAGE_CHUNK_BYTES, STATE_STAGE_CHUNK_BYTES * 2]);
    expect(received).toEqual(image);

    await expect(stageContractState({ stageState: async () => null }, 7, path)).rejects.toThrow("node does not support --state");
    await expect(stageContractState(rpc, 7, stateFile("empty.bin", new Uint8Array(0)))).rejects.toThrow("state file is empty");
});

test("initialStateRejection takes the StateData size or the MIGRATE input size, nothing else", () => {
    const plain = { state: { size: 16 } } as ContractIdl;
    const migrating = { state: { size: 16 }, migration: { oldState: { size: 8 } } } as ContractIdl;

    expect(initialStateRejection("C", 16, plain)).toBeNull();
    expect(initialStateRejection("C", 8, plain)).toBe("state file is 8 B but C's StateData is 16 B");
    expect(initialStateRejection("C", 8, migrating)).toBeNull();
    expect(initialStateRejection("C", 12, migrating)).toBe("state file is 12 B but C's StateData is 16 B, or 8 B for its MIGRATE handler");
});
