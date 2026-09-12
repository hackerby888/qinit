import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolveContracts, type ResolvedContract } from "@qinit/build/contracts/project-dependencies";
import { assignSlots } from "@qinit/build/contracts/project-slots";
import { systemContracts, type SystemContract } from "@qinit/build/contracts/system-contracts";
import type { ContractIdl } from "@qinit/build/compile/idl";
import type { DynCallees } from "@qinit/build/contracts/intercontract";
import { loadQpiHeader } from "@qinit/compiler";
import { analyzeContract, DiagnosticSeverity, type AnalyzeContractOptions } from "@qinit/compiler/analyzer";
import { loadConfigSafe } from "@qinit/core/project";
import { DEFAULT_WASM_SLOT_LAYOUT } from "@qinit/core/wasm/slot-layout";
import { loadCoreWasmSlotLayout } from "@qinit/core/wasm/slot-layout-node";
import { contractStateType, findProjectRoot, QINIT_JSON } from "./project-util";

interface SlottedContract extends ResolvedContract {
    slot: number;
}

export interface ProjectAnalysisContext extends Omit<AnalyzeContractOptions, "source"> {
    cacheKey: string;
}

export interface ProjectSourceDetails {
    projectRoot: string;
    corePath?: string;
    wasiSysrootPath?: string;
    contractPath: string;
    name: string;
    slot: number;
    dynCallees: DynCallees;
    analysis: ProjectAnalysisContext;
    // Set when this file is a contract of the project that the plan could not keep. Resolution still
    // degrades to standalone, because losing the clangd config too would be worse — but the reason is
    // carried out so the editor can say it instead of leaving clangd's "undeclared identifier" alone.
    unresolved?: { name: string; reason: string };
}

export function planEditorProjectSlots(nodes: readonly ResolvedContract[], layout: { slotBase: number; slotCount: number }): SlottedContract[] {
    return assignSlots(nodes, layout);
}

// Eagerly indexed siblings take slots too, so a workspace with more contracts than the dynamic window would stop planning; drop them and keep what it builds.
function planWithSiblings(nodes: readonly ResolvedContract[], layout: { slotBase: number; slotCount: number }): SlottedContract[] {
    try {
        return planEditorProjectSlots(nodes, layout);
    } catch (error) {
        if (!nodes.some((node) => node.workspaceSibling)) {
            throw error;
        }
        return planEditorProjectSlots(
            nodes.filter((node) => !node.workspaceSibling),
            layout,
        );
    }
}

function calleeClosure(contract: SlottedContract, nodes: readonly SlottedContract[]): SlottedContract[] {
    const byStateType = new Map(nodes.map((node) => [node.stateType, node]));
    const wanted = new Set<string>();

    const visit = (stateType: string): void => {
        if (wanted.has(stateType)) {
            return;
        }
        const callee = byStateType.get(stateType);
        if (!callee) {
            throw new Error(`${contract.stateType} references unresolved project contract '${stateType}'`);
        }
        wanted.add(stateType);
        for (const nested of callee.callees) {
            visit(nested);
        }
    };

    for (const callee of contract.callees) {
        visit(callee);
    }
    return nodes.filter((node) => wanted.has(node.stateType));
}

function catalogIdl(node: SlottedContract, catalog: readonly SystemContract[]): ContractIdl {
    const contract = catalog.find((candidate) => candidate.index === node.slot || candidate.stateType === node.stateType);
    if (!contract) {
        throw new Error(`system contract '${node.stateType}' is missing from the Core catalog`);
    }

    return {
        ...contract.idl,
        name: node.stateType,
        slot: node.slot,
    };
}

// Every project contract the edited one could name: those it calls, plus siblings indexed eagerly so `Sibling::` resolves before the first reference exists.
function visibleDependencies(contract: SlottedContract, nodes: readonly SlottedContract[]): SlottedContract[] {
    const dependencies = calleeClosure(contract, nodes);
    const referenced = new Set(dependencies.map((node) => node.stateType));
    const siblings = nodes.filter((node) => node.kind === "custom" && node.stateType !== contract.stateType && !referenced.has(node.stateType));

    return [...dependencies, ...siblings];
}

function analysisContext(contract: SlottedContract, nodes: readonly SlottedContract[], corePath: string): ProjectAnalysisContext {
    const dependencies = visibleDependencies(contract, nodes);
    const referenced = new Set(calleeClosure(contract, nodes).map((node) => node.stateType));
    const qpiHeader = loadQpiHeader(corePath);
    const catalog = systemContracts(corePath);
    const callees: ContractIdl[] = [];
    const calleeSources: NonNullable<AnalyzeContractOptions["calleeSources"]> = [];

    for (const dependency of dependencies) {
        let idl: ContractIdl | undefined;
        if (dependency.kind === "system") {
            idl = catalogIdl(dependency, catalog);
        } else {
            const result = analyzeContract({
                source: dependency.source,
                contractName: dependency.stateType,
                slot: dependency.slot,
                qpiHeader,
                callees: callees.length ? callees : undefined,
                calleeSources: calleeSources.length ? calleeSources : undefined,
            });
            idl = result.idl;
            if (!idl) {
                // A sibling this contract does not call is offered for completion only, so its errors belong on its own document.
                if (!referenced.has(dependency.stateType)) {
                    continue;
                }
                const errors = result.diagnostics
                    .filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)
                    .map((diagnostic) => diagnostic.message)
                    .join("; ");
                throw new Error(`cannot analyze callee '${dependency.stateType}': ` + (errors || "contract IDL is unavailable"));
            }
        }

        callees.push(idl);
        calleeSources.push({
            name: dependency.stateType,
            source: dependency.source,
            slot: dependency.slot,
        });
    }

    const cacheKey = createHash("sha256")
        .update(corePath)
        .update(String(contract.slot))
        .update(contract.stateType)
        .update(dependencies.map((dependency) => `${dependency.stateType}\0${dependency.slot}\0${dependency.source}`).join("\0"))
        .digest("hex");

    return {
        contractName: contract.stateType,
        slot: contract.slot,
        qpiHeader,
        callees: callees.length ? callees : undefined,
        calleeSources: calleeSources.length ? calleeSources : undefined,
        cacheKey,
    };
}

function standaloneDetails(filePath: string, projectRoot: string, corePath: string | undefined, wasiSysrootPath: string | undefined): ProjectSourceDetails {
    let source = "";
    try {
        source = readFileSync(filePath, "utf8");
    } catch {}

    const name = contractStateType(source) ?? basename(filePath).replace(/\.[^.]+$/, "");
    const layout = corePath ? loadCoreWasmSlotLayout(corePath) : DEFAULT_WASM_SLOT_LAYOUT;
    const slot = layout.slotBase;
    const qpiHeader = corePath ? loadQpiHeader(corePath) : undefined;

    return {
        projectRoot,
        corePath,
        wasiSysrootPath,
        contractPath: resolve(filePath),
        name,
        slot,
        dynCallees: {},
        analysis: {
            contractName: name,
            slot,
            qpiHeader,
            cacheKey: `${corePath ?? "snapshot"}:${name}:${slot}`,
        },
    };
}

export function resolveProjectSourceDetails(options: { filePath: string; workspaceRoot: string; fallbackCorePath?: string }): ProjectSourceDetails {
    const filePath = resolve(options.filePath);
    const discoveredRoot = findProjectRoot(filePath);
    const projectRoot = discoveredRoot ?? resolve(options.workspaceRoot);
    const configPath = join(projectRoot, QINIT_JSON);
    // reporting variant: a malformed qinit.json must not take the extension down with it.
    const config = existsSync(configPath) ? loadConfigSafe(configPath).config : {};
    const corePath = config.coreDir ? resolve(projectRoot, config.coreDir) : options.fallbackCorePath;
    const toolchainCorePath = options.fallbackCorePath ?? corePath;
    const wasiSysrootPath = toolchainCorePath ? join(toolchainCorePath, "wasi-sdk", "share", "wasi-sysroot") : undefined;
    const availableWasiSysroot = wasiSysrootPath && existsSync(wasiSysrootPath) ? wasiSysrootPath : undefined;

    if (!config.contract) {
        return standaloneDetails(filePath, projectRoot, corePath, availableWasiSysroot);
    }
    if (!corePath) {
        throw new Error("project dependency resolution needs Core headers; set coreDir in qinit.json or reinstall the extension");
    }

    const mainPath = resolve(projectRoot, config.contract);
    let mainSource = "";
    try {
        mainSource = readFileSync(mainPath, "utf8");
    } catch {}
    const mainName = config.contractName ?? contractStateType(mainSource) ?? basename(mainPath).replace(/\.[^.]+$/, "");
    // A sibling that fails to resolve is rolled out of the plan, which afterwards is indistinguishable
    // from a header that belongs to no project at all. Collecting the reasons is what tells them apart.
    const dropped = new Map<string, string>();
    const nodes = resolveContracts({
        projectRoot,
        corePath,
        contractName: mainName,
        contractPath: mainPath,
        slot: config.slot,
        includeWorkspaceSiblings: true,
        onSiblingDropped: (name, reason) => dropped.set(name, reason),
    });
    const planned = planWithSiblings(nodes, loadCoreWasmSlotLayout(corePath));
    const contract = planned.find((node) => resolve(node.sourcePath) === filePath);

    if (!contract || contract.kind !== "custom") {
        const details = standaloneDetails(filePath, projectRoot, corePath, availableWasiSysroot);
        const reason = dropped.get(details.name);
        return reason ? { ...details, unresolved: { name: details.name, reason } } : details;
    }

    const dependencies = visibleDependencies(contract, planned);
    const dynCallees = Object.fromEntries(
        dependencies
            .filter((dependency) => dependency.kind === "custom")
            .map((dependency) => [
                dependency.stateType,
                {
                    header: dependency.sourcePath.replace(/\\/g, "/"),
                    slot: dependency.slot,
                },
            ]),
    );

    return {
        projectRoot,
        corePath,
        wasiSysrootPath: availableWasiSysroot,
        contractPath: contract.sourcePath,
        name: contract.stateType,
        slot: contract.slot,
        dynCallees,
        analysis: analysisContext(contract, planned, corePath),
    };
}
