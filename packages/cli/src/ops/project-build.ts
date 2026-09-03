import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { analyzeCheatcodes, stripCheatcodes } from "@qinit/compiler/analyzer";
import { CheatMode } from "@qinit/compiler";
import {
    buildContractWithTypeScript,
    buildContractWithClang,
    resolveProjectDependencies,
    type ContractBuildResult,
    type ProjectCalleeInput,
    type ProjectContractNode,
    type TypeScriptCalleeBuildOptions,
} from "@qinit/build";
import { k12Hex, type DynamicContractRegistry } from "@qinit/core";
import type { DynCallees } from "@qinit/build/contracts/intercontract";
import type { CompilerBackend } from "../config";
import { planProjectSlots, type PlannedProjectSlotNode } from "@qinit/build/contracts/project-slots";

export type PlannedProjectContract = ProjectContractNode & PlannedProjectSlotNode;

export interface BuiltProjectContract {
    contract: PlannedProjectContract;
    result: ContractBuildResult;
    wasm: Uint8Array;
    hash: string;
}

export interface ProjectBuildOutcome {
    ok: boolean;
    contracts: BuiltProjectContract[];
    failed?: PlannedProjectContract;
    result?: ContractBuildResult;
}

export function resolveProjectPlan(options: {
    projectRoot: string;
    core: string;
    contractPath: string;
    name: string;
    slot?: number;
    explicitCallees?: Readonly<Record<string, ProjectCalleeInput>>;
    slotLayout: { slotBase: number; slotCount: number };
    registry?: DynamicContractRegistry;
}): PlannedProjectContract[] {
    const dependencies = resolveProjectDependencies({
        projectRoot: options.projectRoot,
        corePath: options.core,
        contractName: options.name,
        contractPath: options.contractPath,
        contractIndex: options.slot,
        explicitCallees: options.explicitCallees,
    });

    return planProjectSlots(dependencies, options.slotLayout, options.registry);
}

function transitiveDependencies(contract: PlannedProjectContract, byStateType: ReadonlyMap<string, PlannedProjectContract>): PlannedProjectContract[] {
    const visited = new Set<string>();
    const ordered: PlannedProjectContract[] = [];

    const visit = (stateType: string): void => {
        if (visited.has(stateType)) {
            return;
        }
        visited.add(stateType);

        const dependency = byStateType.get(stateType);
        if (!dependency) {
            throw new Error(`${contract.stateType} references unresolved project contract '${stateType}'`);
        }
        for (const nested of dependency.dependencies) {
            visit(nested);
        }
        ordered.push(dependency);
    };

    for (const dependency of contract.dependencies) {
        visit(dependency);
    }
    return ordered;
}

type SourceOf = (contract: PlannedProjectContract) => string;

function clangCallees(dependencies: readonly PlannedProjectContract[], sourceOf: SourceOf): DynCallees {
    return Object.fromEntries(
        dependencies
            .filter((dependency) => dependency.kind === "custom")
            .map((dependency) => [
                dependency.stateType,
                {
                    header: sourceOf(dependency),
                    index: dependency.index,
                },
            ]),
    );
}

function typescriptCallees(dependencies: readonly PlannedProjectContract[], sourceOf: SourceOf): Record<string, TypeScriptCalleeBuildOptions> {
    return Object.fromEntries(
        dependencies.map((dependency) => [
            dependency.stateType,
            {
                header: sourceOf(dependency),
                index: dependency.index,
                stateType: dependency.stateType,
            },
        ]),
    );
}

// clang names the file it stopped in, which is a callee's as often as the contract being built.
export function blamedContract(stderr: string, plan: readonly PlannedProjectContract[]): PlannedProjectContract | undefined {
    const file = /^(.*?):\d+:\d+: (?:fatal )?error:/m.exec(stderr)?.[1];

    return file ? plan.find((contract) => basename(contract.sourcePath) === basename(file)) : undefined;
}

/**
 * A production build compiles what Core will receive: the cheatcodes stripped, and no shim to define
 * them. The stripped copy goes to a scratch file — a build never rewrites the contract being worked on.
 */
function productionSource(sourcePath: string): string {
    const raw = readFileSync(sourcePath, "utf8");
    const violations = analyzeCheatcodes(raw);

    if (violations.length) {
        throw new Error(`${basename(sourcePath)}:\n${violations.map((item) => `  line ${item.span.line}: ${item.message}`).join("\n")}`);
    }

    const target = join(mkdtempSync(join(tmpdir(), "qinit-production-")), basename(sourcePath));
    writeFileSync(target, stripCheatcodes(raw));

    return target;
}

export async function buildProjectContracts(options: {
    plan: readonly PlannedProjectContract[];
    core: string;
    compiler: CompilerBackend;
    outDir: string;
    skipVerify?: boolean;
    // A production build defines the cheatcodes away, which is what Core compiles.
    cheats?: CheatMode;
    onContract?: (contract: PlannedProjectContract) => void;
}): Promise<ProjectBuildOutcome> {
    const byStateType = new Map(options.plan.map((contract) => [contract.stateType, contract]));
    const built: BuiltProjectContract[] = [];
    // A production build strips each contract once; a dependent then includes the very file its callee was built from.
    const stripped = new Map<string, string>();
    const sourceOf: SourceOf = (contract) => {
        if (options.cheats !== CheatMode.OFF || contract.kind !== "custom") {
            return contract.sourcePath;
        }
        let path = stripped.get(contract.sourcePath);
        if (!path) {
            path = productionSource(contract.sourcePath);
            stripped.set(contract.sourcePath, path);
        }
        return path;
    };

    for (const contract of options.plan) {
        if (contract.kind === "system") {
            continue;
        }

        options.onContract?.(contract);
        const dependencies = transitiveDependencies(contract, byStateType);
        const sourcePath = sourceOf(contract);
        const result =
            options.compiler === "typescript"
                ? await buildContractWithTypeScript({
                      contractPath: sourcePath,
                      contractName: contract.name,
                      stateType: contract.stateType,
                      slot: contract.index,
                      corePath: options.core,
                      outDir: options.outDir,
                      dynCallees: typescriptCallees(dependencies, sourceOf),
                      cheats: options.cheats,
                  })
                : await buildContractWithClang({
                      contractPath: sourcePath,
                      contractName: contract.name,
                      stateType: contract.stateType,
                      slot: contract.index,
                      corePath: options.core,
                      outDir: options.outDir,
                      dynCallees: clangCallees(dependencies, sourceOf),
                      cheats: options.cheats,
                      skipVerify: options.skipVerify,
                  });

        if (!result.ok || !result.wasmPath) {
            return {
                ok: false,
                contracts: built,
                failed: blamedContract(result.stderr ?? "", options.plan) ?? contract,
                result,
            };
        }

        const wasm = new Uint8Array(readFileSync(resolve(result.wasmPath)));
        const hash = result.wasmK12DigestHex ?? (await k12Hex(wasm));
        built.push({ contract, result, wasm, hash });
    }

    return { ok: true, contracts: built };
}
