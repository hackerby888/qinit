// Run one triage directory through both backends and print the two final states side by side.
//
// The differential runner works from the generated corpus and its script index. This works from a bare
// triage folder — a `.h`, a `script.json`, nothing else — which is what a reduced repro is. Used for
// every finding in `docs/findings/fixes/`: change the compiler, re-run the repro, read the two rows.
//
//   QINIT_CORE=/path/to/core-lite \
//   T_BASE=$PWD/corpus/solidity-port/triage/F203-k12-expression T_NAME=K12Struct \
//   bun run scripts/solidity-port/triage-probe.ts
//
//   T_BASE   absolute path to the triage directory. MUST be absolute: the clang wrapper compiles from
//            its own output directory, so a relative path resolves against the wrong cwd and comes back
//            as `fatal error: '...' file not found` — which reads exactly like clang rejecting the
//            contract, and cost a wrong conclusion once.
//   T_NAME   the contract name, i.e. the struct that inherits ContractBase.
//   T_FILE   the header's basename when it differs from T_NAME (default: T_NAME). Passing the file name
//            as the contract name makes clang report a pile of undeclared-identifier errors, which also
//            reads like a rejection.
//
// State is printed as little-endian u64 words rather than hex: a wrong digest is unreadable as hex and
// obvious as a list of numbers, and the fields of a StateData line up one per column.
import { readFileSync } from "node:fs";
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
    // A clang build that produced a wasm succeeded, whatever the IDL says: buildContractWithClang re-runs
    // the TypeScript front end for metadata after the artifact is written and reports `ok: !idlError`, so
    // a contract the TS parser declines reads here as a CLANG rejection. That is the same misattribution
    // already fixed in compile.ts, and it made this probe report `clang REJECTED` for a contract clang
    // had in fact compiled. The probe deploys the wasm and drives entries by number; it never reads the IDL.
    const producedArtifact = backend === "clang" ? Boolean(built.wasmPath) : built.ok && Boolean(built.wasmPath);
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
