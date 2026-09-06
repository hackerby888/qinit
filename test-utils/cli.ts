import { rmSync } from "node:fs";
import { resolve } from "node:path";

/** The CLI entry the command tests spawn through bun itself. */
export const CLI_ENTRY = resolve(import.meta.dir, "../packages/cli/src/index.tsx");

/** A cold bun start of the CLI costs 1–3 s on Windows, so a test that spawns it several times needs more than bun's 5 s. */
export const CLI_TEST_TIMEOUT_MS = 60_000;

export interface RunCliOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
}

export interface RunCliResult {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

// Spawns the CLI with stdin closed (the non-TTY shape) and kills it on timeout, so a temp cwd is never left locked.
export async function runCli(args: string[], options: RunCliOptions = {}): Promise<RunCliResult> {
    const child = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
        cwd: options.cwd,
        env: { ...process.env, QINIT_NO_UPDATE: "1", ...options.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
    }, options.timeoutMs ?? CLI_TEST_TIMEOUT_MS - 5_000);
    try {
        const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { code: child.exitCode, stdout, stderr, timedOut };
    } finally {
        clearTimeout(timer);
    }
}

/** Windows keeps a directory busy for a moment after its last process exits; retry the removal briefly. */
export function removeDirWithRetry(dir: string, attempts = 5, delayMs = 200): void {
    for (let attempt = 1; ; attempt++) {
        try {
            rmSync(dir, { recursive: true, force: true });
            return;
        } catch (error) {
            if (attempt >= attempts) throw error;
            Bun.sleepSync(delayMs);
        }
    }
}
