import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { analyzeCheatcodes, stripCheatcodes } from "@qinit/compiler/analyzer";
import { CheatMode } from "@qinit/compiler";
import {
    buildContractWithTypeScript,
    buildContractWithClang,
    type ContractBuildResult,
    type ResolvedContract,
    type TypeScriptCalleeBuildOptions,
} from "@qinit/build";
import { k12Hex } from "@qinit/core";
import type { DynCallees } from "@qinit/build/contracts/intercontract";
import type { CompilerBackend } from "../config";
import type { SlotAssignment } from "@qinit/build/contracts/project-slots";

export type SlottedContract = ResolvedContract & SlotAssignment;

export interface BuiltContract {
    contract: SlottedContract;
    result: ContractBuildResult;
    wasm: Uint8Array;
    hash: string;
}

export interface ProjectBuildOutcome {
    ok: boolean;
    contracts: BuiltContract[];
    failed?: SlottedContract;
    result?: ContractBuildResult;
}

function calleeClosure(contract: SlottedContract, byStateType: ReadonlyMap<string, SlottedContract>): SlottedContract[] {
    const visited = new Set<string>();
    const ordered: SlottedContract[] = [];

    const visit = (stateType: string): void => {
        if (visited.has(stateType)) {
            return;
        }
        visited.add(stateType);

        const callee = byStateType.get(stateType);
        if (!callee) {
            throw new Error(`${contract.stateType} references unresolved project contract '${stateType}'`);
        }
        for (const nested of callee.callees) {
            visit(nested);
        }
        ordered.push(callee);
    };

    for (const callee of contract.callees) {
        visit(callee);
    }
    return ordered;
}

type PathFor = (contract: SlottedContract) => string;

function clangCallees(callees: readonly SlottedContract[], pathFor: PathFor): DynCallees {
    return Object.fromEntries(
        callees
            .filter((callee) => callee.kind === "custom")
            .map((callee) => [
                callee.stateType,
                {
                    header: pathFor(callee),
                    slot: callee.slot,
                },
            ]),
    );
}

function typescriptCallees(callees: readonly SlottedContract[], pathFor: PathFor): Record<string, TypeScriptCalleeBuildOptions> {
    return Object.fromEntries(
        callees.map((callee) => [
            callee.stateType,
            {
                header: pathFor(callee),
                slot: callee.slot,
                stateType: callee.stateType,
            },
        ]),
    );
}

// clang names the file it stopped in, which is a callee's as often as the contract being built.
export function blamedContract(stderr: string, plan: readonly SlottedContract[]): SlottedContract | undefined {
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

export async function compileContracts(options: {
    plan: readonly SlottedContract[];
    core: string;
    compiler: CompilerBackend;
    outDir: string;
    skipVerify?: boolean;
    // A production build defines the cheatcodes away, which is what Core compiles.
    cheats?: CheatMode;
    onContract?: (contract: SlottedContract) => void;
}): Promise<ProjectBuildOutcome> {
    const byStateType = new Map(options.plan.map((contract) => [contract.stateType, contract]));
    const built: BuiltContract[] = [];
    // A production build strips each contract once; a dependent then includes the very file its callee was built from.
    const stripped = new Map<string, string>();
    const pathFor: PathFor = (contract) => {
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
        const callees = calleeClosure(contract, byStateType);
        const sourcePath = pathFor(contract);
        const result =
            options.compiler === "typescript"
                ? await buildContractWithTypeScript({
                      contractPath: sourcePath,
                      contractName: contract.name,
                      stateType: contract.stateType,
                      slot: contract.slot,
                      corePath: options.core,
                      outDir: options.outDir,
                      dynCallees: typescriptCallees(callees, pathFor),
                      cheats: options.cheats,
                      skipVerify: options.skipVerify,
                  })
                : await buildContractWithClang({
                      contractPath: sourcePath,
                      contractName: contract.name,
                      stateType: contract.stateType,
                      slot: contract.slot,
                      corePath: options.core,
                      outDir: options.outDir,
                      dynCallees: clangCallees(callees, pathFor),
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
