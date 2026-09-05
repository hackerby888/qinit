// A callee's prints belong in the caller's stream where they ran, tagged with the contract that made
// them: a stream that merely lists every frame's prints one frame after another hides the execution path.
import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { QubicSimulator } from "@qinit/engine";
import { initK12 } from "@qinit/engine/support/k12";
import { buildContractWithTypeScript } from "@qinit/build";
import { describeTrace, mergePrints, type DecodedCheat } from "../../src/trace/format";

const core = process.env.QINIT_CORE?.trim();
const haveCore = !!core && existsSync(join(core, "src", "qpi", "qpi.h"));
const fixtures = resolve(import.meta.dir, "../../../../fixtures");

const line = (text: string, ord?: number): DecodedCheat => ({ line: 1, text, ...(ord === undefined ? {} : { ord }) });

test("prints from every frame interleave by ordinal, tagged only when more than one contract printed", () => {
    const merged = mergePrints([
        { contract: "Proxy", cheats: [line("before", 1), line("after", 4)] },
        { contract: "Counter", cheats: [line("inc", 3)] },
    ]);
    expect(merged.map((cheat) => `${cheat.contract}:${cheat.text}`)).toEqual(["Proxy:before", "Counter:inc", "Proxy:after"]);

    // A callee that printed nothing leaves the caller's lines as they were, contract tag included.
    expect(
        mergePrints([
            { contract: "Proxy", cheats: [line("only", 1)] },
            { contract: "Counter", cheats: [] },
        ]),
    ).toEqual([line("only", 1)]);
    // A node that sends no ordinal cannot be interleaved; the frames stay in the order given.
    const untagged = mergePrints([
        { contract: "Proxy", cheats: [line("before"), line("after")] },
        { contract: "Counter", cheats: [line("inc", 2)] },
    ]);
    expect(untagged.map((cheat) => cheat.text)).toEqual(["before", "after", "inc"]);
});

test.skipIf(!haveCore)(
    "a callee's print appears between the caller's two prints, on the simulator",
    async () => {
        const dir = mkdtempSync(join(tmpdir(), "qinit-print-stream-"));
        const counterPath = join(dir, "Counter.h");
        const proxyPath = join(dir, "Proxy.h");
        copyFileSync(join(fixtures, "Counter.h"), counterPath);
        writeFileSync(
            counterPath,
            readFileSync(counterPath, "utf8").replace("state.mut().counter += 1;", 'state.mut().counter += 1;\n        CC_PRINT("inc", state.get().counter);'),
        );
        writeFileSync(
            proxyPath,
            readFileSync(join(fixtures, "Proxy.h"), "utf8").replace(
                "INVOKE_OTHER_CONTRACT_PROCEDURE(Counter, Inc, locals.ii, locals.io, 0);",
                'CC_PRINT("before");\n        INVOKE_OTHER_CONTRACT_PROCEDURE(Counter, Inc, locals.ii, locals.io, 0);\n        CC_PRINT("after");',
            ),
        );

        try {
            const options = { corePath: core!, outDir: join(dir, "out") };
            const counter = await buildContractWithTypeScript({ ...options, contractPath: counterPath, contractName: "Counter", slot: 28 });
            const proxy = await buildContractWithTypeScript({
                ...options,
                contractPath: proxyPath,
                contractName: "Proxy",
                slot: 29,
                dynCallees: { Counter: { header: counterPath, slot: 28 } },
            });
            expect(counter.ok, counter.stderr).toBe(true);
            expect(proxy.ok, proxy.stderr).toBe(true);

            await initK12();
            const sim = new QubicSimulator();
            sim.setDebug(true);
            sim.deploy(28, new Uint8Array(readFileSync(counter.wasmPath!)));
            sim.deploy(29, new Uint8Array(readFileSync(proxy.wasmPath!)));
            sim.procedure(29, 1);

            const entries = sim.getTrace().entries;
            const parent = entries.filter((entry) => entry.index === 29 && entry.kind === 1).pop()!;
            const children = entries.filter((entry) => entry.seq < parent.seq && entry.cheats.length);
            expect(children.map((entry) => entry.index)).toEqual([28]);

            const frames = [
                { contract: "Proxy", cheats: (await describeTrace(parent, undefined, "Proxy", undefined, proxy.idl)).cheats },
                { contract: "Counter", cheats: (await describeTrace(children[0], undefined, "Counter", undefined, counter.idl)).cheats },
            ];
            expect(mergePrints(frames).map((cheat) => `${cheat.contract}:${cheat.text}`)).toEqual(["Proxy:before", "Counter:inc 1", "Proxy:after"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    },
    120_000,
);
