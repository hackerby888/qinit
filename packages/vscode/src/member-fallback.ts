// clangd completes nothing for members reached through a field whose preamble-defined type holds a
// template member (upstream bug, clangd 17-22). Raw clang's -code-completion-at answers it, so an
// empty member list is re-asked of a real clang++ against a PCH built from the same prefix header.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { wasiSdkPaths } from "@qinit/core/cache/wasi-sdk";

export interface FallbackItem {
    /** The typed text: what filtering matches and what gets inserted. */
    name: string;
    /** One entry per parameter, e.g. `uint64 indexBegin`, each a snippet placeholder. */
    placeholders: string[];
    returnType?: string;
    /** Trailing qualifiers clang reports separately, e.g. `const`. */
    qualifiers?: string;
    kind: "field" | "method";
}

const COMPLETION_LINE = /^COMPLETION: (.+)$/;
const RESULT_TYPE = /^\[#(.*?)#\]/;
// Chunks clang appends after the signature, e.g. `get(<#uint64 index#>)[# const#]`.
const TRAILING_INFORMATIVE = /\[#(.*?)#\]\s*$/;
// Default arguments, which the author does not type.
const OPTIONAL_CHUNK = /\{#.*?#\}/g;
const PLACEHOLDER = /<#(.*?)#>/g;
const AVAILABILITY = /\s*\((?:Inaccessible|Hidden|Unavailable|NotAccessible|Deprecated)\)/g;

export interface Cancellable {
    isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
}

function run(
    command: string,
    args: string[],
    timeoutMs: number,
    cancel?: Cancellable,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise((resolvePromise) => {
        const child = execFile(
            command,
            args,
            { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
            (error, stdout, stderr) => {
                subscription?.dispose();
                // clang exits non-zero when the buffer has parse errors, but completions still stream out.
                resolvePromise({
                    ok: !error || stdout.length > 0,
                    stdout: stdout ?? "",
                    stderr: stderr ?? "",
                });
            },
        );
        // Typing outruns the process: an abandoned request must not keep a clang alive.
        const subscription = cancel?.onCancellationRequested(() => child.kill());
        if (cancel?.isCancellationRequested) child.kill();
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
    const sysroot = shared.find((arg) => arg.startsWith("--sysroot="))?.slice("--sysroot=".length);
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

const QUOTED_INCLUDE = /^[ \t]*#[ \t]*include[ \t]+"([^"]+)"/gm;

// Editing a callee leaves the prefix text unchanged, so its size and mtime join the key: a saved
// callee then rebuilds the PCH before the next completion instead of during one.
function includedFileStamps(prefixText: string): string[] {
    const stamps: string[] = [];
    for (const [, spec] of prefixText.matchAll(QUOTED_INCLUDE)) {
        try {
            const stats = statSync(spec);
            stamps.push(`${spec}:${stats.size}:${stats.mtimeMs}`);
        } catch {
            // Relative to an include path rather than the workspace: clang's staleness report covers it.
        }
    }
    return stamps;
}

function pchKey(clang: string, prefixText: string, shared: string[]): string {
    return createHash("sha256")
        .update(clang)
        .update("\0")
        .update(shared.join("\0"))
        .update("\0")
        .update(prefixText)
        .update("\0")
        .update(includedFileStamps(prefixText).join("\0"))
        .digest("hex");
}

const pchBuilds = new Map<string, Promise<string | undefined>>();
const lastForcedRebuild = new Map<string, number>();
let bufferSequence = 0;

// clang truncates the buffer at the completion point, so the answer only depends on the text before it:
// re-asking the same member expression reuses the last result instead of spawning clang again.
const lastCompletion = new Map<string, { key: string; items: FallbackItem[] }>();
let completionRuns = 0;

export function completionRunsForTests(): number {
    return completionRuns;
}

// Dependencies the key cannot see (core headers, the sysroot) still invalidate the PCH, and clang
// names the stale file — its report is the signal, not a dependency list we would have to guess.
const STALE_PCH = /has been modified since the precompiled header|please rebuild precompiled file/;

// A PCH that stays stale after a rebuild must not cost a rebuild per keystroke.
const FORCED_REBUILD_COOLDOWN_MS = 5000;

function invalidatePch(prefixPath: string): boolean {
    const pchPath = pchPathFor(prefixPath);
    const previous = lastForcedRebuild.get(pchPath) ?? 0;
    if (Date.now() - previous < FORCED_REBUILD_COOLDOWN_MS) return false;

    lastForcedRebuild.set(pchPath, Date.now());
    try {
        rmSync(`${pchPath}.key`, { force: true });
    } catch {
        return false;
    }
    return true;
}

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

// The chunks behind a name: `[#uint64#]setRange(<#uint64 index#>, {#uint64 count#})[# const#]`.
function parseMeta(name: string, meta: string): FallbackItem {
    let rest = meta.replace(OPTIONAL_CHUNK, "");

    const result = RESULT_TYPE.exec(rest);
    if (result) rest = rest.slice(result[0].length);

    const informative = TRAILING_INFORMATIVE.exec(rest);
    if (informative) rest = rest.slice(0, informative.index);

    const open = rest.indexOf("(");
    const close = rest.lastIndexOf(")");
    if (open < 0 || close < open) {
        return { name, placeholders: [], returnType: result?.[1], kind: "field" };
    }

    const parameters = rest.slice(open + 1, close);
    return {
        name,
        placeholders: [...parameters.matchAll(PLACEHOLDER)].map((match) => match[1]),
        returnType: result?.[1],
        qualifiers: informative?.[1].trim(),
        kind: "method",
    };
}

/** clang's `COMPLETION:` lines -> items; patterns and unreachable members are dropped. */
export function parseCompletions(stdout: string): FallbackItem[] {
    const items: FallbackItem[] = [];
    for (const line of stdout.split("\n")) {
        const match = COMPLETION_LINE.exec(line.trim());
        if (!match) continue;

        const separator = match[1].indexOf(" : ");
        const declaration = separator < 0 ? match[1] : match[1].slice(0, separator);
        const meta = separator < 0 ? "" : match[1].slice(separator + 3);
        const name = declaration.replace(AVAILABILITY, "");

        // An availability marker means the member cannot be reached from here, and `Get_input::` is how
        // clang spells the injected class name — neither is something the author can write after a dot.
        if (name === "Pattern" || name !== declaration || meta === `${name}::`) continue;

        items.push(parseMeta(name, meta));
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
    cancel?: Cancellable;
}

function offsetOf(text: string, line: number, character: number): number {
    let offset = 0;
    for (let index = 0; index < line; index++) {
        const newline = text.indexOf("\n", offset);
        if (newline < 0) return text.length;
        offset = newline + 1;
    }
    return Math.min(offset + character, text.length);
}

// A rebuilt PCH answers differently, so its mtime joins the text the completion point sits behind.
function completionKey(request: FallbackRequest, pch: string): string {
    const offset = offsetOf(request.bufferText, request.line, request.character);
    let stamp = "";
    try {
        stamp = String(statSync(pch).mtimeMs);
    } catch {}

    return createHash("sha256")
        .update(pch)
        .update("\0")
        .update(stamp)
        .update("\0")
        .update(String(offset))
        .update("\0")
        .update(request.bufferText.slice(0, offset))
        .digest("hex");
}

async function completeOnce(
    clang: string,
    request: FallbackRequest,
    shared: string[],
    pch: string,
): Promise<{ items: FallbackItem[]; stalePch: boolean }> {
    completionRuns++;
    // The live buffer is unsaved, so completion runs on a copy beside the DB, not the file on disk.
    // Typing outruns the subprocess, so each request gets its own copy rather than sharing one path.
    const bufferCopy = join(
        dirname(request.prefixPath),
        `.complete-buffer.${process.pid}.${++bufferSequence}.h`,
    );
    try {
        writeFileSync(bufferCopy, request.bufferText);
    } catch {
        return { items: [], stalePch: false };
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
        request.cancel,
    );

    try {
        rmSync(bufferCopy, { force: true });
    } catch {}

    return { items: parseCompletions(result.stdout), stalePch: STALE_PCH.test(result.stderr) };
}

async function resolveRun(
    prefixPath: string,
    contractPath: string,
): Promise<{ clang: string; shared: string[] } | undefined> {
    const clang = await findClang();
    if (!clang) return undefined;

    const entry = compileEntryFor(prefixPath, contractPath);
    if (!entry) return undefined;
    const split = splitCompileArgs(entry.args, prefixPath);
    if (!split) return undefined;

    return { clang, shared: [...split.shared, ...cxxIncludeArgs(split.shared)] };
}

/** Build the PCH ahead of the first completion, so typing never waits for it. */
export async function prewarmPch(prefixPath: string, contractPath: string): Promise<void> {
    const resolved = await resolveRun(prefixPath, contractPath);
    if (!resolved) return;
    await ensurePrefixPch(resolved.clang, prefixPath, resolved.shared);
}

/** Completion at the cursor via a clang subprocess; undefined when unavailable or empty. */
export async function memberFallbackCompletions(
    request: FallbackRequest,
): Promise<FallbackItem[] | undefined> {
    const resolved = await resolveRun(request.prefixPath, request.contractPath);
    if (!resolved) return undefined;
    const { clang, shared } = resolved;

    const pch = await ensurePrefixPch(clang, request.prefixPath, shared);
    if (!pch) return undefined;

    let key = completionKey(request, pch);
    const cached = lastCompletion.get(request.contractPath);
    if (cached?.key === key) {
        return cached.items.length > 0 ? cached.items : undefined;
    }

    let attempt = await completeOnce(clang, request, shared, pch);

    // A dependency of the PCH moved (a callee header, qpi.h, the sysroot). Rebuild and ask again.
    if (attempt.stalePch && invalidatePch(request.prefixPath)) {
        const rebuilt = await ensurePrefixPch(clang, request.prefixPath, shared);
        if (!rebuilt) return undefined;
        attempt = await completeOnce(clang, request, shared, rebuilt);
        key = completionKey(request, rebuilt);
    }

    // Even an empty struct answers with its operators and destructor, so nothing back means the run was
    // cancelled or died — caching that would answer every later request at this dot with silence.
    if (attempt.items.length === 0) return undefined;

    lastCompletion.set(request.contractPath, { key, items: attempt.items });
    return attempt.items;
}
