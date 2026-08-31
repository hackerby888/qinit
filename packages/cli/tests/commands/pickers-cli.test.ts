import { expect, test } from "bun:test";
import { join } from "node:path";

const cli = join(import.meta.dir, "../../src/index.tsx");

// Bun.spawn leaves stdin closed, which is the non-TTY shape that used to leave the pickers waiting forever.
async function run(...args: string[]) {
    const child = Bun.spawn([process.execPath, cli, ...args], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return {
        code: child.exitCode,
        stdout,
        stderr,
    };
}

// Neither case reaches a save, so running these leaves the developer's own config untouched.
const PICKERS = ["theme", "runtime", "compiler"];

test("a picker refuses to prompt without a terminal instead of waiting on input that never comes", async () => {
    for (const command of PICKERS) {
        const result = await run(command);

        expect(result.code).toBe(1);
        expect(result.stdout).toContain("no terminal to pick in");
        expect(result.stderr).toBe("");
    }
});

test("a picker reports an unknown name with a failing exit status", async () => {
    for (const command of PICKERS) {
        const result = await run(command, "bogus");

        expect(result.code).toBe(1);
        expect(result.stdout).toContain("✗ unknown");
        expect(result.stdout).toContain("bogus");
    }
});

// The wizard's own useInput asks ink for raw mode as soon as it mounts, so the refusal has to come first
// — otherwise the user reads ink's "Raw mode is not supported" instead of the two flags that would work.
test("the call wizard refuses to mount without a terminal and names the flags instead", async () => {
    const result = await run("call");

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("call needs --fn or --proc without a terminal");
    expect(result.stdout).not.toContain("Raw mode");
});
