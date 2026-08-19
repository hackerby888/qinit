import { CORE_PATH } from "../../../../test-utils/paths";
// Verify that the TypeScript and core WAMR hosts produce identical contract state.
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildContractWithClang } from "@qinit/build";
import { compileContractWithTypeScript } from "@qinit/compiler/browser";
import type { DebugStateRegion } from "@qinit/core";
import { QubicSimulator, initK12, toHex } from "@qinit/engine";

const CORE = CORE_PATH;
// Both are real build directories; whichever exists wins, so the suite runs instead of skipping.
const GTEST =
    [process.env.QINIT_WAMR_GTEST?.trim(), `${CORE}/build-wasm/test/qubic_wasm_tests`, `${CORE}/build-wtests/test/qubic_wasm_tests`]
        .filter((candidate): candidate is string => Boolean(candidate))
        .find(existsSync) ?? "";
const FIX = `${import.meta.dir}/../../../../fixtures`;
const haveBoth = GTEST !== "" && existsSync(`${FIX}/DigestProbe.h`);

const id = (b: number) => new Uint8Array(32).fill(b);
const u64 = (n: bigint) => {
    const a = new Uint8Array(8);
    new DataView(a.buffer).setBigUint64(0, n, true);
    return a;
};
const i64 = (n: bigint) => {
    const a = new Uint8Array(8);
    new DataView(a.buffer).setBigInt64(0, n, true);
    return a;
};
const cat = (...xs: Uint8Array[]) => {
    const t = new Uint8Array(xs.reduce((s, x) => s + x.length, 0));
    let o = 0;
    for (const x of xs) {
        t.set(x, o);
        o += x.length;
    }
    return t;
};

interface Op {
    it: number;
    in: Uint8Array;
}
interface Case {
    name: string;
    slot: number;
    bytes: number;
    covers: string;
    ops: Op[];
}

const CASES: Case[] = [
    {
        name: "DigestProbe",
        slot: 29,
        bytes: 64,
        covers: "mixed-width scalars + Arrays",
        ops: [{ it: 1, in: new Uint8Array(0) }],
    },
    {
        name: "Registry",
        slot: 31,
        bytes: 72,
        covers: "Array<uint64,4> + scalars",
        ops: [
            { it: 1, in: id(0xaa) },
            { it: 2, in: u64(5n) },
            { it: 2, in: u64(7n) },
        ],
    },
    {
        name: "DbgMap",
        slot: 30,
        bytes: 41240,
        covers: "HashMap<id,uint64,1024> + a trailing scalar",
        ops: [
            { it: 2, in: cat(id(0x11), u64(100n)) },
            { it: 2, in: cat(id(0x22), u64(200n)) },
            { it: 1, in: new Uint8Array(0) },
        ],
    },
    {
        name: "DbgColl",
        slot: 32,
        bytes: 114960,
        covers: "Collection<uint64,1024> (PoV priority queues)",
        ops: [
            { it: 1, in: cat(id(0x11), u64(42n), i64(5n)) },
            { it: 1, in: cat(id(0x11), u64(43n), i64(1n)) },
            { it: 1, in: cat(id(0x22), u64(44n), i64(9n)) },
        ],
    },
];

const OUT_DIR = "/tmp/qinit-xhost";

// The deployed backend and the one the node's own toolchain produces have to agree with each other too.
type Backend = "clang" | "typescript";
const BACKENDS: Backend[] = ["clang", "typescript"];

async function buildCase(backend: Backend, testCase: Case): Promise<string> {
    if (backend === "clang") {
        const built = await buildContractWithClang({
            contractPath: `${FIX}/${testCase.name}.h`,
            contractName: testCase.name,
            slot: testCase.slot,
            corePath: CORE,
            outDir: OUT_DIR,
            skipVerify: true,
        });
        expect(built.ok, built.stderr).toBe(true);
        return built.wasmPath!;
    }

    const built = await compileContractWithTypeScript({
        source: readFileSync(`${FIX}/${testCase.name}.h`, "utf8"),
        contractName: testCase.name,
        slot: testCase.slot,
    });
    const wasmPath = `${OUT_DIR}/${testCase.name}.typescript.wasm`;
    await Bun.write(wasmPath, Uint8Array.from(built.wasm));
    return wasmPath;
}

/** The wire form the gtest prints, so both hosts' regions compare as one string per op. */
const encodeRegions = (regions: readonly DebugStateRegion[]) => regions.map((region) => `${region.off},${region.before},${region.after}`).join(";");

for (const backend of BACKENDS) {
    for (const c of CASES) {
        test.skipIf(!haveBoth)(
            `cross-host ${backend}: ${c.name} (${c.covers}) state and diffs identical on the node WAMR and qinit`,
            async () => {
                await initK12();
                const wasmPath = await buildCase(backend, c);
                const wasmBytes = new Uint8Array(await Bun.file(wasmPath).arrayBuffer());

                // qinit side: deploy (runs INITIALIZE) then the op script, read the raw StateData.
                // Debug goes on after deploy so the trace holds one entry per scripted op and nothing else.
                const sim = new QubicSimulator();
                const ct = sim.deploy(c.slot, wasmBytes);
                sim.setDebug(true);
                for (const o of c.ops) sim.procedure(c.slot, o.it, o.in);
                const qinitHex = toHex(ct.state());
                expect(ct.state().length).toBe(c.bytes);
                const qinitEntries = sim.getTrace().entries;

                // node side: same wasm under WAMR, same INITIALIZE + script, via the gtest that prints
                // CROSSHOST_STATE=<hex> and one CROSSHOST_DIFF=<op>:<regions> per op.
                const script = c.ops.map((o) => `${o.it}:${toHex(o.in)}`).join(";");
                const proc = Bun.spawnSync([GTEST, "--gtest_filter=WasmContracts.CrossHostStateEquivalence"], {
                    cwd: tmpdir(),
                    env: {
                        ...process.env,
                        QINIT_WASM: wasmPath,
                        QINIT_SCRIPT: script,
                        QINIT_EXPECTED_SLOT: String(c.slot),
                    },
                });
                const stdout = proc.stdout.toString();
                const state = stdout.match(/CROSSHOST_STATE=([0-9a-f]+)/);
                expect(state, `gtest emitted no CROSSHOST_STATE:\n${stdout}\n${proc.stderr.toString()}`).not.toBeNull();

                // the proof: byte-identical contract state across the two independent host implementations
                expect(state![1]).toBe(qinitHex);

                // and the same again for what each host reports *changed*, which is what a trace shows
                const nodeDiffs = [...stdout.matchAll(/CROSSHOST_DIFF=(\d+):(.*)/g)].map((match) => [Number(match[1]), match[2]!.trim()] as const);
                if (nodeDiffs.length === 0) {
                    return; // an artifact built before the journal reports state only
                }

                expect(nodeDiffs.length, "the node reported one diff per op").toBe(c.ops.length);
                expect(qinitEntries.length, "qinit traced one entry per op").toBe(c.ops.length);

                for (const [index, body] of nodeDiffs) {
                    const entry = qinitEntries[index]!;
                    if (body === "overflow" || body === "trap") {
                        expect(entry.stateTruncated, `op ${index}: the node reported ${body}, qinit did not`).toBe(true);
                        continue;
                    }

                    expect(entry.stateTruncated, `op ${index}: qinit truncated, the node did not`).toBe(false);
                    expect(encodeRegions(entry.stateDiff), `op ${index}: the two hosts report different changed bytes`).toBe(body);
                }
            },
            120_000,
        );
    }
}
