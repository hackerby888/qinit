import { CheatMode } from "@qinit/compiler";
import { resolve } from "node:path";
import type { ProjectCalleeInput } from "@qinit/build";
import { LiteRpc, k12Hex, type DynamicContractRegistryEntry, type NodeBackendIdentity } from "@qinit/core";
import type { CompilerBackend } from "../config";
import { systemWasm } from "../contracts/system-wasm";
import { buildProjectContracts, resolveProjectPlan, type BuiltProjectContract, type PlannedProjectContract } from "./project-build";
import { deployContract, type DeployResult } from "./deploy";
import type { DeploymentEvent } from "./deploy/steps";
import { DEFAULT_IDL_PATH, saveContractIdl } from "../contracts/idl-file";

export interface ProjectDeploymentRecord {
    name: string;
    slot: number;
    kind: "system" | "custom" | "main";
    action: "skipped" | "deployed" | "updated";
    hash: string;
}

export interface ProjectDeployResult extends DeployResult {
    backend?: NodeBackendIdentity["backend"];
    deployments: ProjectDeploymentRecord[];
    failedContract?: string;
    remainingContracts?: string[];
}

function normalizedHash(value: string | undefined): string {
    return (value ?? "").toLowerCase();
}

function deployedAt(contracts: readonly DynamicContractRegistryEntry[], slot: number): DynamicContractRegistryEntry | undefined {
    return contracts.find((contract) => contract.index === slot && contract.armed);
}

function dependencyEvent(emit: (event: DeploymentEvent) => void, message: string): void {
    emit({ note: message });
}

async function saveBuiltMetadata(rpc: LiteRpc, built: BuiltProjectContract, idlPath: string): Promise<void> {
    await rpc.putContractSource(built.contract.index, built.contract.source);
    if (!built.result.idl) {
        return;
    }

    saveContractIdl(
        built.contract.index,
        {
            ...built.result.idl,
            slot: built.contract.index,
            codeHash: built.hash,
            debugWasm: built.result.debugWasmPath ? resolve(built.result.debugWasmPath) : undefined,
            linesJson: built.result.lineMapPath ? resolve(built.result.lineMapPath) : undefined,
        },
        idlPath,
    );
}

export async function deployProjectContracts(
    options: {
        projectRoot: string;
        contractPath: string;
        name: string;
        core: string;
        rpcBaseUrl: string;
        seed?: string;
        explicitCallees?: Readonly<Record<string, ProjectCalleeInput>>;
        slotOverride?: number;
        outDir?: string;
        skipVerify?: boolean;
        compiler: CompilerBackend;
        // Deploying is not submitting to Core, so cheatcodes stay on unless the caller says otherwise.
        cheats?: CheatMode;
        rpc?: LiteRpc;
    },
    emit: (event: DeploymentEvent) => void,
): Promise<ProjectDeployResult> {
    const rpc = options.rpc ?? new LiteRpc(options.rpcBaseUrl);
    const identity = await rpc.whoami();
    if (identity.backend !== "core" && identity.backend !== "simulator") {
        throw new Error(`unsupported runtime '${String(identity.backend)}'`);
    }

    const registry = await rpc.dynRegistry();
    emit({ step: "slot", state: "active", detail: "planning project slots…" });
    const plan = resolveProjectPlan({
        projectRoot: options.projectRoot,
        core: options.core,
        contractPath: options.contractPath,
        name: options.name,
        slot: options.slotOverride,
        explicitCallees: options.explicitCallees,
        slotLayout: registry,
        registry,
    });
    const main = plan.at(-1);
    if (!main || main.kind !== "custom" || main.name !== options.name) {
        throw new Error(`project dependency graph did not end with Main '${options.name}'`);
    }
    emit({
        step: "slot",
        state: "ok",
        detail: `${plan.filter((contract) => contract.kind === "custom").length} custom · Main slot ${main.index}`,
    });

    emit({ step: "build", state: "active", detail: "compiling project graph…" });
    const projectBuild = await buildProjectContracts({
        plan,
        core: options.core,
        compiler: options.compiler,
        outDir: resolve(options.outDir ?? "dist/contracts"),
        skipVerify: options.skipVerify,
        cheats: options.cheats,
        onContract: (contract) => dependencyEvent(emit, `building ${contract.name} @ slot ${contract.index}`),
    });
    if (!projectBuild.ok) {
        const error = projectBuild.result?.stderr ?? "compile failed";
        emit({
            step: "build",
            state: "fail",
            detail: `${projectBuild.failed?.name ?? "contract"}: compile failed`,
        });
        emit({ note: error.split("\n").slice(0, 14).join("\n") });
        return {
            ok: false,
            backend: identity.backend,
            deployments: [],
            failedContract: projectBuild.failed?.name,
            remainingContracts: plan.filter((contract) => contract.kind === "custom").map((contract) => contract.name),
            error,
        };
    }

    interface BuiltSystem {
        contract: PlannedProjectContract;
        wasm: Uint8Array;
        hash: string;
    }
    const systems: BuiltSystem[] = [];
    if (identity.backend === "simulator") {
        for (const contract of plan) {
            if (contract.kind !== "system") {
                continue;
            }
            dependencyEvent(emit, `building system ${contract.name} @ slot ${contract.index} (${options.compiler})`);
            const built = await systemWasm(contract.name, options.core, options.compiler);
            systems.push({
                contract,
                wasm: built.wasm,
                hash: await k12Hex(built.wasm),
            });
        }
    }

    const registryContracts = registry.contracts ?? [];
    for (const system of systems) {
        const occupant = deployedAt(registryContracts, system.contract.index);
        if (occupant && occupant.name !== system.contract.name) {
            return {
                ok: false,
                backend: identity.backend,
                deployments: [],
                failedContract: system.contract.name,
                remainingContracts: [
                    ...systems.map((candidate) => candidate.contract.name),
                    ...projectBuild.contracts.map((candidate) => candidate.contract.name),
                ],
                error: `system slot ${system.contract.index} is occupied by '${occupant.name}', ` + `expected '${system.contract.name}'`,
            };
        }
    }
    emit({
        step: "build",
        state: "ok",
        detail: `${projectBuild.contracts.length} custom` + (systems.length ? ` · ${systems.length} system` : ""),
    });

    const deployments: ProjectDeploymentRecord[] = [];
    for (const [systemIndex, system] of systems.entries()) {
        let occupant = deployedAt(registryContracts, system.contract.index);
        if (normalizedHash(occupant?.codeHash) === normalizedHash(system.hash)) {
            try {
                occupant = deployedAt((await rpc.dynRegistry()).contracts ?? [], system.contract.index);
            } catch {
                occupant = undefined;
            }
        }
        if (normalizedHash(occupant?.codeHash) === normalizedHash(system.hash)) {
            deployments.push({
                name: system.contract.name,
                slot: system.contract.index,
                kind: "system",
                action: "skipped",
                hash: system.hash,
            });
            dependencyEvent(emit, `system ${system.contract.name} @ ${system.contract.index}: unchanged`);
            continue;
        }

        let deployed;
        try {
            deployed = await rpc.directDeploy(system.contract.index, system.wasm, system.contract.name, "system");
        } catch (error: any) {
            return {
                ok: false,
                backend: identity.backend,
                deployments,
                failedContract: system.contract.name,
                remainingContracts: [
                    ...systems.slice(systemIndex + 1).map((candidate) => candidate.contract.name),
                    ...projectBuild.contracts.map((candidate) => candidate.contract.name),
                ],
                error: String(error?.message ?? error),
            };
        }
        if (!deployed) {
            return {
                ok: false,
                backend: identity.backend,
                deployments,
                failedContract: system.contract.name,
                remainingContracts: [
                    ...systems.slice(systemIndex + 1).map((candidate) => candidate.contract.name),
                    ...projectBuild.contracts.map((candidate) => candidate.contract.name),
                ],
                error: "simulator does not expose system deployment; upgrade the Qinit simulator",
            };
        }
        deployments.push({
            name: system.contract.name,
            slot: system.contract.index,
            kind: "system",
            action: occupant ? "updated" : "deployed",
            hash: system.hash,
        });
        dependencyEvent(emit, `system ${system.contract.name} @ ${system.contract.index}: ${occupant ? "updated" : "deployed"}`);
    }

    const builtMain = projectBuild.contracts.at(-1);
    if (!builtMain || builtMain.contract.stateType !== main.stateType) {
        throw new Error(`project build did not produce Main '${options.name}'`);
    }

    let mainResult: DeployResult | undefined;
    for (const [builtIndex, built] of projectBuild.contracts.entries()) {
        const isMain = built.contract.stateType === main.stateType;
        let occupant = deployedAt(registryContracts, built.contract.index);
        if (!isMain && occupant?.name === built.contract.name && normalizedHash(occupant.codeHash) === normalizedHash(built.hash)) {
            try {
                occupant = deployedAt((await rpc.dynRegistry()).contracts ?? [], built.contract.index);
            } catch {
                occupant = undefined;
            }
        }
        if (!isMain && occupant?.name === built.contract.name && normalizedHash(occupant.codeHash) === normalizedHash(built.hash)) {
            try {
                await saveBuiltMetadata(rpc, built, resolve(options.projectRoot, DEFAULT_IDL_PATH));
            } catch (error: any) {
                dependencyEvent(emit, `metadata ${built.contract.name}: ${String(error?.message ?? error)}`);
            }
            deployments.push({
                name: built.contract.name,
                slot: built.contract.index,
                kind: "custom",
                action: "skipped",
                hash: built.hash,
            });
            dependencyEvent(emit, `callee ${built.contract.name} @ ${built.contract.index}: unchanged`);
            continue;
        }

        if (!isMain) {
            dependencyEvent(emit, `deploying callee ${built.contract.name} @ ${built.contract.index}`);
        }
        let result: DeployResult;
        try {
            result = await deployBuiltContract(built, options, identity.backend, rpc, isMain ? emit : () => {});
        } catch (error: any) {
            return {
                ok: false,
                backend: identity.backend,
                deployments,
                failedContract: built.contract.name,
                remainingContracts: projectBuild.contracts.slice(builtIndex + 1).map((candidate) => candidate.contract.name),
                error: String(error?.message ?? error),
            };
        }
        if (!result.ok) {
            return {
                ...result,
                backend: identity.backend,
                deployments,
                failedContract: built.contract.name,
                remainingContracts: projectBuild.contracts.slice(builtIndex + 1).map((candidate) => candidate.contract.name),
            };
        }
        if (isMain) {
            mainResult = result;
        }

        deployments.push({
            name: built.contract.name,
            slot: built.contract.index,
            kind: isMain ? "main" : "custom",
            action: occupant ? "updated" : "deployed",
            hash: built.hash,
        });
    }

    if (!mainResult) {
        throw new Error(`project deployment did not run Main '${options.name}'`);
    }

    return {
        ...mainResult,
        backend: identity.backend,
        deployments,
    };
}

async function deployBuiltContract(
    built: BuiltProjectContract,
    options: {
        projectRoot: string;
        core: string;
        rpcBaseUrl: string;
        seed?: string;
        outDir?: string;
        skipVerify?: boolean;
        compiler: CompilerBackend;
    },
    backend: NodeBackendIdentity["backend"],
    rpc: LiteRpc,
    emit: (event: DeploymentEvent) => void,
): Promise<DeployResult> {
    return deployContract(
        {
            contractPath: built.contract.sourcePath,
            name: built.contract.name,
            core: options.core,
            rpcBaseUrl: options.rpcBaseUrl,
            seed: options.seed,
            slotOverride: built.contract.index,
            outDir: options.outDir,
            idlPath: resolve(options.projectRoot, DEFAULT_IDL_PATH),
            skipVerify: options.skipVerify,
            compiler: options.compiler,
            backend,
            artifact: {
                wasm: built.wasm,
                hash: built.hash,
                idl: built.result.idl,
            },
            rpc,
        },
        emit,
    );
}
