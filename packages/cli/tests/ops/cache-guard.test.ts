// `QINIT_CACHE=. qinit clean` once emptied a project directory: the wipe has to prove the root is a qinit cache first.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { assertWipeableCacheRoot, wipeCache } from "../../src/ops/cache";

const scratch = () => mkdtempSync(join(tmpdir(), "qinit-cache-guard-"));

async function withCacheEnv<T>(root: string, run: () => Promise<T>): Promise<T> {
    const previous = process.env.QINIT_CACHE;
    process.env.QINIT_CACHE = root;
    try {
        return await run();
    } finally {
        if (previous === undefined) delete process.env.QINIT_CACHE;
        else process.env.QINIT_CACHE = previous;
    }
}

test("a root that is missing, empty, or holds any entry qinit writes on demand is wipeable", () => {
    const dir = scratch();
    try {
        expect(() => assertWipeableCacheRoot(join(dir, "not-yet-created"))).not.toThrow();
        expect(() => assertWipeableCacheRoot(dir)).not.toThrow();

        // each is the first thing some command writes into a fresh cache
        for (const first of ["active-node-scratch", "node-index.json", "current.json"]) {
            const root = join(dir, first.replace(/\W/g, "_"));
            mkdirSync(root);
            writeFileSync(join(root, first), "");
            expect(() => assertWipeableCacheRoot(root), first).not.toThrow();
        }
        for (const first of ["downloads", "tools", "wasi-sdk", "run", "local", "qinit-v1.2.3"]) {
            const root = join(dir, first);
            mkdirSync(join(root, first), { recursive: true });
            expect(() => assertWipeableCacheRoot(root), first).not.toThrow();
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a populated root with nothing of the cache in it is refused", () => {
    const dir = scratch();
    try {
        writeFileSync(join(dir, "README.md"), "# mine");
        expect(() => assertWipeableCacheRoot(dir)).toThrow("nothing of the qinit cache is there");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the filesystem root, the home directory and the working directory are refused whatever they hold", () => {
    const cwd = process.cwd();
    for (const root of [parse(cwd).root, homedir(), cwd, resolve(cwd, ".."), "."]) {
        expect(() => assertWipeableCacheRoot(root), root).toThrow("refusing to remove");
    }
});

test("wipeCache leaves a stray directory alone and removes a real cache", async () => {
    const stray = scratch();
    const cache = scratch();
    try {
        writeFileSync(join(stray, "notes.txt"), "keep me");
        await withCacheEnv(stray, async () => {
            await expect(wipeCache()).rejects.toThrow("nothing of the qinit cache is there");
        });
        expect(existsSync(join(stray, "notes.txt"))).toBe(true);

        writeFileSync(join(cache, "current.json"), "{}");
        const wiped = await withCacheEnv(cache, () => wipeCache());
        expect(wiped.exists).toBe(true);
        expect(existsSync(cache)).toBe(false);
    } finally {
        rmSync(stray, { recursive: true, force: true });
        rmSync(cache, { recursive: true, force: true });
    }
});
