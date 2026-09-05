// qinit build: contract source -> wasm module, IDL extraction, contract catalogs, generated clients.
export { buildContractWithClang, buildCorpusRunner, buildSystemContract } from "./compile/pipeline";
export type { ContractBuildResult, SystemContractCompiler } from "./compile/types";
export { generateWasmWrapperSource } from "./compile/clang";
export type { ClangBuildOptions } from "./compile/clang";
export { buildContractWithTypeScript } from "./compile/typescript";
export type { TypeScriptBuildOptions, TypeScriptCalleeBuildOptions } from "./compile/typescript";
export { extractIdl } from "./compile/idl";
export type { ContractIdl } from "./compile/idl";
export { verifyContract, resolveVerifyTool } from "./compile/verify";
export type { VerifyResult } from "./compile/verify";
export { buildSnapshot } from "./compile/snapshot";
export type { SnapshotOptions, SnapshotResult } from "./compile/snapshot";
export { buildCalleePrelude, parseRegisters, scanCallees, parseContractDef } from "./contracts/intercontract";
export type { DynCallees, CalleeDef } from "./contracts/intercontract";
export {
    generateWasmContractTestingHeaderForCore,
    KNOWN_LOG_HEADER_VIOLATIONS,
    systemContractClosure,
    systemContractDescriptions,
    systemContracts,
    systemNames,
    type SystemContract,
    type SystemContractDescription,
} from "./contracts/system-contracts";
export { resolveContracts } from "./contracts/project-dependencies";
export type { CalleeInput, ResolvedContract, ResolveContractsOptions } from "./contracts/project-dependencies";
export { assignSlots } from "./contracts/project-slots";
export type { SlotAssignment, ProjectSlotLayout, SlotInput } from "./contracts/project-slots";
export { generateClient } from "./generate/client";
export { genStdGtest } from "./generate/std-gtest";
export { testRuntimeSource } from "./generate/test-scaffold";
