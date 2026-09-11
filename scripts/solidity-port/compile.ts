// Compile one ported contract — or a caller/callee pair — with both backends, through the @qinit/build
// wrappers so one options object drives either. Cached on everything that can change the emitted bytes.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang, buildContractWithTypeScript } from "@qinit/build";
import { loadQpiHeader } from "@qinit/compiler";
import { readSourceTree } from "../../packages/compiler/tests/support/source-tree";

export type Backend = "typescript" | "clang";

/** One contract in a cell: a single contract, or the caller and callee of a pair. */
export interface ContractSpec {
    name: string;
    source: string;
    slot: number;
}

export interface CompileEnvironment {
    corePath: string;
    qpiHeader: string;
    /** Identity of the clang toolchain, folded into the cache key so an SDK bump invalidates it. */
    toolchainId: string;
    /** Hash of the TypeScript backend's own source. Without it a cached artifact would survive a change to the compiler under test, which is precisely the
     *  change the campaign exists to detect — a sweep run after editing the compiler would replay yesterday's wasm and report a clean bill of health. */
    typescriptBackendId: string;
    cacheDir: string;
    arenaSizeBytes: number;
}

export interface CompileOutcome {
    ok: boolean;
    wasm?: Uint8Array;
    diagnostics: string[];
    ms: number;
    cached: boolean;
}

/** What a cell needs compiled: the contract under test, plus the callee it calls, if any. */
export interface CompileRequest {
    main: ContractSpec;
    callee?: ContractSpec;
}

export interface CompiledPair {
    main: CompileOutcome;
    callee?: CompileOutcome;
}

const QPI_HEADER_CACHE = new Map<string, string>();

export function environmentFor(options: { corePath: string; cacheDir: string; arenaSizeBytes?: number }): CompileEnvironment {
    let qpiHeader = QPI_HEADER_CACHE.get(options.corePath);
    if (qpiHeader === undefined) {
        qpiHeader = loadQpiHeader(options.corePath);
        QPI_HEADER_CACHE.set(options.corePath, qpiHeader);
    }
    const clang = process.env.WASM_CLANG ?? "";
    const sysroot = process.env.WASI_SYSROOT ?? "";
    mkdirSync(options.cacheDir, { recursive: true });
    return {
        corePath: options.corePath,
        qpiHeader,
        toolchainId: sha256(`${clang}|${sysroot}|${process.version}`),
        typescriptBackendId: sha256(readSourceTree("../../packages/compiler/src", import.meta.url)),
        cacheDir: options.cacheDir,
        arenaSizeBytes: options.arenaSizeBytes ?? 1 << 20,
    };
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function cacheKey(env: CompileEnvironment, backend: Backend, contract: ContractSpec, callee?: ContractSpec): string {
    const backendId = backend === "typescript" ? env.typescriptBackendId : env.toolchainId;
    // The callee's source and slot belong in the key: a caller cached without them would survive a
    // callee edit and replay stale wasm.
    const calleePart = callee ? `${callee.name}@${callee.slot}#${sha256(callee.source)}` : "none";
    const material = [
        backend,
        contract.name,
        String(contract.slot),
        String(env.arenaSizeBytes),
        backendId,
        sha256(env.qpiHeader),
        calleePart,
        contract.source,
    ].join("|");
    return sha256(material);
}

/** A rejected compile is cached too — re-running a sweep must not rebuild the contracts that already failed. */
interface CacheEntry {
    ok: boolean;
    diagnostics: string[];
}

function readCache(env: CompileEnvironment, key: string): CompileOutcome | null {
    const metaPath = join(env.cacheDir, `${key}.json`);
    if (!existsSync(metaPath)) return null;
    let meta: CacheEntry;
    try {
        meta = JSON.parse(readFileSync(metaPath, "utf8")) as CacheEntry;
    } catch {
        return null;
    }
    if (!meta.ok) return { ok: false, diagnostics: meta.diagnostics, ms: 0, cached: true };
    const wasmPath = join(env.cacheDir, `${key}.wasm`);
    if (!existsSync(wasmPath)) return null;
    return { ok: true, wasm: new Uint8Array(readFileSync(wasmPath)), diagnostics: meta.diagnostics, ms: 0, cached: true };
}

function writeCache(env: CompileEnvironment, key: string, outcome: CompileOutcome): void {
    const meta: CacheEntry = { ok: outcome.ok, diagnostics: outcome.diagnostics };
    if (outcome.ok && outcome.wasm) writeFileSync(join(env.cacheDir, `${key}.wasm`), outcome.wasm);
    writeFileSync(join(env.cacheDir, `${key}.json`), JSON.stringify(meta));
}

/** Compile the request with one backend. Both contracts of a pair are staged into the same temporary directory under absolute paths: the clang wrapper
 *  `#include`s the callee header verbatim into the generated TU, so it must exist on disk for the whole of the caller's build. */
export async function compileWith(env: CompileEnvironment, backend: Backend, request: CompileRequest): Promise<CompiledPair> {
    const mainKey = cacheKey(env, backend, request.main, request.callee);
    const calleeKey = request.callee ? cacheKey(env, backend, request.callee) : undefined;
    const mainHit = readCache(env, mainKey);
    const calleeHit = calleeKey ? readCache(env, calleeKey) : undefined;
    if (mainHit && (!request.callee || calleeHit)) {
        return { main: mainHit, callee: calleeHit ?? undefined };
    }

    const directory = mkdtempSync(join(tmpdir(), `solport-${request.main.name}-`));
    try {
        const stage = (contract: ContractSpec): string => {
            const path = join(directory, `${contract.name}.h`);
            writeFileSync(path, contract.source);
            return path;
        };
        const mainPath = stage(request.main);
        const calleePath = request.callee ? stage(request.callee) : undefined;

        // The callee is built standalone first; only the caller carries dynCallees.
        let callee: CompileOutcome | undefined;
        if (request.callee && calleePath) {
            callee = calleeHit ?? (await buildOne(env, backend, directory, calleePath, request.callee, undefined));
            if (!calleeHit && calleeKey) writeCache(env, calleeKey, callee);
            if (!callee.ok) {
                const failed: CompileOutcome = {
                    ok: false,
                    diagnostics: [`callee ${request.callee.name} failed: ${callee.diagnostics[0] ?? ""}`],
                    ms: 0,
                    cached: false,
                };
                writeCache(env, mainKey, failed);
                return { main: failed, callee };
            }
        }

        const dynCallees = request.callee && calleePath ? { [request.callee.name]: { header: calleePath, slot: request.callee.slot } } : undefined;
        const main = mainHit ?? (await buildOne(env, backend, directory, mainPath, request.main, dynCallees));
        if (!mainHit) writeCache(env, mainKey, main);
        return { main, callee };
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

async function buildOne(
    env: CompileEnvironment,
    backend: Backend,
    outDir: string,
    contractPath: string,
    contract: ContractSpec,
    dynCallees: Record<string, { header: string; slot: number }> | undefined,
): Promise<CompileOutcome> {
    const started = Date.now();
    try {
        const shared = {
            contractPath,
            contractName: contract.name,
            slot: contract.slot,
            corePath: env.corePath,
            outDir,
            skipVerify: true,
            ...(dynCallees ? { dynCallees } : {}),
        };
        const built =
            backend === "clang" ? await buildContractWithClang({ ...shared, arenaSizeBytes: env.arenaSizeBytes }) : await buildContractWithTypeScript(shared);
        // A clang build that wrote a wasm succeeded whatever the IDL says, since buildContractWithClang
        // reports `ok: !idlError` and the sweep never reads the IDL. The path alone is not proof it wrote.
        const wroteWasm = Boolean(built.wasmPath) && existsSync(built.wasmPath!);
        const producedArtifact = backend === "clang" ? wroteWasm : built.ok && wroteWasm;
        if (producedArtifact && built.wasmPath) {
            const diagnostics = built.ok ? [] : [built.stderr ?? "build reported not-ok but produced a wasm"];
            return { ok: true, wasm: new Uint8Array(readFileSync(built.wasmPath)), diagnostics, ms: Date.now() - started, cached: false };
        }
        return { ok: false, diagnostics: [built.stderr ?? `${backend} build failed with no stderr`], ms: Date.now() - started, cached: false };
    } catch (error: any) {
        return { ok: false, diagnostics: [`threw: ${String(error?.message ?? error)}`], ms: Date.now() - started, cached: false };
    }
}
