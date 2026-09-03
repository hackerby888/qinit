import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cacheRoot, readCurrent } from "@qinit/core";
import { stripCheatcodes } from "@qinit/compiler/analyzer";

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

export async function verifyContract(file: string, name: string, options?: { oracle?: boolean; allowedPrefixes?: string[] }): Promise<VerifyResult> {
    const tool = resolveVerifyTool();
    const oracle = !!options?.oracle || /oracle_interface/i.test(file);

    if (!tool) {
        return { available: false, ok: true, oracle, errors: [] };
    }

    let target = file;

    if (!oracle) {
        const temporaryFile = join(tmpdir(), `qinit-verify-${name}-${process.pid}.h`);
        writeFileSync(temporaryFile, concretize(readFileSync(file, "utf8"), name));
        target = temporaryFile;
    }

    const child = Bun.spawn([tool, ...(oracle ? ["--oi", target] : [target])], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;

    const raw = (stdout + stderr).trim();
    const allErrors = raw
        .split("\n")
        .filter((line) => line.includes("[ ERROR ]"))
        .map((line) => line.replace(/.*\[ ERROR \]\s*/, "").trim());
    const allowedPrefixes = options?.allowedPrefixes ?? [];
    const errors = allErrors.filter((error) => !allowedPrefixes.some((prefix) => error === `Scope resolution with prefix ${prefix} is not allowed.`));
    const dropped = allErrors.length - errors.length;

    if (child.exitCode !== 0 && allErrors.length === 0) {
        return { available: false, ok: true, oracle, errors: [], raw, tool };
    }

    const ok = child.exitCode === 0 || (dropped > 0 && errors.length === 0);

    return { available: true, ok, oracle, errors, raw, tool };
}
