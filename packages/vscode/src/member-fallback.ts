// clangd completes nothing for members reached through a field whose preamble-defined type holds a
// template member (upstream bug, clangd 17-22). Raw clang's -code-completion-at answers it, so an
// empty member list is re-asked of a real clang++ against a PCH built from the same prefix header.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { wasiSdkPaths } from "@qinit/core/cache/wasi-sdk";

export interface FallbackItem {
  label: string;
  detail?: string;
  kind: "field" | "method";
}

const COMPLETION_LINE = /^COMPLETION: (.+?)(?: : (.*))?$/;
const RESULT_TYPE = /\[#(.*?)#\]/;

function run(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        // clang exits non-zero when the buffer has parse errors, but completions still stream out.
        resolvePromise({ ok: !error || stdout.length > 0, stdout: stdout ?? "" });
      },
    );
  });
}

let cachedClang: string | undefined | null = null;
const clangVersions = new Map<string, string>();

/** clang++ used for fallback completion: WASM_CLANG, the qinit wasi-sdk cache, then PATH. */
export async function findClang(): Promise<string | undefined> {
  if (cachedClang !== null) return cachedClang;

  const candidates: string[] = [];
  const configured = process.env.WASM_CLANG?.trim();
  if (configured) candidates.push(configured);
  try {
    const sdkClang = wasiSdkPaths()?.clang;
    if (sdkClang) candidates.push(sdkClang);
  } catch {}
  candidates.push("clang++");

  for (const candidate of candidates) {
    if (candidate !== "clang++" && !existsSync(candidate)) continue;
    const probe = await run(candidate, ["--version"], 5000);
    if (probe.ok && probe.stdout.includes("clang")) {
      cachedClang = candidate;
      clangVersions.set(candidate, probe.stdout.split("\n")[0]);
      return candidate;
    }
  }
  cachedClang = undefined;
  return undefined;
}

export function resetClangCacheForTests(): void {
  cachedClang = null;
  clangVersions.clear();
}

/** The compile-DB entry for this contract, read from the DB next to the generated prefix. */
export function compileEntryFor(
  prefixPath: string,
  contractPath: string,
): { directory: string; args: string[] } | undefined {
  const dbPath = join(dirname(prefixPath), "compile_commands.json");
  let entries: Array<{ directory?: string; file?: string; arguments?: string[] }>;
  try {
    entries = JSON.parse(readFileSync(dbPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!Array.isArray(entries)) return undefined;

  const wanted = contractPath.replace(/\\/g, "/");
  const entry = entries.find((candidate) => candidate?.file === wanted);
  if (!entry?.arguments || !entry.directory) return undefined;
  return { directory: entry.directory, args: entry.arguments };
}

/** DB args split around the trailing `-include <prefix> -x c++ <contract>` tail. */
export function splitCompileArgs(
  args: string[],
  prefixPath: string,
): { shared: string[] } | undefined {
  const prefix = prefixPath.replace(/\\/g, "/");
  const shared: string[] = [];
  let sawPrefix = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-include" && args[i + 1] === prefix) {
      sawPrefix = true;
      i++;
      continue;
    }
    if (arg === "-x") {
      i++;
      continue;
    }
    if (i === args.length - 1 && !arg.startsWith("-")) continue;
    shared.push(arg);
  }
  return sawPrefix ? { shared } : undefined;
}

export function pchPathFor(prefixPath: string): string {
  return prefixPath.replace(/\.h$/, ".pch");
}

// clang rejects a PCH whose source mtime moved, and the extension rewrites the prefix on every
// document event — so the PCH is built from a snapshot that is only touched when content changes.
export function pchSourcePathFor(prefixPath: string): string {
  return prefixPath.replace(/\.h$/, ".pch.h");
}

// Which include/<triple>/c++/v1 dir a driver adds depends on how it spells the wasi triple, so the
// sysroot's libc++ dirs are passed explicitly; duplicates of driver-added dirs are harmless.
export function cxxIncludeArgs(shared: string[]): string[] {
  const sysroot = shared
    .find((arg) => arg.startsWith("--sysroot="))
    ?.slice("--sysroot=".length);
  if (!sysroot) return [];

  const args: string[] = [];
  for (const dir of [
    join(sysroot, "include", "wasm32-wasi", "c++", "v1"),
    join(sysroot, "include", "c++", "v1"),
  ]) {
    if (existsSync(dir)) args.push("-isystem", dir);
  }
  return args;
}

function pchKey(clang: string, prefixText: string, shared: string[]): string {
  return createHash("sha256")
    .update(clang)
    .update("\0")
    .update(shared.join("\0"))
    .update("\0")
    .update(prefixText)
    .digest("hex");
}

const pchBuilds = new Map<string, Promise<string | undefined>>();
let bufferSequence = 0;

/** Build (or reuse) the prefix PCH; keyed on clang binary + args + prefix content. */
export async function ensurePrefixPch(
  clang: string,
  prefixPath: string,
  shared: string[],
): Promise<string | undefined> {
  const pchPath = pchPathFor(prefixPath);
  const pchSourcePath = pchSourcePathFor(prefixPath);
  const keyPath = `${pchPath}.key`;

  let prefixText: string;
  try {
    prefixText = readFileSync(prefixPath, "utf8");
  } catch {
    return undefined;
  }
  const version = clangVersions.get(clang) ?? clang;
  const key = pchKey(`${clang}\0${version}`, prefixText, shared);

  try {
    if (existsSync(pchPath) && readFileSync(keyPath, "utf8") === key) return pchPath;
  } catch {}

  const inFlight = pchBuilds.get(pchPath);
  if (inFlight) return inFlight;

  const build = (async () => {
    try {
      writeFileSync(pchSourcePath, prefixText);
    } catch {
      pchBuilds.delete(pchPath);
      return undefined;
    }
    await run(clang, [...shared, "-o", pchPath, "-x", "c++-header", pchSourcePath], 30000);
    pchBuilds.delete(pchPath);
    if (!existsSync(pchPath)) return undefined;
    try {
      writeFileSync(keyPath, key);
    } catch {}
    return pchPath;
  })();
  pchBuilds.set(pchPath, build);
  return build;
}

/** clang's `COMPLETION:` lines -> items; `Pattern` rows and reserved names are dropped. */
export function parseCompletions(stdout: string): FallbackItem[] {
  const items: FallbackItem[] = [];
  for (const line of stdout.split("\n")) {
    const match = COMPLETION_LINE.exec(line.trim());
    if (!match) continue;

    const label = match[1];
    const meta = match[2] ?? "";
    if (label === "Pattern" || label.startsWith("_")) continue;

    const resultType = RESULT_TYPE.exec(meta)?.[1];
    const signature = meta.replace(RESULT_TYPE, "").replace(/<#|#>/g, "");
    const detail = resultType
      ? `${resultType} ${signature}`.trim()
      : signature.trim() || undefined;
    items.push({ label, detail, kind: signature.includes("(") ? "method" : "field" });
  }
  return items;
}

export interface FallbackRequest {
  prefixPath: string;
  contractPath: string;
  bufferText: string;
  /** 0-based cursor position, VS Code convention (character in UTF-16 units). */
  line: number;
  character: number;
}

/** Completion at the cursor via a clang subprocess; undefined when unavailable or empty. */
export async function memberFallbackCompletions(
  request: FallbackRequest,
): Promise<FallbackItem[] | undefined> {
  const clang = await findClang();
  if (!clang) return undefined;

  const entry = compileEntryFor(request.prefixPath, request.contractPath);
  if (!entry) return undefined;
  const split = splitCompileArgs(entry.args, request.prefixPath);
  if (!split) return undefined;
  const shared = [...split.shared, ...cxxIncludeArgs(split.shared)];

  const pch = await ensurePrefixPch(clang, request.prefixPath, shared);
  if (!pch) return undefined;

  // The live buffer is unsaved, so completion runs on a copy beside the DB, not the file on disk.
  // Typing outruns the subprocess, so each request gets its own copy rather than sharing one path.
  const bufferCopy = join(
    dirname(request.prefixPath),
    `.complete-buffer.${process.pid}.${++bufferSequence}.h`,
  );
  try {
    writeFileSync(bufferCopy, request.bufferText);
  } catch {
    return undefined;
  }

  // clang wants 1-based line:column with the column counted in bytes.
  const lineText = request.bufferText.split("\n")[request.line] ?? "";
  const column = Buffer.byteLength(lineText.slice(0, request.character), "utf8") + 1;
  const completionAt = `${bufferCopy.replace(/\\/g, "/")}:${request.line + 1}:${column}`;

  const result = await run(
    clang,
    [
      ...shared,
      "-fsyntax-only",
      "-include-pch",
      pch,
      "-I",
      dirname(request.contractPath),
      "-Xclang",
      `-code-completion-at=${completionAt}`,
      "-x",
      "c++",
      bufferCopy,
    ],
    5000,
  );

  try {
    rmSync(bufferCopy, { force: true });
  } catch {}

  const items = parseCompletions(result.stdout);
  return items.length > 0 ? items : undefined;
}
