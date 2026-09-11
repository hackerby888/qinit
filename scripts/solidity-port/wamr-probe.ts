// The third oracle: run one contract under core's own WAMR host and compare against the qinit
// simulator. Build prerequisites and usage are in README.md.

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { compileContractWithTypeScript } from "@qinit/compiler/browser";
import { QubicSimulator, initK12, toHex } from "@qinit/engine";

const GTEST = process.env.QINIT_WAMR_GTEST ?? `${process.env.QINIT_CORE}/build-wasm/test/qubic_wasm_tests`;

// The oracle binary is not in any repo and does not survive a container restart, so fail here with the
// one command that rebuilds it rather than letting every cell report a mystery trap.
if (!existsSync(GTEST)) {
    console.error(`error: the WAMR oracle is not built at ${GTEST}\n`);
    console.error("  QINIT_CORE=/path/to/core-lite scripts/solidity-port/build-wamr-oracle.sh\n");
    console.error("Then set QINIT_WAMR_GTEST to the path it prints.");
    process.exit(2);
}
const CORE = process.env.QINIT_CORE!;
const OUT = "/tmp/qinit-wamr-probe";

/** The natives core's crosshost gtest registers; calling anything outside this set traps there. Must track
 *  core-lite's test/wasm_contracts.cpp, or contracts the shim newly supports get misread as shim-traps. */
const REGISTERED_NATIVES = new Set([
    "beginFn",
    "endFn",
    "markDirty",
    "acquireScratch",
    "releaseScratch",
    "k12",
    "tick",
    "epoch",
    "initialTick",
    "numberOfTickTransactions",
    "year",
    "month",
    "day",
    "hour",
    "minute",
    "second",
    "millisecond",
    "now",
    "pauseLog",
    "resumeLog",
]);

/** The `lhost.*` functions a wasm module imports, read straight out of its import section. */
export function hostImports(wasm: Uint8Array): string[] {
    const readVaruint = (at: number): [number, number] => {
        let result = 0;
        let shift = 0;
        let cursor = at;
        for (;;) {
            const byte = wasm[cursor++]!;
            result |= (byte & 0x7f) << shift;
            shift += 7;
            if ((byte & 0x80) === 0) return [result, cursor];
        }
    };

    const names: string[] = [];
    let cursor = 8; // past the magic number and version
    while (cursor < wasm.length) {
        const sectionId = wasm[cursor++]!;
        const [sectionSize, afterSize] = readVaruint(cursor);
        cursor = afterSize;
        if (sectionId === 2) {
            let at = cursor;
            let count: number;
            [count, at] = readVaruint(at);
            for (let index = 0; index < count; index++) {
                let length: number;
                [length, at] = readVaruint(at);
                const module = new TextDecoder().decode(wasm.subarray(at, at + length));
                at += length;
                [length, at] = readVaruint(at);
                const field = new TextDecoder().decode(wasm.subarray(at, at + length));
                at += length;
                const kind = wasm[at++]!;
                if (kind === 0) [, at] = readVaruint(at);
                else if (kind === 1) at += 2;
                else if (kind === 2) at += 2;
                else at += 1;
                if (module === "lhost") names.push(field);
            }
        }
        cursor += sectionSize;
    }
    return names;
}

/** Imports this module declares that the gtest does not register. Not a reachability gate — WAMR resolves
 *  lazily, so use it only to explain a trap after the fact, never to predict one. */
export function unregisteredImports(wasm: Uint8Array): string[] {
    return hostImports(wasm).filter((name) => !REGISTERED_NATIVES.has(name));
}

export interface Verdict {
    simulator: string;
    wamr: string;
    agree: boolean;
}

/** What the qinit simulator makes of one backend's artifact. */
function underSimulator(wasm: Uint8Array, slot: number, ops: string[]): string {
    const sim = new QubicSimulator();
    const contract = sim.deploy(slot, wasm);
    for (const op of ops) {
        const [entry, hex] = op.split(":");
        try {
            sim.procedure(slot, Number(entry), Uint8Array.from(Buffer.from(hex ?? "", "hex")));
        } catch (error) {
            return `TRAP(${(error as Error).message})`;
        }
    }
    return toHex(contract.state());
}

/** What core's own WAMR host makes of the same artifact. */
function underWamr(wasmPath: string, wasm: Uint8Array, slot: number, ops: string[]): string {
    const proc = Bun.spawnSync([GTEST, "--gtest_filter=WasmContracts.CrossHostStateEquivalence"], {
        cwd: tmpdir(),
        env: { ...process.env, QINIT_WASM: wasmPath, QINIT_SCRIPT: ops.join(";"), QINIT_EXPECTED_SLOT: String(slot) },
    });
    const out = proc.stdout.toString();
    const trap = [...out.matchAll(/CROSSHOST_OP=(\d+):trap/g)][0];
    if (trap) {
        // A trap here is only meaningful once the missing-shim explanation is ruled out.
        const missing = unregisteredImports(wasm);
        const suspect =
            missing.length > 0
                ? `  [module also imports unregistered lhost.${missing.slice(0, 3).join(", lhost.")}${missing.length > 3 ? ` +${missing.length - 3} more` : ""} — rule the shim out before reading this as a real trap]`
                : "";
        return `TRAP(at op ${trap[1]})${suspect}`;
    }
    const state = out.match(/CROSSHOST_STATE=([0-9a-f]+)/);
    return state ? state[1]! : `NO_STATE(${out.slice(-300)})`;
}

async function main(): Promise<void> {
    const [headerPath, contractName, slotText, ...ops] = process.argv.slice(2);
    if (!headerPath || !contractName || !slotText) {
        console.error("usage: wamr-probe.ts <header> <ContractName> <slot> <procedure:inputHex>...");
        process.exit(2);
    }
    const slot = Number(slotText);
    await initK12();

    const clang = await buildContractWithClang({
        contractPath: resolve(headerPath),
        contractName,
        slot,
        corePath: CORE,
        outDir: OUT,
        skipVerify: true,
    });

    const artifacts: { backend: string; path: string }[] = [];
    if (clang.ok) artifacts.push({ backend: "clang", path: clang.wasmPath! });
    else console.log(`  clang       REJECTED — ${clang.stderr?.split("\n")[0] ?? "build failed"}`);

    try {
        const ts = await compileContractWithTypeScript({ source: readFileSync(headerPath, "utf8"), contractName, slot });
        const path = `${OUT}/${contractName}.typescript.wasm`;
        await Bun.write(path, Uint8Array.from(ts.wasm));
        artifacts.push({ backend: "typescript", path });
    } catch (error) {
        console.log(`  typescript  REJECTED — ${(error as Error).message.split("\n")[0]}`);
    }

    console.log(`${contractName} slot ${slot} script ${ops.join(";")}\n`);
    for (const { backend, path } of artifacts) {
        const wasm = new Uint8Array(readFileSync(path));
        const simulator = underSimulator(wasm, slot, ops);
        const wamr = underWamr(path, wasm, slot, ops);
        const agree = simulator === wamr || (simulator.startsWith("TRAP") && wamr.startsWith("TRAP"));
        console.log(`  ${backend.padEnd(11)} simulator ${simulator}`);
        console.log(`  ${" ".repeat(11)} WAMR      ${wamr}${agree ? "" : "   <-- SIMULATOR AND REAL HOST DISAGREE"}`);
        const imports = hostImports(wasm);
        console.log(
            `  ${" ".repeat(11)} imports   ${imports.length} lhost functions, ${unregisteredImports(wasm).length} of them unregistered by the gtest shim\n`,
        );
    }
}

// Only when run directly: wamr-sweep.ts imports hostImports/unregisteredImports from here.
if (import.meta.main) await main();
