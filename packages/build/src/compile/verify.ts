import { existsSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cacheRoot, readCurrent } from "@qinit/core";
import { analyzeContract, stripCheatcodes } from "@qinit/compiler/analyzer";
import { buildGateViolations, type BuildGateContext } from "./build-rules";

export interface VerifyResult {
    available: boolean;
    ok: boolean;
    oracle: boolean;
    errors: string[];
    raw?: string;
    tool?: string;
}

export function resolveVerifyTool(): string | null {
    const candidates = [process.env.QINIT_VERIFY, readCurrent()?.verify, join(cacheRoot(), "tools", "contractverify")].filter(Boolean) as string[];

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    return Bun.which("contractverify");
}

// Cheatcodes are stripped before Core ever sees the file, so the verifier is shown the same thing:
// otherwise a CC_PRINT label trips the ban on string literals for code that never ships.
function concretize(source: string, name: string): string {
    return stripCheatcodes(source).replaceAll("CONTRACT_STATE2_TYPE", `${name}2`).replaceAll("CONTRACT_STATE_TYPE", name);
}

// The protocol gate every build runs, whichever backend compiles afterwards. A skipped run reads as an
// unavailable verifier, which is what the build result reports either way. The source is concretized
// with the state type, which is what core's CONTRACT_STATE_TYPE macro expands to.
export async function verifyForBuild(options: {
    contractPath: string;
    stateType: string;
    calleeNames: readonly string[];
    skipVerify?: boolean;
}): Promise<VerifyResult> {
    if (options.skipVerify) {
        return { available: false, ok: true, oracle: false, errors: [] };
    }

    return verifyContract(options.contractPath, options.stateType, { allowedPrefixes: [...options.calleeNames] });
}

// A rejection in the build result's own shape, so neither backend needs a second error path.
export function verifyRejection(verify: VerifyResult): { ok: false; verify: VerifyResult; stderr: string } | null {
    if (!verify.available || verify.ok) {
        return null;
    }

    return {
        ok: false,
        verify,
        stderr: ["Qubic protocol violations:", ...verify.errors.map((error) => "  • " + error)].join("\n"),
    };
}

// With `buildRules`, Qinit's own build gate (build-rules.ts) is evaluated on the file first and its findings lead the
// error list, whether or not the external verifier is available. Builds do not pass it: their gate already ran.
export async function verifyContract(
    file: string,
    name: string,
    options?: { oracle?: boolean; allowedPrefixes?: string[]; buildRules?: BuildGateContext },
): Promise<VerifyResult> {
    const gate = options?.buildRules ? buildGateViolations(analyzeContract({ source: readFileSync(file, "utf8"), contractName: name }).diagnostics, options.buildRules) : [];
    const result = await verifyWithTool(file, name, options);
    return gate.length ? { ...result, ok: false, errors: [...gate, ...result.errors] } : result;
}

async function verifyWithTool(file: string, name: string, options?: { oracle?: boolean; allowedPrefixes?: string[] }): Promise<VerifyResult> {
    const tool = resolveVerifyTool();
    const oracle = !!options?.oracle || /oracle_interface/i.test(file);

    if (!tool) {
        return { available: false, ok: true, oracle, errors: [] };
    }

    let target = file;
    let temporaryFile: string | undefined;

    if (!oracle) {
        temporaryFile = join(tmpdir(), `qinit-verify-${name}-${process.pid}.h`);
        writeFileSync(temporaryFile, concretize(readFileSync(file, "utf8"), name));
        target = temporaryFile;
    }

    let stdout: string;
    let stderr: string;
    let exitCode: number | null;
    try {
        const child = Bun.spawn([tool, ...(oracle ? ["--oi", target] : [target])], {
            stdout: "pipe",
            stderr: "pipe",
        });
        [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
        await child.exited;
        exitCode = child.exitCode;
    } finally {
        // only the verifier's input; nothing reads it afterwards.
        if (temporaryFile) {
            try {
                unlinkSync(temporaryFile);
            } catch {}
        }
    }

    // the verifier reports the temp copy it was handed; name the file the developer actually wrote.
    const raw = (stdout + stderr).trim().split(target).join(file);
    const allowedPrefixes = options?.allowedPrefixes ?? [];
    const isAllowed = (message: string) => allowedPrefixes.some((prefix) => message === `Scope resolution with prefix ${prefix} is not allowed.`);

    // contractverify prints the location (`... found at line#N`, the source line, a caret) before the
    // summary and marks only the summary with `[ ERROR ]`, so attach the preceding lines to it.
    const lines = raw.split("\n");
    const allErrors: string[] = [];
    let pending: string[] = [];
    for (const line of lines) {
        if (!line.includes("[ ERROR ]")) {
            if (line.trim()) {
                pending.push(line);
            }
            continue;
        }
        const summary = line.replace(/.*\[ ERROR \]\s*/, "").trim();
        allErrors.push(pending.length ? [summary, ...pending].join("\n") : summary);
        pending = [];
    }

    const errors = allErrors.filter((error) => !isAllowed(error.split("\n")[0]));
    const dropped = allErrors.length - errors.length;

    if (exitCode !== 0 && allErrors.length === 0) {
        return { available: false, ok: true, oracle, errors: [], raw, tool };
    }

    const ok = exitCode === 0 || (dropped > 0 && errors.length === 0);

    return { available: true, ok, oracle, errors, raw, tool };
}
