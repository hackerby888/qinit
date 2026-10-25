// a contract whose file, qinit.json name and struct differ once built with typescript and failed with clang; the struct is read from the header and the qinit.json name is the deploy name.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CORE_PATH, HAS_CORE, HAS_WASI } from "../../../../test-utils/paths";

const cli = resolve(import.meta.dir, "../../src/index.tsx");

async function build(cwd: string, compiler: string) {
    const child = Bun.spawn([process.execPath, cli, "build", "--compiler", compiler, "--core-dir", CORE_PATH, "--rpc", "http://127.0.0.1:1", "--json"], {
        cwd,
        env: { ...process.env, QINIT_NO_UPDATE: "1", CI: "true" },
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return JSON.parse(stdout.trim().split("\n").pop()!);
}

function project(config: object): string {
    const cwd = mkdtempSync(join(tmpdir(), "qinit-contract-name-"));
    mkdirSync(join(cwd, "contracts"));
    const counter = readFileSync(resolve(import.meta.dir, "../../../../fixtures/Counter.h"), "utf8").replace(/\bCounter/g, "CounterV2");
    writeFileSync(join(cwd, "contracts", "MyCounter.h"), counter);
    writeFileSync(join(cwd, "qinit.json"), JSON.stringify({ contract: "contracts/MyCounter.h", ...config }));
    return cwd;
}

test.skipIf(!HAS_CORE)(
    "both compilers build a contract under its struct name, whatever its file is called",
    async () => {
        const cwd = project({});
        try {
            for (const compiler of HAS_WASI ? ["typescript", "clang"] : ["typescript"]) {
                const result = await build(cwd, compiler);
                expect(result.ok, `${compiler}: ${result.error}`).toBe(true);
                expect(result.idl?.name, compiler).toBe("CounterV2");
                expect(result.artifact, compiler).toEndWith("CounterV2.wasm");
            }
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    },
    120_000,
);

// a copy of a core header keeps its struct and every prefixed global; the qinit.json name is what it deploys as.
test.skipIf(!HAS_CORE)(
    "a qinit.json name that differs from the struct is the deploy name on both compilers",
    async () => {
        const cwd = project({ contractName: "Counter" });
        try {
            for (const compiler of HAS_WASI ? ["typescript", "clang"] : ["typescript"]) {
                const result = await build(cwd, compiler);
                expect(result.ok, `${compiler}: ${result.error}`).toBe(true);
                expect(result.idl?.name, compiler).toBe("Counter");
                expect(result.artifact, compiler).toEndWith("Counter.wasm");
            }
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    },
    120_000,
);
