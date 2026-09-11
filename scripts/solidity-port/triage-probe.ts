// Run one triage directory through both backends and print the two final states side by side.
// Usage and the T_BASE/T_NAME/T_FILE variables are documented in README.md.

import { existsSync, readFileSync } from "node:fs";
import { buildContractWithClang, buildContractWithTypeScript } from "@qinit/build";
import { QubicSimulator, initK12, toHex } from "@qinit/engine";

await initK12();

const base = process.env.T_BASE;
const name = process.env.T_NAME;
if (!base || !name) {
    console.error("usage: T_BASE=<absolute triage dir> T_NAME=<ContractName> [T_FILE=<header basename>] bun run scripts/solidity-port/triage-probe.ts");
    process.exit(2);
}
if (!base.startsWith("/")) {
    console.error(`error: T_BASE must be absolute, got '${base}' — clang builds from its own output directory and will not find the header.`);
    process.exit(2);
}

const script = JSON.parse(readFileSync(`${base}/script.json`, "utf8"));
const slot = script.slot ?? 29;
const results: Record<string, string> = {};

for (const [backend, build] of [
    ["clang", buildContractWithClang],
    ["typescript", buildContractWithTypeScript],
] as const) {
    const built = await build({
        contractPath: `${base}/${process.env.T_FILE ?? name}.h`,
        contractName: name,
        slot,
        corePath: process.env.QINIT_CORE!,
        outDir: `/tmp/qinit-triage-probe/${name}/${backend}`,
        skipVerify: true,
    });
    // A clang build that wrote a wasm succeeded whatever the IDL says: `ok: !idlError` otherwise reports a
    // TypeScript parse refusal as clang's. The probe drives entries by number and never reads the IDL.
    const wroteWasm = Boolean(built.wasmPath) && existsSync(built.wasmPath!);
    const producedArtifact = backend === "clang" ? wroteWasm : built.ok && wroteWasm;
    if (!producedArtifact) {
        const firstError = (built.stderr ?? "")
            .split("\n")
            .map((line) => line.trim())
            .find((line) => /error/i.test(line));
        results[backend] = `REJECTED: ${firstError ?? "build failed"}`;
        continue;
    }
    try {
        const simulator = new QubicSimulator();
        const contract = simulator.deploy(slot, new Uint8Array(readFileSync(built.wasmPath!)));
        let trapped = false;
        for (const step of script.steps ?? []) {
            if (step.kind !== "procedure") continue;
            try {
                simulator.procedure(slot, step.entry, Uint8Array.from(Buffer.from(step.in ?? "", "hex")));
            } catch {
                trapped = true;
                break;
            }
        }
        results[backend] = trapped ? "TRAP" : toHex(contract.state());
    } catch {
        results[backend] = "DEPLOY-FAILED";
    }
}

/** A hex state as little-endian u64 words; anything that is not hex passes through unchanged. */
const asWords = (state: string): string =>
    /^[0-9a-f]+$/.test(state)
        ? (state.match(/.{16}/g) ?? []).map((word) => BigInt(`0x${(word.match(/../g) ?? []).reverse().join("")}`)).join(" ")
        : state;

console.log(name);
console.log("  clang     ", asWords(results.clang!));
console.log("  typescript", asWords(results.typescript!));
// Two refusals are not agreement on a value, but they are agreement on rejecting the contract — which
// for a finding like F205 or F212 is the outcome that matches clang.
console.log(`  ${results.clang === results.typescript ? ">>> AGREE" : ">>> DIVERGES"}`);
