// A callee is spliced into its caller's TU, so it has to compile under whatever the caller compiles under:
// with the cheat shim in scope, or, in a production build, with its own cheats stripped first.
import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CheatMode } from "@qinit/compiler";
import { HAS_WASI } from "../../../../test-utils/paths";
import { blamedContract, buildProjectContracts, resolveProjectPlan, type PlannedProjectContract } from "../../src/ops/project-build";

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
        buildProjectContracts({
            plan: resolveProjectPlan({
                projectRoot,
                core: core!,
                contractPath: join(contractsDir, "Proxy.h"),
                name: "Proxy",
                slotLayout: { slotBase: 29, slotCount: 4 },
            }),
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

test("the failed contract is the file clang named, not whichever was being built", () => {
    const plan = [
        { name: "Counter", stateType: "Counter", sourcePath: "/tmp/qinit-production-x/Counter.h" },
        { name: "Proxy", stateType: "Proxy", sourcePath: "/work/contracts/Proxy.h" },
    ] as PlannedProjectContract[];

    expect(blamedContract("/work/contracts/Counter.h:24:9: error: use of undeclared identifier 'CC_PRINT'\n", plan)?.name).toBe("Counter");
    expect(blamedContract("/work/contracts/Proxy.h:31:9: fatal error: too many errors\n", plan)?.name).toBe("Proxy");
    // A diagnostic with no file, or in a header no contract owns, keeps the caller's own blame.
    expect(blamedContract("error: cannot lower 'x'", plan)).toBeUndefined();
    expect(blamedContract("/core/src/qpi/qpi.h:5:1: error: boom", plan)).toBeUndefined();
});
