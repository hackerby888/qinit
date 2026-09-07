// Compiling one ported contract with both backends, with a content-addressed wasm cache.
//
// The cache is what makes a multi-thousand sweep re-runnable: a corpus edit recompiles only the files
// that changed. The key covers everything that can change the emitted bytes — source, slot, arena size,
// backend, the qpi.h the build sees, and the identity of the backend itself.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { compileContractWithTypeScript, loadQpiHeader } from "@qinit/compiler";
import { DiagnosticSeverity } from "@qinit/compiler/shared/enums";
import { readSourceTree } from "../../packages/compiler/tests/support/source-tree";

export interface CompileEnvironment {
    corePath: string;
    qpiHeader: string;
    /** Identity of the clang toolchain, folded into the cache key so an SDK bump invalidates it. */
    toolchainId: string;
    /**
     * Hash of the TypeScript backend's own source. Without it a cached artifact would survive a change to
     * the compiler under test, which is precisely the change the campaign exists to detect — a sweep run
     * after editing the compiler would replay yesterday's wasm and report a clean bill of health.
     */
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

function cacheKey(env: CompileEnvironment, backend: string, source: string, contractName: string, slot: number): string {
    // Each backend's key carries its own identity, so editing one compiler invalidates only its half.
    const backendId = backend === "typescript" ? env.typescriptBackendId : env.toolchainId;
    const material = [backend, contractName, String(slot), String(env.arenaSizeBytes), backendId, sha256(env.qpiHeader), source].join("|");
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

export async function compileWithTypeScript(env: CompileEnvironment, source: string, contractName: string, slot: number): Promise<CompileOutcome> {
    const key = cacheKey(env, "typescript", source, contractName, slot);
    const hit = readCache(env, key);
    if (hit) return hit;

    const started = Date.now();
    let outcome: CompileOutcome;
    try {
        const result = await compileContractWithTypeScript({
            source,
            contractName,
            slot,
            qpiHeader: env.qpiHeader,
            arenaSizeBytes: env.arenaSizeBytes,
        });
        const errors = result.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR).map((d) => d.message);
        outcome = { ok: errors.length === 0, wasm: errors.length === 0 ? result.wasm : undefined, diagnostics: errors, ms: Date.now() - started, cached: false };
    } catch (error: any) {
        outcome = { ok: false, diagnostics: [`threw: ${String(error?.message ?? error)}`], ms: Date.now() - started, cached: false };
    }
    writeCache(env, key, outcome);
    return outcome;
}

export async function compileWithClang(env: CompileEnvironment, source: string, contractName: string, slot: number): Promise<CompileOutcome> {
    const key = cacheKey(env, "clang", source, contractName, slot);
    const hit = readCache(env, key);
    if (hit) return hit;

    const started = Date.now();
    // clang compiles a generated wrapper that #includes the contract by the path we hand it, so the
    // contract has to exist on disk under an absolute path for the duration of the build.
    const directory = mkdtempSync(join(tmpdir(), `solport-${contractName}-`));
    let outcome: CompileOutcome;
    try {
        const contractPath = join(directory, `${contractName}.h`);
        writeFileSync(contractPath, source);
        const built = await buildContractWithClang({
            contractPath,
            contractName,
            slot,
            corePath: env.corePath,
            outDir: directory,
            arenaSizeBytes: env.arenaSizeBytes,
            skipVerify: true,
        });
        if (built.ok && built.wasmPath) {
            outcome = { ok: true, wasm: new Uint8Array(readFileSync(built.wasmPath)), diagnostics: [], ms: Date.now() - started, cached: false };
        } else {
            outcome = { ok: false, diagnostics: [built.stderr ?? "clang build failed with no stderr"], ms: Date.now() - started, cached: false };
        }
    } catch (error: any) {
        outcome = { ok: false, diagnostics: [`threw: ${String(error?.message ?? error)}`], ms: Date.now() - started, cached: false };
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
    writeCache(env, key, outcome);
    return outcome;
}
