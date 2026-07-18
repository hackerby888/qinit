import type { CalleeIdl, CompileResult } from "../packages/compile/src/browser";
import { compileContract } from "../packages/compile/src/browser";
import API_PROBE_SOURCE from "../fixtures/ApiProbe.h" with { type: "text" };
import COUNTER_SOURCE from "../fixtures/Counter.h" with { type: "text" };
import COUNTER_V2_SOURCE from "../fixtures/CounterV2.h" with { type: "text" };
import DIGEST_PROBE_SOURCE from "../fixtures/DigestProbe.h" with { type: "text" };
import DIVIDEND_SOURCE from "../fixtures/Dividend.h" with { type: "text" };
import HOOKS_SOURCE from "../fixtures/Hooks.h" with { type: "text" };
import ORACLE_PROBE_SOURCE from "../fixtures/OracleProbe.h" with { type: "text" };
import PROXY_SOURCE from "../fixtures/Proxy.h" with { type: "text" };
import SHARE_APPROVER_SOURCE from "../fixtures/ShareApprover.h" with { type: "text" };
import SHARE_MANAGER_SOURCE from "../fixtures/ShareManager.h" with { type: "text" };
import SHARE_PROPOSER_SOURCE from "../fixtures/ShareProposer.h" with { type: "text" };
import SHARE_RECEIVER_SOURCE from "../fixtures/ShareReceiver.h" with { type: "text" };
import TOKEN_SOURCE from "../fixtures/Token.h" with { type: "text" };
import TRAP_SOURCE from "../fixtures/Trap.h" with { type: "text" };
import VAULT_SOURCE from "../fixtures/Vault.h" with { type: "text" };
import WATCHER_SOURCE from "../fixtures/Watcher.h" with { type: "text" };

export type WasmFixtureName =
  | "ApiProbe"
  | "Counter"
  | "Counter1"
  | "Counter5"
  | "Counter29"
  | "Counter30"
  | "Counter31"
  | "Counter40"
  | "CounterV1"
  | "CounterV2"
  | "DigestProbe"
  | "Dividend"
  | "Hooks"
  | "OracleProbe"
  | "Proxy"
  | "ShareApprover"
  | "ShareManager"
  | "ShareProposer"
  | "ShareReceiver"
  | "Token"
  | "Trap"
  | "Vault"
  | "Vault29"
  | "Watcher";

export interface WasmFixtureDefinition {
  readonly sourceFile: `${string}.h`;
  readonly source: string;
  readonly contractName: string;
  readonly slot: number;
  readonly dependencies?: readonly WasmFixtureName[];
}

export const wasmFixtureManifest = {
  ApiProbe: fixture("ApiProbe.h", API_PROBE_SOURCE, "ApiProbe", 29),
  Counter: fixture("Counter.h", COUNTER_SOURCE, "Counter", 28),
  Counter1: fixture("Counter.h", COUNTER_SOURCE, "Counter", 1),
  Counter5: fixture("Counter.h", COUNTER_SOURCE, "Counter", 5),
  Counter29: fixture("Counter.h", COUNTER_SOURCE, "Counter", 29),
  Counter30: fixture("Counter.h", COUNTER_SOURCE, "Counter", 30),
  Counter31: fixture("Counter.h", COUNTER_SOURCE, "Counter", 31),
  Counter40: fixture("Counter.h", COUNTER_SOURCE, "Counter", 40),
  CounterV1: fixture("Counter.h", COUNTER_SOURCE, "Counter", 28),
  CounterV2: fixture("CounterV2.h", COUNTER_V2_SOURCE, "Counter", 28),
  DigestProbe: fixture("DigestProbe.h", DIGEST_PROBE_SOURCE, "DigestProbe", 29),
  Dividend: fixture("Dividend.h", DIVIDEND_SOURCE, "Dividend", 28),
  Hooks: fixture("Hooks.h", HOOKS_SOURCE, "Hooks", 28),
  OracleProbe: fixture("OracleProbe.h", ORACLE_PROBE_SOURCE, "OracleProbe", 29),
  Proxy: fixture("Proxy.h", PROXY_SOURCE, "Proxy", 29, ["Counter"]),
  ShareApprover: fixture("ShareApprover.h", SHARE_APPROVER_SOURCE, "ShareApprover", 28),
  ShareManager: fixture("ShareManager.h", SHARE_MANAGER_SOURCE, "ShareManager", 29),
  ShareProposer: fixture("ShareProposer.h", SHARE_PROPOSER_SOURCE, "ShareProposer", 29),
  ShareReceiver: fixture("ShareReceiver.h", SHARE_RECEIVER_SOURCE, "ShareReceiver", 28),
  Token: fixture("Token.h", TOKEN_SOURCE, "Token", 28),
  Trap: fixture("Trap.h", TRAP_SOURCE, "Trap", 28),
  Vault: fixture("Vault.h", VAULT_SOURCE, "Vault", 28),
  Vault29: fixture("Vault.h", VAULT_SOURCE, "Vault", 29),
  Watcher: fixture("Watcher.h", WATCHER_SOURCE, "Watcher", 28),
} as const satisfies Record<WasmFixtureName, WasmFixtureDefinition>;

export const wasmFixtureNames = Object.freeze(
  Object.keys(wasmFixtureManifest) as WasmFixtureName[],
);

const compilationCache = new Map<WasmFixtureName, Promise<CompileResult>>();
const FIXTURE_ARENA_SIZE = 1024 * 1024;

function fixture(
  sourceFile: `${string}.h`,
  source: string,
  contractName: string,
  slot: number,
  dependencies?: readonly WasmFixtureName[],
): WasmFixtureDefinition {
  return {
    sourceFile,
    source,
    contractName,
    slot,
    ...(dependencies ? { dependencies } : {}),
  };
}

function toCalleeIdl(
  definition: WasmFixtureDefinition,
  result: CompileResult,
): CalleeIdl {
  const functions = Object.fromEntries(
    result.idl.functions.map((entry) => [
      entry.name,
      {
        inputType: entry.inputType,
        inSize: entry.inSize,
        outSize: entry.outSize,
      },
    ]),
  );
  const procedures = Object.fromEntries(
    result.idl.procedures.map((entry) => [
      entry.name,
      {
        inputType: entry.inputType,
        inSize: entry.inSize,
        outSize: entry.outSize,
      },
    ]),
  );

  return {
    name: definition.contractName,
    index: definition.slot,
    functions,
    procedures,
  };
}

function formatDiagnostics(result: CompileResult): string {
  if (result.diagnostics.length === 0) {
    return "  no compiler diagnostics";
  }

  return result.diagnostics
    .map(
      (diagnostic) =>
        `  ${diagnostic.severity} L${diagnostic.span.line}:${diagnostic.span.column} ${diagnostic.message}`,
    )
    .join("\n");
}

async function compileFixture(name: WasmFixtureName): Promise<CompileResult> {
  const cached = compilationCache.get(name);
  if (cached) {
    return cached;
  }

  const compilation = compileFixtureUncached(name);
  compilationCache.set(name, compilation);
  return compilation;
}

async function compileFixtureUncached(name: WasmFixtureName): Promise<CompileResult> {
  const definition = wasmFixtureManifest[name];

  try {
    const dependencyNames = definition.dependencies ?? [];
    const dependencyResults = await Promise.all(
      dependencyNames.map((dependencyName) => compileFixture(dependencyName)),
    );
    const callees = dependencyNames.map((dependencyName, index) =>
      toCalleeIdl(wasmFixtureManifest[dependencyName], dependencyResults[index]),
    );
    const calleeSources = dependencyNames.map((dependencyName) => ({
      name: wasmFixtureManifest[dependencyName].contractName,
      source: wasmFixtureManifest[dependencyName].source,
    }));

    const result = await compileContract({
      source: definition.source,
      name: definition.contractName,
      slot: definition.slot,
      arenaSz: FIXTURE_ARENA_SIZE,
      ...(callees.length > 0 ? { callees, calleeSources } : {}),
    });
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");

    if (errors.length > 0 || result.wasm.byteLength === 0) {
      throw new Error(formatDiagnostics(result));
    }

    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to compile Wasm fixture '${name}' (${definition.sourceFile}) at slot ${definition.slot}:\n${detail}`,
      { cause: error },
    );
  }
}

export async function loadWasmFixture(name: WasmFixtureName): Promise<Uint8Array> {
  const result = await compileFixture(name);
  return Uint8Array.from(result.wasm);
}
