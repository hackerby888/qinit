/// <reference path="./text-assets.d.ts" />
// qinit build: contract .h -> wasm module (run by the node's WAMR engine) + K12 hash + IDL.
import { statSync, readFileSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { compileWasmContract, type ContractBuildOptions } from "./recipe";
// Embedded as text by `bun build --compile` (import.meta.dir asset files aren't bundled into the binary).
import TEST_UTIL_H from "./assets/test_util.h" with { type: "text" };
import { extractIdl, type ContractIdl } from "./idl";
import { buildCalleePrelude } from "./intercontract";
import type { DynCallees } from "./intercontract";
import { verifyContract, type VerifyResult } from "./verify";
import {
    generateWasmContractTestingHeaderForCore,
    systemContractClosure,
    systemContracts,
} from "./system-contracts";
import { buildContractWithTypeScript } from "./typescript";
import { k12Hex } from "@qinit/core";
import { analyzeContract } from "@qinit/compiler/analyzer";
import { loadQpiHeader } from "@qinit/compiler";

export type { ContractBuildOptions } from "./recipe";
export { generateWasmWrapperSource } from "./recipe";
export {
    buildContractWithTypeScript,
    type TypeScriptCalleeBuildOptions,
    type TypeScriptContractBuildResult,
} from "./typescript";
export { buildCalleePrelude, parseRegisters, scanCallees, parseContractDef } from "./intercontract";
export type { DynCallees, CalleeDef } from "./intercontract";
export { resolveProjectDependencies } from "./project-dependencies";
export type {
    ProjectCalleeInput,
    ProjectContractNode,
    ResolveProjectDependenciesOptions,
} from "./project-dependencies";
export { planProjectSlots } from "./project-slots";
export type { PlannedProjectSlotNode, ProjectSlotLayout, ProjectSlotNode } from "./project-slots";
export { extractIdl } from "./idl";
export type { ContractIdl, IdlEntry, Field, LogStruct, EnumDef } from "./idl";
export {
    generateWasmContractTestingHeaderForCore,
    systemContractClosure,
    systemContractDescriptions,
    systemContracts,
    systemNames,
    type SystemContract,
    type SystemContractDescription,
} from "./system-contracts";
export { generateClient } from "./gen-client";
export { testRuntimeSource, sampleTest } from "./gen-test";
export { genStdGtest } from "./gen-std-gtest";
export { buildSnapshot } from "./snapshot";
export type { SnapshotOptions, SnapshotResult } from "./snapshot";
export { verifyContract, resolveVerifyTool } from "./verify";
export type { VerifyResult } from "./verify";

export interface ContractBuildResult {
    ok: boolean;
    wasmPath?: string;
    wasmSizeBytes?: number;
    wasmK12DigestHex?: string;
    idl?: ContractIdl;
    verify?: VerifyResult;
    debugWasmPath?: string; // -g DWARF sidecar (deployed wasm is stripped)
    lineMapPath?: string; // {fileOffset -> file:line:func} map for source-mapped trap backtraces
    stderr?: string;
    idlError?: string; // set (instead of silently dropping idl) when extractIdl throws on a compiled contract
}

export type SystemContractCompiler = "clang" | "typescript";

export async function buildContractWithWasiClang(
    o: ContractBuildOptions,
): Promise<ContractBuildResult> {
    const source = readFileSync(o.contractPath, "utf8");
    let qpiHeader: string | undefined;
    let qpiHeaderError: string | undefined;
    try {
        qpiHeader = o.corePath ? loadQpiHeader(o.corePath) : undefined;
    } catch (error: any) {
        qpiHeader = undefined;
        qpiHeaderError = String(error?.message ?? error);
    }

    // LinkedList has no safe public wire representation; reject it even when verification is skipped.
    const analysis = analyzeContract({
        source,
        contractName: o.stateType ?? o.name,
        slot: o.slot,
        qpiHeader,
    });
    const linkedListDiagnostics = analysis.diagnostics.filter(
        (diagnostic) =>
            diagnostic.message.startsWith("LinkedList is forbidden in registered entry") ||
            (diagnostic.code === "qpi/public-complex-type" &&
                diagnostic.message.includes("`LinkedList` is forbidden in the public interface")),
    );
    if (linkedListDiagnostics.length) {
        return {
            ok: false,
            stderr: [
                "Qubic protocol violations:",
                ...linkedListDiagnostics.map((diagnostic) => `  • ${diagnostic.message}`),
            ].join("\n"),
        };
    }
    const calls = analysis.calls;
    const calleeNames = [
        ...new Set([...Object.keys(o.dynCallees ?? {}), ...calls.map((call) => call.callee)]),
    ];
    const verify = o.skipVerify
        ? { available: false, ok: true, oracle: false, errors: [] as string[] }
        : await verifyContract(o.contractPath, o.name, { allowedPrefixes: calleeNames });
    if (verify.available && !verify.ok) {
        return {
            ok: false,
            verify,
            stderr: ["Qubic protocol violations:", ...verify.errors.map((e) => "  • " + e)].join(
                "\n",
            ),
        };
    }

    // Inter-contract: scan the contract for CALL_OTHER_CONTRACT_* and auto-derive the callee prelude
    // (callee type headers at their indices + per-fn inputType constants) from contract_def.h.
    let calleePrelude = o.calleePrelude;
    if (calleePrelude === undefined) {
        try {
            calleePrelude = buildCalleePrelude(
                o.corePath,
                source,
                o.dynCallees ?? {},
                o.stateType ?? o.name,
            );
        } catch (e: any) {
            return {
                ok: false,
                stderr: "inter-contract resolve failed: " + String(e?.message ?? e),
            };
        }
    }
    // Compile the contract to a wasm module (run by the node's WAMR engine). One platform-independent
    // artifact, deployed via the chunked-upload path (the node magic-sniffs '\0asm' -> wasm engine).
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
        idl = extractIdl(source, o.name, {
            slot: o.slot,
            qpiHeader,
            stateType: o.stateType,
        });
    } catch (e: any) {
        idlError = String(e?.message ?? e);
    }
    return {
        ok: true,
        wasmPath: compiled.wasm,
        wasmSizeBytes,
        wasmK12DigestHex,
        idl,
        idlError,
        verify,
        debugWasmPath: compiled.debugWasmPath,
        lineMapPath: compiled.lineMapPath,
    };
}

// Compile a corpus file (core-lite/test/contract_X.cpp) into a runner wasm by redirecting its
// `#include "contract_testing.h"` to the qinit-shipped `wasm_contract_testing.h` header.
export async function buildCorpusRunner(o: {
    corpusPath: string;
    contractPath: string;
    name: string;
    stateType: string;
    slot: number;
    corePath: string;
    outDir: string;
    arenaSizeBytes?: number;
    dynCallees?: DynCallees;
    contractDescriptions?: readonly { index: number; name: string }[];
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
    const extraCompileFlags = ["-O2", "-Wno-error=return-mismatch", "-DQINIT_CORPUS_RUNNER"];

    // When the corpus pulls real <iostream>/<ostream> itself, suppress the harness's std::cout stubs so
    // they don't collide with the real stream objects (an ambiguous-reference error otherwise).
    if (/^#include\s*<(iostream|ostream)>/m.test(raw)) {
        extraCompileFlags.push("-DQINIT_HAVE_IOSTREAM");
    }

    // Include sibling types referenced only by the corpus, not just callees used by the contract.
    let calleePrelude: string | undefined;
    try {
        const contractSrc = readFileSync(o.contractPath, "utf8");
        calleePrelude = buildCalleePrelude(
            o.corePath,
            `${contractSrc}\n${testSource}`,
            o.dynCallees ?? {},
            o.stateType,
        );
    } catch {
        // Fall back to buildContractWithWasiClang's contract-only derivation.
    }

    return buildContractWithWasiClang({
        contractPath: o.contractPath,
        name: o.name,
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
        const result = await buildContractWithWasiClang({
            contractPath: join(corePath, "src", "contracts", contract.file),
            name: contract.name,
            stateType: contract.stateType,
            slot: contract.index,
            corePath,
            outDir,
            skipVerify: true,
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
                    index: dependency.index,
                    stateType: dependency.stateType,
                },
            ]),
    );
    const result = await buildContractWithTypeScript({
        contractPath: join(corePath, "src", "contracts", contract.file),
        name: contract.name,
        stateType: contract.stateType,
        slot: contract.index,
        core: corePath,
        outDir,
        dynCallees: dependencies,
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
