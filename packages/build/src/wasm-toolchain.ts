// Compile a contract with the bundled wasm clang+lld (no native toolchain) — drop-in alt to recipe.ts's
// native compile(). The 90M `llvm` multitool (clang+lld, X86;AArch64;WebAssembly backends) runs under
// @bjorn3/browser_wasi_shim over an in-memory FS; it cross-emits the .so/.dylib for the node's platform.
// See ../../docs/WASM_TOOLCHAIN.md + toolchain/wasm-clang/. Pairs with the freestanding contract
// (-fno-exceptions -DLITEDYN_CONTRACT_TU) so the .so needs only host-resolved cross-ABI symbols.
import { join, dirname } from "node:path";
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { WASI, WASIProcExit, File, Directory, OpenFile, ConsoleStdout, PreopenDirectory, type Inode } from "@bjorn3/browser_wasi_shim";
import { genWrapper, type BuildOpts, type CompileResult } from "./recipe";

const dec = new TextDecoder();

// Per node-platform: clang target triple, lld flavor/flags, output extension.
export const WASM_TARGETS: Record<string, { triple: string; ldArgs: (o: string, so: string) => string[]; ext: string }> = {
  "linux-x64":    { triple: "x86_64-unknown-linux-gnu",  ldArgs: (o, so) => ["ld.lld", "-shared", o, "-o", so],                 ext: "so" },
  "linux-arm64":  { triple: "aarch64-unknown-linux-gnu", ldArgs: (o, so) => ["ld.lld", "-shared", o, "-o", so],                 ext: "so" },
  "darwin-arm64": { triple: "arm64-apple-macosx",        ldArgs: (o, so) => ["ld64.lld", "-dylib", "-arch", "arm64", o, "-o", so], ext: "dylib" },
};

// Where the fetched/cached toolchain lives (mirrors `qinit node get`): the wasm + a header bundle.
export function toolchainDir(): string {
  return process.env.QINIT_WASM_TOOLCHAIN || join(homedir(), ".cache", "qinit", "wasm-clang");
}
export function haveWasmToolchain(): boolean {
  const d = toolchainDir();
  return existsSync(join(d, "llvm.wasm")) && existsSync(join(d, "bundle.json")) && existsSync(join(d, "bundle"));
}

// Recursively load a host directory into an in-memory browser_wasi_shim tree. Skips VCS/build junk so
// mounting a full core checkout (not just a header snapshot) doesn't slurp .git/build/ into memory.
const LOADDIR_SKIP = new Set([".git", "build", "dist", "node_modules", ".cache", ".idea", ".vscode", "test"]);
async function loadDir(host: string): Promise<Map<string, Inode>> {
  const m = new Map<string, Inode>();
  for (const name of await readdir(host)) {
    if (LOADDIR_SKIP.has(name) || name.startsWith("cmake-build")) continue;
    const p = join(host, name);
    const s = await stat(p).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) m.set(name, new Directory(await loadDir(p)));
    else if (s.isFile()) m.set(name, new File(await readFile(p)));
  }
  return m;
}

// Run one tool from the multitool (argv[0] = clang|clang++|ld.lld|ld64.lld) over `root`. Mutates `root`
// (output files land in it). Returns exit code + captured stdio.
function runTool(mod: WebAssembly.Module, argv: string[], root: PreopenDirectory): { code: number; stdout: string; stderr: string } {
  let stdout = "", stderr = "";
  const wasi = new WASI(argv, [], [
    new OpenFile(new File([])),
    new ConsoleStdout((b) => { stdout += dec.decode(b); }),
    new ConsoleStdout((b) => { stderr += dec.decode(b); }),
    root,
  ]);
  const inst = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasi.wasiImport });
  let code = 0;
  try { code = (wasi.start(inst as any) as number) ?? 0; }
  catch (e) { if (e instanceof WASIProcExit) code = e.code; else throw e; }
  return { code, stdout, stderr };
}

function fileFromTree(root: PreopenDirectory, name: string): Uint8Array | undefined {
  const inode = (root.dir.contents as Map<string, Inode>).get(name);
  return inode instanceof File ? (inode.data as Uint8Array) : undefined;
}

export interface WasmBuildOpts extends BuildOpts { platform?: string; }

// Drop-in alternative to recipe.ts compile(): build the contract .so/.dylib with the wasm toolchain.
export async function compileWasm(o: WasmBuildOpts): Promise<CompileResult> {
  const plat = o.platform || "linux-x64";
  const tgt = WASM_TARGETS[plat];
  if (!tgt) throw new Error(`wasm toolchain: unsupported platform ${plat}`);
  const tc = toolchainDir();
  if (!haveWasmToolchain()) throw new Error(`wasm toolchain not found at ${tc} (run \`qinit toolchain get\`)`);

  await mkdir(o.outDir, { recursive: true });
  const wrapperPath = join(o.outDir, `${o.name}.wrapper.cpp`);
  const wrapperSrc = genWrapper(o);
  await writeFile(wrapperPath, wrapperSrc);
  const soHost = join(o.outDir, `${o.name}.${tgt.ext}`);

  // Assemble the in-memory FS. browser_wasi_shim is in-memory only, so every header clang may #include
  // must be preloaded. The `bundle/` dir mirrors host absolute paths of the curated transitive header set
  // (libc++ + clang-resource + libc, from `clang -M`); bundle.json lists the -isystem dirs (those abs paths).
  // Mount bundle at root, add the core tree (qpi.h etc) + the generated wrapper.
  const manifest = JSON.parse(await readFile(join(tc, "bundle.json"), "utf8")) as { wasm: string; isystem: string[] };
  const rootMap = await loadDir(join(tc, "bundle"));            // top-level: usr, home, … (abs-path tree)
  rootMap.set("core", new Directory(await loadDir(o.corePath))); // qpi.h, contract_core/, extensions/, …
  // genWrapper #includes the contract by its absolute HOST path, which isn't on the in-memory FS — mount it
  // at a stable path and rewrite the include to match.
  rootMap.set("contract.src.h", new File(await readFile(o.contractPath)));
  rootMap.set("wrapper.cpp", new File(new TextEncoder().encode(wrapperSrc.split(o.contractPath).join("/contract.src.h"))));
  const root = new PreopenDirectory("/", rootMap);
  const mod = await WebAssembly.compile(await readFile(join(tc, manifest.wasm)));
  const isystem = manifest.isystem.flatMap((d) => ["-isystem", d]);

  // 1) clang -> .o (freestanding; cross-emit the node target). Mirrors recipe.ts flags + the bundle includes.
  const cc = runTool(mod, [
    "clang", "-c", `--target=${tgt.triple}`, "-std=c++20", "-O2", "-fPIC", "-fno-rtti", "-fno-exceptions",
    "-DLITEDYN_CONTRACT_TU", ...(plat === "linux-x64" ? ["-mavx2"] : []),
    "-nostdinc", "-nostdinc++", ...isystem,
    "-I", "/core", "-I", "/core/src",
    "/wrapper.cpp", "-o", "/out.o",
  ], root);
  if (cc.code !== 0 || !fileFromTree(root, "out.o")) {
    return { ok: false, so: soHost, wrapper: wrapperPath, stderr: cc.stderr || cc.stdout, exitCode: cc.code };
  }

  // 2) lld -> .so/.dylib (no libs: the contract is freestanding; symbols host-resolve at dlopen).
  const ld = runTool(mod, tgt.ldArgs("/out.o", "/out.so"), root);
  const so = fileFromTree(root, "out.so");
  if (ld.code !== 0 || !so) {
    return { ok: false, so: soHost, wrapper: wrapperPath, stderr: ld.stderr || ld.stdout, exitCode: ld.code };
  }
  await writeFile(soHost, so);
  return { ok: true, so: soHost, wrapper: wrapperPath, stderr: cc.stderr + ld.stderr, exitCode: 0 };
}
