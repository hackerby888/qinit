/// <reference path="../text-assets.d.ts" />
// qinit build: contract .h -> wasm module (run by the node's WAMR engine) + K12 hash + IDL.
import { statSync, readFileSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { compileWasmContract, type ClangBuildOptions } from "./clang";
import { resolveContractSource } from "./source";
// Embedded as text by `bun build --compile` (import.meta.dir asset files aren't bundled into the binary).
import TEST_UTIL_H from "../assets/test_util.h" with { type: "text" };
import { extractIdl, type CalleeSource, type ContractIdl } from "./idl";
import { verifyForBuild, verifyRejection } from "./verify";
import type { ContractBuildResult, SystemContractCompiler } from "./types";
import { buildContractWithTypeScript } from "./typescript";
import { buildCalleePrelude } from "../contracts/intercontract";
import type { DynCallees } from "../contracts/intercontract";
import { generateWasmContractTestingHeaderForCore, KNOWN_LOG_HEADER_VIOLATIONS, systemContractClosure, systemContracts } from "../contracts/system-contracts";
import { k12Hex } from "@qinit/core";
import { analyzeContract } from "@qinit/compiler/analyzer";
import { loadQpiHeader } from "@qinit/compiler";
import { buildGateRejection, buildGateViolations, buildGateWarnings, type ContractKind } from "./build-rules";

export async function buildContractWithClang(input: ClangBuildOptions): Promise<ContractBuildResult> {
    let source: string;
    let o: ClangBuildOptions & { contractPath: string };
    try {
        const resolved = resolveContractSource(input);
        source = resolved.source;
        o = { ...input, contractPath: resolved.contractPath };
    } catch (error: any) {
        return { ok: false, stderr: String(error?.message ?? error) };
    }
    let qpiHeader: string | undefined;
    let qpiHeaderError: string | undefined;
    try {
        qpiHeader = o.corePath ? loadQpiHeader(o.corePath) : undefined;
    } catch (error: any) {
        qpiHeader = undefined;
        qpiHeaderError = String(error?.message ?? error);
    }

    // The callees' declarations: the gate names a callee type misused in a public interface, and the IDL gives a state field typed by a callee its real layout.
    const calleeSources: CalleeSource[] = Object.entries(o.dynCallees ?? {}).map(([name, callee]) => ({
        name,
        source: readFileSync(callee.header, "utf8"),
        slot: callee.slot,
    }));
    // Collection/HashMap/HashSet/LinkedList have no safe public wire representation; reject them even when verification is skipped.
    const analysis = analyzeContract({
        source,
        contractName: o.stateType ?? o.contractName,
        slot: o.slot,
        qpiHeader,
        calleeSources,
    });
    // The same gate the TypeScript backend runs (build-rules.ts), so both compilers reject the same contracts.
    const gateContext = {
        contractKind: o.contractKind,
        buildRules: o.buildRules,
        rejectsLogHeader: o.strict ?? !KNOWN_LOG_HEADER_VIOLATIONS.has(basename(o.contractPath)),
    };
    const gate = buildGateRejection(buildGateViolations(analysis.diagnostics, gateContext));
    if (gate) {
        return gate;
    }
    const warnings = buildGateWarnings(analysis.diagnostics, gateContext);
    const calls = analysis.calls;
    const calleeNames = [...new Set([...Object.keys(o.dynCallees ?? {}), ...calls.map((call) => call.callee)])];
    const verify = await verifyForBuild({ contractPath: o.contractPath, stateType: o.stateType ?? o.contractName, calleeNames, skipVerify: o.skipVerify });
    const rejected = verifyRejection(verify);
    if (rejected) {
        return rejected;
    }

    // Inter-contract: scan for CALL_OTHER_CONTRACT_* and derive the callee prelude (type headers at their indices, inputType consts) from contract_def.h.
    let calleePrelude = o.calleePrelude;
    if (calleePrelude === undefined) {
        try {
            calleePrelude = buildCalleePrelude(o.corePath, source, o.dynCallees ?? {}, o.stateType ?? o.contractName);
        } catch (e: any) {
            return {
                ok: false,
                stderr: "inter-contract resolve failed: " + String(e?.message ?? e),
            };
        }
    }
    // Compile the contract to a wasm module for the node's WAMR engine: one platform-independent artifact, deployed by chunked upload and sniffed as wasm.
    const compiled = await compileWasmContract({ ...o, calleePrelude });
    if (!compiled.ok) {
        return {
            ok: false,
            wasmPath: compiled.wasm,
            stderr: compiled.stderr,
        };
    }
    const wasmSizeBytes = statSync(compiled.wasm).size;
    let wasmK12DigestHex: string | undefined;
    try {
        wasmK12DigestHex = await k12Hex(new Uint8Array(readFileSync(compiled.wasm)));
    } catch {
        wasmK12DigestHex = undefined;
    }
    let idl: ContractIdl | undefined;
    let idlError: string | undefined;
    try {
        if (qpiHeaderError) {
            throw new Error(qpiHeaderError);
        }
        idl = extractIdl(source, o.contractName, {
            slot: o.slot,
            qpiHeader,
            stateType: o.stateType,
            calleeSources,
        });
    } catch (e: any) {
        idlError = String(e?.message ?? e);
    }
    return {
        // a build that produced no IDL is not ok, on either backend.
        ok: !idlError,
        wasmPath: compiled.wasm,
        wasmSizeBytes,
        wasmK12DigestHex,
        idl,
        idlError,
        stderr: idlError ? `compiler IDL analysis failed: ${idlError}` : undefined,
        verify,
        warnings: warnings.length ? warnings : undefined,
        debugWasmPath: compiled.debugWasmPath,
        lineMapPath: compiled.lineMapPath,
    };
}

// Compile a corpus file (core-lite/test/contract_X.cpp) into a runner wasm by redirecting its `contract_testing.h` include to the qinit-shipped header.
export async function buildCorpusRunner(o: {
    corpusPath: string;
    contractPath: string;
    contractName: string;
    stateType: string;
    slot: number;
    corePath: string;
    outDir: string;
    arenaSizeBytes?: number;
    dynCallees?: DynCallees;
    contractDescriptions?: readonly { index: number; name: string }[];
    contractKind?: ContractKind;
    buildRules?: boolean;
}): Promise<ContractBuildResult> {
    const raw = (await readFile(o.corpusPath, "utf8")).replace(/^﻿/, "");

    const testSource = raw
        .replace(/^#include\s+"contract_testing\.h"\s*$/m, '#include "wasm_contract_testing.h"')
        .replace(/^#include\s+"oracle_testing\.h".*$/m, "");

    await mkdir(o.outDir, { recursive: true });

    await writeFile(
        join(o.outDir, "wasm_contract_testing.h"),
        generateWasmContractTestingHeaderForCore({
            ...o,
            additionalContracts: o.contractDescriptions,
        }),
    );
    // Some corpora also `#include "test_util.h"` (asset-name helpers etc.); provide the wasm-mode stub.
    await writeFile(join(o.outDir, "test_util.h"), TEST_UTIL_H);

    // Corpus runners do not need deployed-contract debugging; the trailing -O2 overrides the recipe's -O0.
    // Corpus fixtures hold whole contract states on the C stack, past wasm-ld's 64 KB default: with the stack above the data the
    // overflow silently overwrote it, and once wasm-ld placed the stack first (LLVM 22) it trapped. Give the runner a real stack.
    const extraCompileFlags = ["-O2", "-Wno-error=return-mismatch", "-DQINIT_CORPUS_RUNNER", "-Wl,-z,stack-size=8388608"];

    // When the corpus pulls real <iostream> itself, suppress the harness's std::cout stubs so they do not collide with the real stream objects.
    if (/^#include\s*<(iostream|ostream)>/m.test(raw)) {
        extraCompileFlags.push("-DQINIT_HAVE_IOSTREAM");
    }

    // Include sibling types referenced only by the corpus, not just callees used by the contract.
    let calleePrelude: string | undefined;
    try {
        const contractSrc = readFileSync(o.contractPath, "utf8");
        calleePrelude = buildCalleePrelude(o.corePath, `${contractSrc}\n${testSource}`, o.dynCallees ?? {}, o.stateType);
    } catch {
        // Fall back to buildContractWithClang's contract-only derivation.
    }

    return buildContractWithClang({
        contractPath: o.contractPath,
        contractName: o.contractName,
        stateType: o.stateType,
        slot: o.slot,
        corePath: o.corePath,
        outDir: o.outDir,
        arenaSizeBytes: o.arenaSizeBytes ?? 8 * 1024 * 1024,
        skipVerify: true,
        testSource,
        testPath: basename(o.corpusPath),
        extraCompileFlags,
        calleePrelude,
        dynCallees: o.dynCallees,
        contractKind: o.contractKind,
        buildRules: o.buildRules,
    });
}

// System contracts use sysproc macros unsupported by the verifier, so the build skips verification.
export async function buildSystemContract(
    name: string,
    corePath: string,
    opts: {
        compiler?: SystemContractCompiler;
        outDir?: string;
        wasmClang?: string;
        wasmSysroot?: string;
    } = {},
): Promise<ContractBuildResult & { index?: number }> {
    const catalog = systemContracts(corePath);
    const contract = catalog.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (!contract) {
        return {
            ok: false,
            stderr: `unknown system contract '${name}' — have: ${catalog.map((x) => x.name).join(", ")}`,
        };
    }

    const compiler = opts.compiler ?? "clang";
    const outDir = opts.outDir ?? join(tmpdir(), "qinit-system");
    if (compiler === "clang") {
        const result = await buildContractWithClang({
            contractPath: join(corePath, "src", "contracts", contract.file),
            contractName: contract.name,
            stateType: contract.stateType,
            slot: contract.index,
            corePath,
            outDir,
            skipVerify: true,
            contractKind: "system",
            wasmClang: opts.wasmClang,
            wasmSysroot: opts.wasmSysroot,
        });
        return { ...result, index: contract.index };
    }

    const dependencies = Object.fromEntries(
        systemContractClosure(corePath, contract.name)
            .filter((dependency) => dependency.index !== contract.index)
            .map((dependency) => [
                dependency.stateType,
                {
                    header: join(corePath, "src", "contracts", dependency.file),
                    slot: dependency.index,
                    stateType: dependency.stateType,
                },
            ]),
    );
    const result = await buildContractWithTypeScript({
        contractPath: join(corePath, "src", "contracts", contract.file),
        contractName: contract.name,
        stateType: contract.stateType,
        slot: contract.index,
        corePath,
        outDir,
        dynCallees: dependencies,
        skipVerify: true,
        contractKind: "system",
    });
    if (!result.ok) {
        return {
            ...result,
            index: contract.index,
            stderr: `compile ${contract.name} failed: ${result.stderr ?? "unknown error"}`,
        };
    }
    return { ...result, index: contract.index };
}
