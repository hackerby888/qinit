import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileContract, DiagnosticSeverity, loadQpiHeader, type ContractIdl } from "@qinit/compiler";
import { analyzeContract, type SourceAnalysisResult } from "@qinit/compiler/analyzer";
import { k12Hex } from "@qinit/core";
import type { ContractBuildResult } from "./index";

export type TypeScriptContractBuildResult = ContractBuildResult;

export interface TypeScriptCalleeBuildOptions {
    header: string;
    index: number;
    stateType?: string;
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

export async function buildContractWithTypeScript(o: {
    contractPath: string;
    name: string;
    stateType?: string;
    slot: number;
    core: string;
    outDir: string;
    dynCallees?: Record<string, TypeScriptCalleeBuildOptions>;
}): Promise<TypeScriptContractBuildResult> {
    const qpiHeader = loadQpiHeader(o.core);
    if (!qpiHeader) {
        return {
            ok: false,
            stderr: "cannot load qpi.h — set QINIT_CORE or pass --core-dir <core-lite checkout>",
        };
    }
    const source = readFileSync(o.contractPath, "utf8");

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
    const contractStateType = o.stateType ?? o.name;
    const result = await compileContract({
        source,
        contractName: contractStateType,
        slot: o.slot,
        qpiHeader,
        callees: callees.length ? callees : undefined,
        calleeSources: calleeSources.length ? calleeSources : undefined,
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
        contractStateType === o.name
            ? result.idl
            : {
                  ...result.idl,
                  name: o.name,
              };

    mkdirSync(o.outDir, { recursive: true });
    const wasmPath = join(o.outDir, `${o.name}.wasm`);
    writeFileSync(wasmPath, Buffer.from(result.wasm));
    return {
        ok: true,
        wasmPath,
        wasmSizeBytes: statSync(wasmPath).size,
        wasmK12DigestHex: await k12Hex(result.wasm),
        idl,
        stderr: warnings.length ? warnings.map((diagnostic) => `warning: ${diagnostic.message}`).join("\n") : undefined,
    };
}
