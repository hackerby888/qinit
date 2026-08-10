import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildContractWithTypeScript,
  buildContractWithWasiClang,
  resolveProjectDependencies,
  type ContractBuildResult,
  type ProjectCalleeInput,
  type ProjectContractNode,
  type TypeScriptCalleeBuildOptions,
} from "@qinit/build";
import {
  k12Hex,
  type DynamicContractRegistry,
} from "@qinit/core";
import type { DynCallees } from "@qinit/build/intercontract";
import type { CompilerBackend } from "../config";
import {
  planProjectSlots,
  type PlannedProjectSlotNode,
} from "../contracts/project-slots";

export type PlannedProjectContract = ProjectContractNode &
  PlannedProjectSlotNode;

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

  return planProjectSlots(
    dependencies,
    options.slotLayout,
    options.registry,
  );
}

function transitiveDependencies(
  contract: PlannedProjectContract,
  byStateType: ReadonlyMap<string, PlannedProjectContract>,
): PlannedProjectContract[] {
  const visited = new Set<string>();
  const ordered: PlannedProjectContract[] = [];

  const visit = (stateType: string): void => {
    if (visited.has(stateType)) {
      return;
    }
    visited.add(stateType);

    const dependency = byStateType.get(stateType);
    if (!dependency) {
      throw new Error(
        `${contract.stateType} references unresolved project contract '${stateType}'`,
      );
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

function clangCallees(
  dependencies: readonly PlannedProjectContract[],
): DynCallees {
  return Object.fromEntries(
    dependencies
      .filter((dependency) => dependency.kind === "custom")
      .map((dependency) => [
        dependency.stateType,
        {
          header: dependency.sourcePath,
          index: dependency.index,
        },
      ]),
  );
}

function typescriptCallees(
  dependencies: readonly PlannedProjectContract[],
): Record<string, TypeScriptCalleeBuildOptions> {
  return Object.fromEntries(
    dependencies.map((dependency) => [
      dependency.stateType,
      {
        header: dependency.sourcePath,
        index: dependency.index,
        stateType: dependency.stateType,
      },
    ]),
  );
}

export async function buildProjectContracts(options: {
  plan: readonly PlannedProjectContract[];
  core: string;
  compiler: CompilerBackend;
  outDir: string;
  skipVerify?: boolean;
  onContract?: (contract: PlannedProjectContract) => void;
}): Promise<ProjectBuildOutcome> {
  const byStateType = new Map(
    options.plan.map((contract) => [contract.stateType, contract]),
  );
  const built: BuiltProjectContract[] = [];

  for (const contract of options.plan) {
    if (contract.kind === "system") {
      continue;
    }

    options.onContract?.(contract);
    const dependencies = transitiveDependencies(contract, byStateType);
    const result = options.compiler === "typescript"
      ? await buildContractWithTypeScript({
          contractPath: contract.sourcePath,
          name: contract.name,
          stateType: contract.stateType,
          slot: contract.index,
          core: options.core,
          outDir: options.outDir,
          dynCallees: typescriptCallees(dependencies),
        })
      : await buildContractWithWasiClang({
          contractPath: contract.sourcePath,
          name: contract.name,
          stateType: contract.stateType,
          slot: contract.index,
          corePath: options.core,
          outDir: options.outDir,
          dynCallees: clangCallees(dependencies),
          skipVerify: options.skipVerify,
        });

    if (!result.ok || !result.wasmPath) {
      return {
        ok: false,
        contracts: built,
        failed: contract,
        result,
      };
    }

    const wasm = new Uint8Array(readFileSync(resolve(result.wasmPath)));
    const hash = result.wasmK12DigestHex ?? await k12Hex(wasm);
    built.push({ contract, result, wasm, hash });
  }

  return { ok: true, contracts: built };
}
