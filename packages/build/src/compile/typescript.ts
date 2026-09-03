import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CheatMode, compileContractWithTypeScript, DiagnosticSeverity, loadQpiHeader, type ContractIdl } from "@qinit/compiler";
import { analyzeContract, type SourceAnalysisResult } from "@qinit/compiler/analyzer";
import { k12Hex } from "@qinit/core";
import type { ContractBuildResult } from "./types";
import { verifyForBuild, verifyRejection } from "./verify";
import { KNOWN_LOG_HEADER_VIOLATIONS } from "../contracts/system-contracts";
import { resolveContractSource } from "./source";

export interface TypeScriptCalleeBuildOptions {
    header: string;
    index: number;
    stateType?: string;
}

// Every field here is spelled as in ClangBuildOptions, so one options object drives either backend.
// Clang-only knobs (wasmClang, extraCompileFlags) have no meaning for this backend.
export interface TypeScriptBuildOptions {
    contractPath?: string; // supply this or `source`
    source?: string;
    contractName: string;
    stateType?: string;
    slot: number;
    corePath: string;
    outDir: string;
    dynCallees?: Record<string, TypeScriptCalleeBuildOptions>;
    strict?: boolean; // default true; false keeps fidelity-only findings from failing the build
    cheats?: CheatMode; // development cheatcodes; OFF is what Core sees
    skipVerify?: boolean; // skip the protocol verifier; the same gate clang runs
}

interface DynamicCalleeSource {
    name: string;
    stateType: string;
    slot: number;
    source: string;
}

function analyzeCallee(callee: DynamicCalleeSource, allCallees: DynamicCalleeSource[], qpiHeader: string): SourceAnalysisResult {
    return analyzeContract({
        source: callee.source,
        contractName: callee.stateType,
        slot: callee.slot,
        qpiHeader,
        calleeSources: allCallees
            .filter((item) => item.name !== callee.name)
            .map(({ stateType, slot, source }) => ({
                name: stateType,
                slot,
                source,
            })),
    });
}

function requireCalleeIdl(callee: DynamicCalleeSource, result: SourceAnalysisResult): ContractIdl | string {
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR);
    if (errors.length > 0) {
        return `callee ${callee.name}: ${errors.map((diagnostic) => diagnostic.message).join("; ")}`;
    }
    if (!result.idl) {
        return `callee ${callee.name}: compiler did not produce IDL`;
    }
    return {
        ...result.idl,
        name: callee.stateType,
        slot: callee.slot,
    };
}

export async function buildContractWithTypeScript(o: TypeScriptBuildOptions): Promise<ContractBuildResult> {
    const qpiHeader = loadQpiHeader(o.corePath);
    if (!qpiHeader) {
        return {
            ok: false,
            stderr: "cannot load qpi.h — set QINIT_CORE or pass --core-dir <core-lite checkout>",
        };
    }
    let source: string;
    let contractPath: string;
    try {
        const resolved = resolveContractSource(o);
        source = resolved.source;
        contractPath = resolved.contractPath;
    } catch (error: any) {
        return { ok: false, stderr: String(error?.message ?? error) };
    }

    const dynamicCallees = Object.entries(o.dynCallees ?? {}).map(([name, { header, index, stateType }]) => ({
        name,
        stateType: stateType ?? name,
        slot: index,
        source: readFileSync(header, "utf8"),
    }));

    const callees: ContractIdl[] = [];
    for (const callee of dynamicCallees) {
        const analyzed = analyzeCallee(callee, dynamicCallees, qpiHeader);
        const idl = requireCalleeIdl(callee, analyzed);
        if (typeof idl === "string") {
            return { ok: false, stderr: idl };
        }
        callees.push(idl);
    }

    const calleeSources = dynamicCallees.map(({ stateType, slot, source: calleeSource }) => ({
        name: stateType,
        slot,
        source: calleeSource,
    }));
    const contractStateType = o.stateType ?? o.contractName;

    // The verifier rejects a scope prefix it does not know, so every callee this contract names — planned
    // or a system contract found in the source — is allowed, the same list the clang build passes.
    const calls = analyzeContract({ source, contractName: contractStateType, slot: o.slot, qpiHeader }).calls;
    const calleeNames = [...new Set([...dynamicCallees.map((callee) => callee.name), ...calls.map((call) => call.callee)])];
    const verify = await verifyForBuild({ contractPath, stateType: contractStateType, calleeNames, skipVerify: o.skipVerify });
    const rejected = verifyRejection(verify);
    if (rejected) {
        return rejected;
    }

    const result = await compileContractWithTypeScript({
        source,
        contractName: contractStateType,
        slot: o.slot,
        qpiHeader,
        callees: callees.length ? callees : undefined,
        calleeSources: calleeSources.length ? calleeSources : undefined,
        strict: o.strict ?? !KNOWN_LOG_HEADER_VIOLATIONS.has(basename(contractPath)),
        cheats: o.cheats,
    });
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR);
    if (errors.length) {
        return {
            ok: false,
            stderr: errors.map((diagnostic) => `error: ${diagnostic.message}`).join("\n"),
        };
    }
    if (!result.idl) {
        return { ok: false, stderr: "compiler did not produce IDL" };
    }

    const warnings = result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.WARNING);
    const idl =
        contractStateType === o.contractName
            ? result.idl
            : {
                  ...result.idl,
                  name: o.contractName,
              };

    mkdirSync(o.outDir, { recursive: true });
    const wasmPath = join(o.outDir, `${o.contractName}.wasm`);
    writeFileSync(wasmPath, Buffer.from(result.wasm));
    return {
        ok: true,
        wasmPath,
        wasmSizeBytes: statSync(wasmPath).size,
        wasmK12DigestHex: await k12Hex(result.wasm),
        idl,
        verify,
        stderr: warnings.length ? warnings.map((diagnostic) => `warning: ${diagnostic.message}`).join("\n") : undefined,
    };
}
