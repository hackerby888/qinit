import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_FUNDED_SEED, DEFAULT_RPC_BASE, assertSeed, loadConfig, resolveCoreDir, type QinitConfig } from "@qinit/core";
import { loadQpiHeader } from "@qinit/compiler";
import { detectContractName } from "@qinit/compiler/analyzer";
import { invalidArgs } from "./args";

export { loadConfig, resolveCoreDir };
export type { QinitConfig } from "@qinit/core";

// one rule for every command that talks to a node: --rpc, then qinit.json rpc, then the default.
export function resolveRpc(requested: string | undefined, config: QinitConfig): string {
    return requested || config.rpc || DEFAULT_RPC_BASE;
}

// a local node binds this address; a project pointed at a shared node has to say where the local one goes.
export function assertLoopbackRpc(rpc: string): void {
    const host = new URL(rpc).hostname;
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
        throw new Error(`qinit.json rpc is ${rpc} — a local node needs a loopback address, pass --rpc http://127.0.0.1:<port>`);
    }
}

// the contract file a command acts on: its argument, then qinit.json. never guessed from a name: the contract name, file and state struct can all differ.
export function projectContractPath(command: string, requested: string | undefined, config: QinitConfig, cwd = process.cwd()): string {
    const path = requested ?? config.contract;
    if (path) {
        return resolve(cwd, path);
    }

    const fix = `pass \`qinit ${command} <file.h>\``;
    throw new Error(
        existsSync(join(cwd, "qinit.json"))
            ? `qinit.json names no contract file — set "contract" there, or ${fix}`
            : `not in a qinit project (no qinit.json in ${cwd}) — cd into one, or ${fix}`,
    );
}

// the deploy message carries the name in char[32]: core keeps 31 bytes, the simulator keeps them all, and reuse-by-name would disagree.
export const MAX_CONTRACT_NAME = 31;

// a user contract's name is the struct it declares; a name given by flag or qinit.json must agree with it, never replace it.
export function projectContractName(
    contractPath: string,
    flags: { contractName?: string; stateType?: string },
    config: QinitConfig,
    fromConfig: boolean,
): string {
    if (!existsSync(contractPath)) {
        throw new Error(`${contractPath} not found`);
    }
    const declared = detectContractName(readFileSync(contractPath, "utf8"));
    if (!declared) {
        throw new Error(`no contract struct in ${contractPath} — a contract declares \`struct Name : public ContractBase\``);
    }
    if (declared.length > MAX_CONTRACT_NAME) {
        throw new Error(`contract ${declared} is ${declared.length} characters — a deployed contract's name is at most ${MAX_CONTRACT_NAME}`);
    }
    // qinit.json's name speaks only for qinit.json's file; a header named on the command line is its own contract.
    const claims = [
        ["--contract-name", flags.contractName],
        ["--state-type", flags.stateType],
        ["qinit.json contractName", fromConfig ? config.contractName : undefined],
    ] as const;
    for (const [source, claimed] of claims) {
        if (claimed !== undefined && claimed !== declared) {
            throw new Error(`${source} "${claimed}" ≠ struct ${declared} in ${basename(contractPath)} — a contract's name is its struct: rename one of them`);
        }
    }
    return declared;
}

// Keep these re-exports free of Ink/React so the VS Code extension can use them.
export function loadConfiguredQpiHeader(explicitCoreDir?: string): string {
    const config = loadConfig();
    return loadQpiHeader(resolveCoreDir(explicitCoreDir, config.coreDir));
}

function configDir(): string {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg) {
        return join(xdg, "qinit");
    }

    if (process.platform === "win32") {
        const appData = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "qinit");
        const legacy = join(homedir(), ".config", "qinit");
        return !existsSync(appData) && existsSync(legacy) ? legacy : appData;
    }

    return join(homedir(), ".config", "qinit");
}

export function seedStorePath(): string {
    return join(configDir(), "seed");
}

export function savedSeed(): string | undefined {
    try {
        const seed = readFileSync(seedStorePath(), "utf8").trim();
        return /^[a-z]{55}$/.test(seed) ? seed : undefined;
    } catch {
        return undefined;
    }
}

export function setSavedSeed(seed: string): void {
    assertSeed(seed);
    const path = seedStorePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, seed + "\n", { mode: 0o600 });
}

export function clearSavedSeed(): void {
    try {
        rmSync(seedStorePath());
    } catch {
        // Clearing a missing seed is already complete.
    }
}

export function themeStorePath(): string {
    return join(configDir(), "theme");
}

export function savedTheme(): string | undefined {
    try {
        return readFileSync(themeStorePath(), "utf8").trim() || undefined;
    } catch {
        return undefined;
    }
}

export function setSavedTheme(name: string): void {
    const path = themeStorePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, name + "\n");
}

export type NodeRuntime = "core" | "simulator";
export const NODE_RUNTIMES: NodeRuntime[] = ["core", "simulator"];

export function runtimeStorePath(): string {
    return join(configDir(), "runtime");
}

export function savedRuntime(): NodeRuntime | undefined {
    try {
        const runtime = readFileSync(runtimeStorePath(), "utf8").trim();
        return runtime === "core" || runtime === "simulator" ? runtime : undefined;
    } catch {
        return undefined;
    }
}

export function setSavedRuntime(runtime: NodeRuntime): void {
    const path = runtimeStorePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, runtime + "\n");
}

export function resolveRuntime(requested?: string): NodeRuntime {
    if (requested === undefined) {
        return savedRuntime() ?? "core";
    }
    if (requested === "core" || requested === "simulator") {
        return requested;
    }
    return invalidArgs("--runtime must be core or simulator");
}

export type CompilerBackend = "clang" | "typescript";
export const COMPILER_BACKENDS: CompilerBackend[] = ["clang", "typescript"];

export function compilerBackendStorePath(): string {
    return join(configDir(), "compiler-backend");
}

export function savedCompilerBackend(): CompilerBackend | undefined {
    try {
        const backend = readFileSync(compilerBackendStorePath(), "utf8").trim();
        return backend === "clang" || backend === "typescript" ? backend : undefined;
    } catch {
        return undefined;
    }
}

export function setSavedCompilerBackend(backend: CompilerBackend): void {
    const path = compilerBackendStorePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, backend + "\n");
}

export function resolveCompilerBackend(requested?: string): CompilerBackend {
    if (requested === undefined) {
        return savedCompilerBackend() ?? "clang";
    }
    if (requested === "clang" || requested === "typescript") {
        return requested;
    }
    return invalidArgs("--compiler must be clang or typescript");
}

// A simulator node meters fees like a real one unless a run opts out.
export function resolveFeeMode(requested?: string): "metered" | "off" | undefined {
    if (requested === undefined) {
        return undefined;
    }
    if (requested === "metered" || requested === "off") {
        return requested;
    }
    return invalidArgs("--fees must be metered or off");
}

export async function resolveSeed(rpc: { fundedSeed(): Promise<string | undefined> }, explicit?: string): Promise<string> {
    if (explicit) {
        assertSeed(explicit);
        return explicit;
    }
    const saved = savedSeed();
    if (saved) {
        return saved;
    }

    const funded = await rpc.fundedSeed();
    return funded ?? DEFAULT_FUNDED_SEED;
}
