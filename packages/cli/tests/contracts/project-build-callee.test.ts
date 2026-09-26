// A callee is spliced into its caller's TU, so it must compile under whatever the caller does: with the cheat shim in scope, or with its own cheats stripped.
import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CheatMode } from "@qinit/compiler";
import { HAS_WASI } from "../../../../test-utils/paths";
import { blamedContract, compileContracts, type SlottedContract } from "../../src/ops/project-build";
import { resolveContracts } from "@qinit/build";
import { assignSlots } from "@qinit/build/contracts/project-slots";

const core = process.env.QINIT_CORE?.trim();
const haveCore = !!core && existsSync(join(core, "src", "qpi", "qpi.h"));
const fixtures = resolve(import.meta.dir, "../../../../fixtures");

function project() {
    const projectRoot = mkdtempSync(join(tmpdir(), "qinit-project-callee-"));
    const contractsDir = join(projectRoot, "contracts");
    mkdirSync(contractsDir);
    copyFileSync(join(fixtures, "Counter.h"), join(contractsDir, "Counter.h"));
    copyFileSync(join(fixtures, "Proxy.h"), join(contractsDir, "Proxy.h"));

    const editCounter = (from: string, to: string) => {
        const path = join(contractsDir, "Counter.h");
        writeFileSync(path, readFileSync(path, "utf8").replace(from, to));
    };
    const build = (compiler: "clang" | "typescript", cheats: CheatMode) =>
        compileContracts({
            plan: assignSlots(
                resolveContracts({
                    projectRoot,
                    corePath: core!,
                    contractPath: join(contractsDir, "Proxy.h"),
                    contractName: "Proxy",
                }),
                { slotBase: 29, slotCount: 4 },
            ),
            core: core!,
            compiler,
            outDir: join(projectRoot, "dist"),
            cheats,
        });

    return { editCounter, build, drop: () => rmSync(projectRoot, { recursive: true, force: true }) };
}

test.skipIf(!haveCore || !HAS_WASI)(
    "a callee that prints builds inside its caller, with the shim on and with the cheats stripped",
    async () => {
        const { editCounter, build, drop } = project();
        editCounter("state.mut().counter += 1;", 'state.mut().counter += 1;\n        CC_PRINT("inc", state.get().counter);');

        try {
            for (const cheats of [CheatMode.ON, CheatMode.OFF]) {
                const outcome = await build("clang", cheats);
                expect(outcome.ok, outcome.result?.stderr).toBe(true);
                expect(outcome.contracts.map((built) => built.contract.name)).toEqual(["Counter", "Proxy"]);
            }
        } finally {
            drop();
        }
    },
    240_000,
);

test.skipIf(!haveCore)("a production build strips the callee the TypeScript backend includes too", async () => {
    const { editCounter, build, drop } = project();
    editCounter("state.mut().counter += 1;", 'state.mut().counter += 1;\n        CC_PRINT("inc", state.get().counter);');

    try {
        const outcome = await build("typescript", CheatMode.OFF);
        expect(outcome.ok, outcome.result?.stderr).toBe(true);
    } finally {
        drop();
    }
});

// a state field typed by a system contract: both compilers get the callee's declarations, so the layout is the same on each.
for (const compiler of ["clang", "typescript"] as const) {
    test.skipIf(!haveCore || !HAS_WASI)(
        `${compiler} builds a contract whose state holds a system contract's type`,
        async () => {
            const projectRoot = mkdtempSync(join(tmpdir(), "qinit-project-system-callee-"));
            const contractsDir = join(projectRoot, "contracts");
            mkdirSync(contractsDir);
            copyFileSync(join(fixtures, "SysProbe.h"), join(contractsDir, "SysProbe.h"));

            try {
                const plan = assignSlots(
                    resolveContracts({ projectRoot, corePath: core!, contractPath: join(contractsDir, "SysProbe.h"), contractName: "SysProbe" }),
                    { slotBase: 29, slotCount: 4 },
                );
                expect(plan.filter((contract) => contract.kind === "system").map((contract) => contract.name)).toEqual(["QX", "QUTIL"]);

                const outcome = await compileContracts({ plan, core: core!, compiler, outDir: join(projectRoot, "dist"), cheats: CheatMode.ON });
                expect(outcome.ok, outcome.result?.stderr).toBe(true);
                const idl = outcome.contracts.find((built) => built.contract.name === "SysProbe")?.result.idl;
                expect(idl?.dependencies).toEqual(["QX", "QUTIL"]);
                expect(idl?.state.fields.find((field) => field.name === "lastFees")?.size).toBe(12);
            } finally {
                rmSync(projectRoot, { recursive: true, force: true });
            }
        },
        240_000,
    );
}

test("the failed contract is the file clang named, not whichever was being built", () => {
    const plan = [
        { name: "Counter", stateType: "Counter", sourcePath: "/tmp/qinit-production-x/Counter.h" },
        { name: "Proxy", stateType: "Proxy", sourcePath: "/work/contracts/Proxy.h" },
    ] as SlottedContract[];

    expect(blamedContract("/work/contracts/Counter.h:24:9: error: use of undeclared identifier 'CC_PRINT'\n", plan)?.name).toBe("Counter");
    expect(blamedContract("/work/contracts/Proxy.h:31:9: fatal error: too many errors\n", plan)?.name).toBe("Proxy");
    // A diagnostic with no file, or in a header no contract owns, keeps the caller's own blame.
    expect(blamedContract("error: cannot lower 'x'", plan)).toBeUndefined();
    expect(blamedContract("/core/src/qpi/qpi.h:5:1: error: boom", plan)).toBeUndefined();
});
