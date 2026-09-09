import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, relative as relativePath } from "node:path";
import { generateWasmWrapperSource, WASM_CONTRACT_CLANG_FLAGS, WASM_TEST_UTIL_HEADER, type ClangBuildOptions } from "@qinit/build/compile/clang";
import { generateWasmContractTestingHeaderForCore } from "@qinit/build/contracts/system-contracts";
import { buildCalleePrelude, type DynCallees } from "@qinit/build/contracts/intercontract";
import { CORE_WASM_HEADERS } from "@qinit/core/wasm/headers";
import { DEFAULT_WASM_SLOT_LAYOUT } from "@qinit/core/wasm/slot-layout";
import { contractStateType } from "./project-util";

export const DEFAULT_SLOT = DEFAULT_WASM_SLOT_LAYOUT.slotBase;

const forwardSlashes = (path: string) => path.replace(/\\/g, "/");

export function deriveName(contractPath: string, explicit?: string): string {
    if (explicit) return explicit;
    return (contractPath.split(/[/\\]/).pop() ?? contractPath).replace(/\.[^.]+$/, "");
}

export interface ClangdInputs {
    contractPath: string;
    corePath: string;
    dataRoot?: string;
    workspaceRoot: string;
    name?: string;
    slot?: number;
    dynCallees?: DynCallees;
    wasiSysrootPath?: string;
}

export interface ClangdConfig {
    dir: string;
    prefixPath: string;
    contractFile: string;
    dbPath: string;
    dotClangdPath: string;
    clangdConfigured: boolean;
    restartRequired: boolean;
    name: string;
    slot: number;
    args: string[];
}

export interface TestClangdConfig {
    dbPath: string;
    prefixPath: string;
    testFile: string;
    dotClangdPath: string;
    clangdConfigured: boolean;
    restartRequired: boolean;
}

function compileArgs(corePath: string, wasiSysrootPath?: string): string[] {
    const core = forwardSlashes(corePath);
    const shim = forwardSlashes(join(corePath, "src", CORE_WASM_HEADERS.sdk.platformIntrinsics));
    const sysroot = forwardSlashes(wasiSysrootPath ?? join(corePath, "wasi-sdk", "share", "wasi-sysroot"));
    return [
        "clang++",
        ...WASM_CONTRACT_CLANG_FLAGS,
        "-Wno-undefined-inline",
        "-include",
        shim,
        `--sysroot=${sysroot}`,
        "-isystem",
        core,
        "-isystem",
        `${core}/src`,
    ];
}

export function ensureEditorSettings(workspaceRoot: string): void {
    const dir = join(workspaceRoot, ".vscode");
    const file = join(dir, "settings.json");
    let settings: Record<string, unknown> = {};
    if (existsSync(file)) {
        try {
            settings = JSON.parse(readFileSync(file, "utf8"));
        } catch {
            return;
        }
        if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return;
    }

    let changed = false;
    for (const [key, value] of [
        ["C_Cpp.intelliSenseEngine", "disabled"],
        ["C_Cpp.errorSquiggles", "disabled"],
    ] as const) {
        if (key in settings) continue;
        settings[key] = value;
        changed = true;
    }
    if (!changed) return;

    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}

export function detectStateType(source: string): string | undefined {
    return contractStateType(source);
}

function sourceDetails(o: ClangdInputs): {
    contractFile: string;
    name: string;
    slot: number;
    dir: string;
    options: ClangBuildOptions;
} {
    const contractPath = resolve(o.contractPath);
    const contractFile = forwardSlashes(contractPath);
    let source = "";
    try {
        source = readFileSync(contractPath, "utf8");
    } catch {}

    const detected = contractStateType(source);
    const name = detected && detected !== "CONTRACT_STATE_TYPE" ? detected : deriveName(o.contractPath, o.name);
    const slot = o.slot ?? DEFAULT_SLOT;
    const dir = join(o.dataRoot ?? join(o.workspaceRoot, ".qpi"), "clangd");
    mkdirSync(dir, { recursive: true });

    // Editor-only: index every sibling contract so `Sibling::` resolves before the first reference exists.
    const calleePrelude = buildCalleePrelude(o.corePath, source, o.dynCallees ?? {}, name, true);

    const options: ClangBuildOptions = {
        contractPath: contractFile,
        contractName: name,
        slot,
        corePath: o.corePath,
        outDir: dir,
        calleePrelude,
    };
    return { contractFile, name, slot, dir, options };
}

/**
 * Where `compile_commands.json` goes.
 *
 * clangd searches for it beside the source and up through the ancestors, and in a `build/` subdirectory
 * of each — measured: at the workspace root it loads, in `build/` it loads, in `.qpi/clangd/` it does
 * not, and the miss produces `Failed to find compilation database` and then a generic fallback command
 * with none of the QPI flags, which is why every name in the file goes red.
 *
 * Putting it where clangd already looks removes the need for a `.clangd` pointer at all — and that
 * pointer was the defect: it was written once with an absolute path under the VS Code profile
 * storage, never rewritten, and shipped to whoever cloned the repo. Only the *generated artifacts*
 * (the prefix headers and the gtest support headers) stay under `.qpi/`; dumping those at the root
 * would put four generated headers in the developer's source tree.
 *
 * A `compile_commands.json` that qinit did not write is left alone — a real C++ build in the same
 * folder owns that name — and the `.clangd` pointer is used for that case only.
 */
// Provenance lives beside the generated artifacts, not inside the database: clangd validates the JSON
// schema strictly and refuses the whole file on an unknown key ("Failed to load compilation database:
// Unknown key"), which would leave the editor with no flags at all — the very failure this fixes.
const DB_OWNER_FILE = "owns-root-db";

function ownsDatabase(generatedDir: string, dbPath: string): boolean {
    try {
        return readFileSync(join(generatedDir, DB_OWNER_FILE), "utf8").trim() === forwardSlashes(dbPath);
    } catch {
        return false;
    }
}

function claimDatabase(generatedDir: string, dbPath: string): void {
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(join(generatedDir, DB_OWNER_FILE), forwardSlashes(dbPath));
}

function databaseDirectory(workspaceRoot: string, generatedDir: string): { dir: string; needsPointer: boolean } {
    const rootDb = join(workspaceRoot, "compile_commands.json");
    if (!existsSync(rootDb) || ownsDatabase(generatedDir, rootDb)) {
        claimDatabase(generatedDir, rootDb);
        return { dir: workspaceRoot, needsPointer: false };
    }
    // Somebody else's database already holds the well-known name — a real C++ build in the same folder.
    // Keep out of its way and fall back to the pointer, which is now relative and so still portable.
    return { dir: generatedDir, needsPointer: true };
}

function writeCompileEntry(dir: string, file: string, args: string[]): { path: string; added: boolean } {
    const dbPath = join(dir, "compile_commands.json");
    const entry = { directory: forwardSlashes(dir), file, arguments: args };
    let entries: Array<{ file?: string }> = [];
    try {
        const parsed = JSON.parse(readFileSync(dbPath, "utf8"));
        if (Array.isArray(parsed)) entries = parsed;
    } catch {}

    const added = !entries.some((existing) => existing?.file === file);
    entries = entries.filter((existing) => existing?.file !== file);
    entries.push(entry);
    writeFileSync(dbPath, JSON.stringify(entries, null, 2) + "\n");
    return { path: dbPath, added };
}

const CLANGD_MARKER = "# Generated by the Qubic QPI extension.";

/**
 * Only written when the database could not go where clangd looks by itself — i.e. when the workspace
 * root already holds somebody else's `compile_commands.json`.
 *
 * The path is *relative*, so the file means the same thing on every machine. It used to be an absolute
 * path under this VS Code profile's storage, written once and never rewritten: on a teammate's clone,
 * a second profile or a moved folder it pointed at nothing, clangd silently fell back to a generic
 * command with no flags, every QPI name went red, and the only signal was one transient toast. An
 * existing file that carries the marker is ours to rewrite; one without it is the developer's.
 */
function ensureClangdConfig(workspaceRoot: string, databaseDir: string): { path: string; configured: boolean; rewritten: boolean } {
    const path = join(workspaceRoot, ".clangd");
    const relative = forwardSlashes(relativePath(workspaceRoot, databaseDir)) || ".";
    const body =
        [CLANGD_MARKER, "CompileFlags:", `  CompilationDatabase: ${JSON.stringify(relative)}`, "Completion:", "  AllScopes: No", "  HeaderInsertion: Never", ""].join(
            "\n",
        );

    if (existsSync(path)) {
        const current = readFileSync(path, "utf8");
        if (!current.startsWith(CLANGD_MARKER)) {
            // The developer's own file. Say so rather than clobbering it.
            return { path, configured: current.includes(relative), rewritten: false };
        }
        if (current === body) {
            return { path, configured: true, rewritten: false };
        }
    }

    writeFileSync(path, body);
    return { path, configured: true, rewritten: true };
}

export function generateClangdConfig(o: ClangdInputs): ClangdConfig {
    const details = sourceDetails(o);
    const wrapper = generateWasmWrapperSource(details.options);
    const contractInclude = `#include "${details.contractFile}"`;
    const includeOffset = wrapper.indexOf(contractInclude);
    const preamble = includeOffset >= 0 ? wrapper.slice(0, includeOffset) : wrapper;
    const prefixPath = join(details.dir, `${details.name}.prefix.h`);
    writeFileSync(prefixPath, preamble);

    const args = [...compileArgs(o.corePath, o.wasiSysrootPath), "-include", forwardSlashes(prefixPath), "-x", "c++", details.contractFile];
    // Generated artifacts stay in `details.dir`; the database goes where clangd will find it.
    const db = databaseDirectory(o.workspaceRoot, details.dir);
    const compileEntry = writeCompileEntry(db.dir, details.contractFile, args);
    const clangd = db.needsPointer
        ? ensureClangdConfig(o.workspaceRoot, db.dir)
        : { path: join(o.workspaceRoot, ".clangd"), configured: true, rewritten: false };
    ensureEditorSettings(o.workspaceRoot);

    return {
        dir: details.dir,
        prefixPath,
        contractFile: details.contractFile,
        dbPath: compileEntry.path,
        dotClangdPath: clangd.path,
        clangdConfigured: clangd.configured,
        // A rewritten pointer means clangd is holding a database path that no longer applies, so the
        // restart matters even when the file entry itself already existed.
        restartRequired: compileEntry.added || clangd.rewritten,
        name: details.name,
        slot: details.slot,
        args,
    };
}

export function generateTestClangdConfig(o: ClangdInputs & { testPath: string }): TestClangdConfig {
    const details = sourceDetails(o);
    const preamble = generateWasmWrapperSource({
        ...details.options,
        testSource: "\n",
        testPath: "gtest-prefix.h",
    });
    writeFileSync(
        join(details.dir, "contract_testing.h"),
        generateWasmContractTestingHeaderForCore({
            corePath: o.corePath,
            contractName: details.name,
            slot: details.slot,
        }),
    );
    writeFileSync(join(details.dir, "test_util.h"), WASM_TEST_UTIL_HEADER);

    const testPath = resolve(o.testPath);
    const testFile = forwardSlashes(testPath);
    const testBase = (testPath.split(/[/\\]/).pop() ?? "test").replace(/\.[^.]+$/, "");
    const prefixPath = join(details.dir, `${testBase}.test.prefix.h`);
    writeFileSync(prefixPath, preamble);

    const args = [
        ...compileArgs(o.corePath, o.wasiSysrootPath),
        "-I",
        forwardSlashes(details.dir),
        "-include",
        forwardSlashes(prefixPath),
        "-x",
        "c++",
        testFile,
    ];
    const db = databaseDirectory(o.workspaceRoot, details.dir);
    const compileEntry = writeCompileEntry(db.dir, testFile, args);
    const clangd = db.needsPointer
        ? ensureClangdConfig(o.workspaceRoot, db.dir)
        : { path: join(o.workspaceRoot, ".clangd"), configured: true, rewritten: false };
    ensureEditorSettings(o.workspaceRoot);

    return {
        dbPath: compileEntry.path,
        prefixPath,
        testFile,
        dotClangdPath: clangd.path,
        clangdConfigured: clangd.configured,
        restartRequired: compileEntry.added || clangd.rewritten,
    };
}
