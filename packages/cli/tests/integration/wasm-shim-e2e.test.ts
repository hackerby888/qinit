import { CORE_PATH } from "../../../../test-utils/paths";
// Exercise system Wasm and dynamic-to-system calls in the simulator.
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithTypeScript, buildSystemContract } from "@qinit/build";
import { wasiSdkPaths } from "@qinit/core/project";
import { VirtualNode } from "@qinit/engine";

const CORE = CORE_PATH;
const haveCore = existsSync(`${CORE}/src/contracts/QUtil.h`) && wasiSdkPaths() !== null;
const haveQx = existsSync(`${CORE}/src/contracts/Qx.h`);
const id = (b: number) => new Uint8Array(32).fill(b);
const i64 = (b: Uint8Array, off = 0) => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(off, true);

test.skipIf(!haveCore)(
    "wasm shim: QUtil SendToManyV1 credits the exact amounts (locals + transfers + decode)",
    async () => {
        const eng = await VirtualNode.create({ fees: "off" });
        const sim = eng.sim;
        const r = await buildSystemContract("QUTIL", CORE, { outDir: `/tmp/qinit-shim-e2e` });
        expect(r.ok).toBe(true);
        const slot = eng.deploy(new Uint8Array(await Bun.file(r.wasmPath!).arrayBuffer()), {
            name: "QUTIL",
            slot: r.index,
        }).slot;

        // functions and procedures have separate id spaces — look them up separately (a combined map would collide).
        const functionId = (name: string) => r.idl!.functions.find((entry) => entry.name === name)!.inputType;
        const pId = (name: string) => r.idl!.procedures.find((entry) => entry.name === name)!.inputType;

        // a read function with output — the contract runs with a _locals frame; the i64 result must decode
        const fee = i64(sim.query(slot, functionId("GetSendToManyV1Fee"), new Uint8Array(0)));
        expect(fee).toBe(10n);

        // SendToManyV1_input: 25 id (dst0..24) then 25 sint64 (amt0..24). Send 1000 -> r1, 2000 -> r2.
        const input = new Uint8Array(25 * 32 + 25 * 8);
        const dv = new DataView(input.buffer);
        input.set(id(0x21), 0);
        input.set(id(0x22), 32);
        dv.setBigInt64(800, 1000n, true);
        dv.setBigInt64(808, 2000n, true);

        const caller = id(0x11);
        const reward = 3000n + fee;
        sim.fund(caller, reward);
        const before1 = sim.balance(id(0x21)),
            before2 = sim.balance(id(0x22));
        const out = sim.procedure(slot, pId("SendToManyV1"), input, { invocator: caller, reward });

        expect(new DataView(out.buffer, out.byteOffset, out.byteLength).getInt32(0, true)).toBe(0); // returnCode OK
        expect(sim.balance(id(0x21)) - before1).toBe(1000n);
        expect(sim.balance(id(0x22)) - before2).toBe(2000n);

        // BurnQubic: a simple procedure — the contract retains none of the burned reward
        const burner = id(0x31);
        sim.fund(burner, 500n);
        const supplyBefore = sim.balanceOf(slot);
        const burnIn = new Uint8Array(8);
        new DataView(burnIn.buffer).setBigInt64(0, 500n, true);
        sim.procedure(slot, pId("BurnQubic"), burnIn, { invocator: burner, reward: 500n });
        expect(sim.balanceOf(slot) - supplyBefore).toBe(0n);
    },
    60_000,
);

test.skipIf(!haveQx)(
    "TypeScript Wasm calls QX Fees and remains live",
    async () => {
        const outDir = mkdtempSync(join(tmpdir(), "qinit-system-call-"));
        try {
            const qx = await buildSystemContract("QX", CORE, {
                compiler: "typescript",
                outDir,
            });
            const gauntlet = await buildContractWithTypeScript({
                contractPath: join(import.meta.dir, "../../../../fixtures/Gauntlet.h"),
                contractName: "Gauntlet",
                slot: 29,
                corePath: CORE,
                outDir,
                dynCallees: {
                    QX: {
                        header: join(CORE, "src/contracts/Qx.h"),
                        slot: 1,
                    },
                },
            });
            expect(qx.ok, qx.stderr).toBe(true);
            expect(gauntlet.ok, gauntlet.stderr).toBe(true);

            const sim = await VirtualNode.create({ fees: "off" });
            sim.deploy(new Uint8Array(await Bun.file(qx.wasmPath!).arrayBuffer()), {
                name: "QX",
                slot: 1,
            });
            sim.deploy(new Uint8Array(await Bun.file(gauntlet.wasmPath!).arrayBuffer()), {
                name: "Gauntlet",
                slot: 29,
            });

            sim.sim.setDebug(true);
            const fees = sim.sim.query(29, 11);
            const view = new DataView(fees.buffer, fees.byteOffset, fees.byteLength);
            expect([view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true)]).toEqual([1_000_000_000, 100, 3_000_000]);
            expect(view.getUint8(12)).toBe(0);

            const trace = sim.sim.getTrace().entries;
            expect(trace.find((entry) => entry.index === 1 && entry.kind === 0 && entry.entry === 1)?.ok).toBe(true);
            expect(trace.find((entry) => entry.index === 29 && entry.kind === 0 && entry.entry === 11)?.hostCalls).toMatchObject([
                { name: "callFunction", detail: "→ @1 fn #1" },
            ]);
            expect(i64(sim.sim.query(29, 5))).toBe(0n);
        } finally {
            rmSync(outDir, { recursive: true, force: true });
        }
    },
    120_000,
);
