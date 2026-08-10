import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  resolveProjectDependencies,
  type ProjectContractNode,
} from "@qinit/build/project-dependencies";
import { planProjectSlots } from "@qinit/build/project-slots";
import {
  systemContracts,
  type SystemContract,
} from "@qinit/build/system-contracts";
import type { ContractIdl } from "@qinit/build/idl";
import type { DynCallees } from "@qinit/build/intercontract";
import { loadQpiHeader } from "@qinit/compiler";
import {
  analyzeContract,
  DiagnosticSeverity,
  type AnalyzeContractOptions,
} from "@qinit/compiler/analyzer";
import { loadConfig } from "@qinit/core/project";
import { DEFAULT_WASM_SLOT_LAYOUT } from "@qinit/core/wasm/slot-layout";
import { loadCoreWasmSlotLayout } from "@qinit/core/wasm/slot-layout-node";
import {
  contractStateType,
  findProjectRoot,
  QINIT_JSON,
} from "./project-util";

interface PlannedProjectNode extends ProjectContractNode {
  index: number;
}

export interface ProjectAnalysisContext extends Omit<
  AnalyzeContractOptions,
  "source"
> {
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
}

export function planEditorProjectSlots(
  nodes: readonly ProjectContractNode[],
  layout: { slotBase: number; slotCount: number },
): PlannedProjectNode[] {
  return planProjectSlots(nodes, layout) as PlannedProjectNode[];
}

function transitiveDependencies(
  contract: PlannedProjectNode,
  nodes: readonly PlannedProjectNode[],
): PlannedProjectNode[] {
  const byStateType = new Map(
    nodes.map((node) => [node.stateType, node]),
  );
  const wanted = new Set<string>();

  const visit = (stateType: string): void => {
    if (wanted.has(stateType)) {
      return;
    }
    const dependency = byStateType.get(stateType);
    if (!dependency) {
      throw new Error(
        `${contract.stateType} references unresolved project contract '${stateType}'`,
      );
    }
    wanted.add(stateType);
    for (const nested of dependency.dependencies) {
      visit(nested);
    }
  };

  for (const dependency of contract.dependencies) {
    visit(dependency);
  }
  return nodes.filter((node) => wanted.has(node.stateType));
}

function catalogIdl(
  node: PlannedProjectNode,
  catalog: readonly SystemContract[],
): ContractIdl {
  const contract = catalog.find(
    (candidate) =>
      candidate.index === node.index ||
      candidate.stateType === node.stateType,
  );
  if (!contract) {
    throw new Error(
      `system contract '${node.stateType}' is missing from the Core catalog`,
    );
  }

  return {
    ...contract.idl,
    name: node.stateType,
    slot: node.index,
  };
}

function analysisContext(
  contract: PlannedProjectNode,
  nodes: readonly PlannedProjectNode[],
  corePath: string,
): ProjectAnalysisContext {
  const dependencies = transitiveDependencies(contract, nodes);
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
        slot: dependency.index,
        qpiHeader,
        callees: callees.length ? callees : undefined,
        calleeSources: calleeSources.length ? calleeSources : undefined,
      });
      idl = result.idl;
      if (!idl) {
        const errors = result.diagnostics
          .filter((diagnostic) =>
            diagnostic.severity === DiagnosticSeverity.ERROR
          )
          .map((diagnostic) => diagnostic.message)
          .join("; ");
        throw new Error(
          `cannot analyze callee '${dependency.stateType}': ` +
            (errors || "contract IDL is unavailable"),
        );
      }
    }

    callees.push(idl);
    calleeSources.push({
      name: dependency.stateType,
      source: dependency.source,
      slot: dependency.index,
    });
  }

  const cacheKey = createHash("sha256")
    .update(corePath)
    .update(String(contract.index))
    .update(contract.stateType)
    .update(
      dependencies
        .map((dependency) =>
          `${dependency.stateType}\0${dependency.index}\0${dependency.source}`
        )
        .join("\0"),
    )
    .digest("hex");

  return {
    contractName: contract.stateType,
    slot: contract.index,
    qpiHeader,
    callees: callees.length ? callees : undefined,
    calleeSources: calleeSources.length ? calleeSources : undefined,
    cacheKey,
  };
}

function standaloneDetails(
  filePath: string,
  projectRoot: string,
  corePath: string | undefined,
  wasiSysrootPath: string | undefined,
): ProjectSourceDetails {
  let source = "";
  try {
    source = readFileSync(filePath, "utf8");
  } catch {}

  const name =
    contractStateType(source) ?? basename(filePath).replace(/\.[^.]+$/, "");
  const layout = corePath
    ? loadCoreWasmSlotLayout(corePath)
    : DEFAULT_WASM_SLOT_LAYOUT;
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

export function resolveProjectSourceDetails(options: {
  filePath: string;
  workspaceRoot: string;
  fallbackCorePath?: string;
}): ProjectSourceDetails {
  const filePath = resolve(options.filePath);
  const discoveredRoot = findProjectRoot(filePath);
  const projectRoot = discoveredRoot ?? resolve(options.workspaceRoot);
  const configPath = join(projectRoot, QINIT_JSON);
  const config = existsSync(configPath) ? loadConfig(configPath) : {};
  const corePath = config.coreDir
    ? resolve(projectRoot, config.coreDir)
    : options.fallbackCorePath;
  const toolchainCorePath = options.fallbackCorePath ?? corePath;
  const wasiSysrootPath = toolchainCorePath
    ? join(toolchainCorePath, "wasi-sdk", "share", "wasi-sysroot")
    : undefined;
  const availableWasiSysroot =
    wasiSysrootPath && existsSync(wasiSysrootPath)
      ? wasiSysrootPath
      : undefined;

  if (!config.contract) {
    return standaloneDetails(
      filePath,
      projectRoot,
      corePath,
      availableWasiSysroot,
    );
  }
  if (!corePath) {
    throw new Error(
      "project dependency resolution needs Core headers; set coreDir in qinit.json or reinstall the extension",
    );
  }

  const mainPath = resolve(projectRoot, config.contract);
  let mainSource = "";
  try {
    mainSource = readFileSync(mainPath, "utf8");
  } catch {}
  const mainName =
    config.contractName ??
    contractStateType(mainSource) ??
    basename(mainPath).replace(/\.[^.]+$/, "");
  const nodes = resolveProjectDependencies({
    projectRoot,
    corePath,
    contractName: mainName,
    contractPath: mainPath,
    contractIndex: config.slot,
  });
  const planned = planEditorProjectSlots(
    nodes,
    loadCoreWasmSlotLayout(corePath),
  );
  const contract = planned.find(
    (node) => resolve(node.sourcePath) === filePath,
  );

  if (!contract || contract.kind !== "custom") {
    return standaloneDetails(
      filePath,
      projectRoot,
      corePath,
      availableWasiSysroot,
    );
  }

  const dependencies = transitiveDependencies(contract, planned);
  const dynCallees = Object.fromEntries(
    dependencies
      .filter((dependency) => dependency.kind === "custom")
      .map((dependency) => [
        dependency.stateType,
        {
          header: dependency.sourcePath.replace(/\\/g, "/"),
          index: dependency.index,
        },
      ]),
  );

  return {
    projectRoot,
    corePath,
    wasiSysrootPath: availableWasiSysroot,
    contractPath: contract.sourcePath,
    name: contract.stateType,
    slot: contract.index,
    dynCallees,
    analysis: analysisContext(contract, planned, corePath),
  };
}
