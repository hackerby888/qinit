// Round 30: the quadrant never measured — code the editor squiggles that the build accepts. Reproduces the
// editor's translation unit exactly, then runs the same front end over it.
import { execFileSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { editorPrefixSource } from "../src/clangd-config";
import { generateWasmWrapperSource, WASM_CONTRACT_CLANG_FLAGS } from "@qinit/build/compile/clang";
import { CORE_WASM_HEADERS } from "@qinit/core/wasm/headers";
import { CheatMode } from "@qinit/compiler";
import { CORE_PATH, HAS_CORE } from "../../../test-utils/paths";

if (!HAS_CORE) {
    console.error("QINIT_CORE is required");
    process.exit(2);
}

const WASM_CLANG = process.env.WASM_CLANG;
if (!WASM_CLANG) {
    console.error("WASM_CLANG is required");
    process.exit(2);
}

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SYSROOT = process.env.WASI_SYSROOT ?? join(CORE_PATH, "wasi-sdk", "share", "wasi-sysroot");
const limit = Number(process.argv[2] ?? "0");

// The editor's own flags, as `compileArgs` writes them into compile_commands.json, minus the driver name.
const editorFlags = [
    ...WASM_CONTRACT_CLANG_FLAGS,
    "-Wno-undefined-inline",
    "-include",
    join(CORE_PATH, "src", CORE_WASM_HEADERS.sdk.platformIntrinsics),
    `--sysroot=${SYSROOT}`,
    "-isystem",
    CORE_PATH,
    "-isystem",
    join(CORE_PATH, "src"),
];

/** Errors clang reports for the contract as the editor's translation unit sees it, empty when it type-checks. */
function editorViewErrors(contractPath: string, contractName: string, workDirectory: string): string[] {
    const wrapper = generateWasmWrapperSource({
        contractName,
        contractPath,
        slot: 31,
        cheats: CheatMode.OFF,
    } as Parameters<typeof generateWasmWrapperSource>[0]);
    const prefixPath = join(workDirectory, `${contractName}.prefix.h`);
    writeFileSync(prefixPath, editorPrefixSource(wrapper, contractPath));

    try {
        execFileSync(WASM_CLANG!, [...editorFlags, "-include", prefixPath, "-fsyntax-only", "-x", "c++", contractPath], {
            stdio: ["ignore", "ignore", "pipe"],
            encoding: "utf8",
        });
        return [];
    } catch (failure: any) {
        const stderr = String(failure?.stderr ?? "");
        return stderr
            .split("\n")
            .filter((line) => / error: /.test(line))
            .map((line) => line.replace(/^.*? error: /, "").slice(0, 110));
    }
}

// The intercontract family pairs each caller with a callee the generator holds in memory and never writes
// to disk, so the caller alone cannot resolve it — the harness's doing, not the editor's.
const CONTAMINATED_FAMILY = "/intercontract/";
const paths = globSync(join(REPO_ROOT, "corpus/solidity-port/variants/**/*.h"))
    .filter((path) => !path.includes(CONTAMINATED_FAMILY))
    .sort();
const chosen = limit > 0 ? paths.filter((_, index) => index % Math.ceil(paths.length / limit) === 0) : paths;
const workDirectory = mkdtempSync(join(tmpdir(), "editor-view-"));
const byMessage = new Map<string, { count: number; example: string }>();
let clean = 0;
let skipped = 0;
let flagCount = 0;

console.log(`${chosen.length} contracts, as the editor's translation unit sees them\n`);

try {
    for (const path of chosen) {
        const contractName = readFileSync(path, "utf8").match(/struct\s+(\w+)\s*:\s*public\s+ContractBase/)?.[1];

        if (!contractName) {
            skipped++;
            continue;
        }

        if ((clean + flagCount + skipped) % 250 === 0) {
            console.log(`  …${clean + flagCount + skipped} of ${chosen.length}`);
        }

        const errors = editorViewErrors(path, contractName, workDirectory);

        if (errors.length === 0) {
            clean++;
            continue;
        }

        flagCount++;
        const key = errors[0]!;
        const seen = byMessage.get(key);
        if (seen) seen.count++;
        else byMessage.set(key, { count: 1, example: path });
    }
} finally {
    rmSync(workDirectory, { recursive: true, force: true });
}

const flagged = [...byMessage.values()].reduce((sum, entry) => sum + entry.count, 0);
console.log(`  type-checks clean   ${clean}`);
console.log(`  clang reports errors ${flagged}  in ${byMessage.size} distinct classes`);
console.log(`  skipped             ${skipped}`);

for (const [message, entry] of [...byMessage].sort((left, right) => right[1].count - left[1].count)) {
    console.log(`\n  ${entry.count}x  ${message}`);
    console.log(`      ${entry.example.replace(`${REPO_ROOT}/`, "")}`);
}
