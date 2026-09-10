import { expect, test } from "bun:test";
import { CLI_TEST_TIMEOUT_MS, runCli } from "../../../../test-utils/cli";

// runCli closes stdin, which is the non-TTY shape that used to leave the pickers waiting forever.
const run = (...args: string[]) => runCli(args);

// Neither case reaches a save, so running these leaves the developer's own config untouched.
const PICKERS = ["theme", "runtime", "compiler"];

test(
    "a picker refuses to prompt without a terminal instead of waiting on input that never comes",
    async () => {
        for (const command of PICKERS) {
            const result = await run(command);

            expect(result.code).toBe(1);
            expect(result.stdout).toContain("no terminal to pick in");
            expect(result.stderr).toBe("");
        }
    },
    CLI_TEST_TIMEOUT_MS,
);

test(
    "a picker reports an unknown name with a failing exit status",
    async () => {
        for (const command of PICKERS) {
            const result = await run(command, "bogus");

            expect(result.code).toBe(1);
            expect(result.stdout).toContain("✗ unknown");
            expect(result.stdout).toContain("bogus");
        }
    },
    CLI_TEST_TIMEOUT_MS,
);

// The wizard's useInput asks ink for raw mode as soon as it mounts, so the refusal must come first or the user reads ink's error instead of the two flags.
test(
    "the call wizard refuses to mount without a terminal and names the flags instead",
    async () => {
        const result = await run("call");

        expect(result.code).toBe(1);
        expect(result.stdout).toContain("call needs --fn or --proc without a terminal");
        expect(result.stdout).not.toContain("Raw mode");
    },
    CLI_TEST_TIMEOUT_MS,
);
