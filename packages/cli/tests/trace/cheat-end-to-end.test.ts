// The whole chain in one test: compile a contract that prints, run it, and read back the line the dev
// wrote. The unit tests either stop at the wire or start from synthetic records; this is what proves
// the two halves actually meet — including through the IDL file a deploy leaves behind, which is what
// `qinit call` really reads.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { compileContractWithTypeScript } from "@qinit/compiler/browser";
import { QubicSimulator } from "@qinit/engine";
import { initK12 } from "@qinit/engine/support/k12";
import type { DebugEntry } from "@qinit/core";
import type { ContractIdl } from "@qinit/proto/contract-idl";
import { CORE_PATH, HAS_CORE, HAS_WASI } from "../../../../test-utils/paths";
import { loadWasmFixture, loadWasmFixtureIdl, wasmFixtureManifest, type WasmFixtureName } from "../../../../test-utils/wasm-fixtures";
import { contractIdlForSlot, loadContractIdlFile, saveContractIdl } from "../../src/contracts/idl-file";
import { describeTrace } from "../../src/trace/format";

const GET = 1;
const PUT = 1;
const ADD = 1;

const REPORTED_LINES = ["Counter is 0", "Counter is 2 after adding 2", "input={}", "output=0"];

// Put_input { ABC abc; sint32 neg; bit flag; }: a = 5, b = 7, neg = -3, flag set.
function putInput(): Uint8Array {
    const input = new Uint8Array(24);
    const view = new DataView(input.buffer);

    view.setBigUint64(0, 5n, true);
    view.setUint16(8, 7, true);
    view.setInt32(16, -3, true);
    input[20] = 1;

    return input;
}

async function deployed(wasm: Uint8Array): Promise<QubicSimulator> {
    await initK12();
    const sim = new QubicSimulator();
    sim.setDebug(true);
    sim.deploy(28, wasm);

    return sim;
}

async function printed(entry: DebugEntry, name: WasmFixtureName, idl?: ContractIdl) {
    const view = await describeTrace(entry, undefined, name, undefined, idl ?? (await loadWasmFixtureIdl(name)));

    return { lines: view.cheats.map((cheat) => cheat.line), texts: view.cheats.map((cheat) => cheat.text), logs: view.logs };
}

test("a CC_PRINT written in a contract reads back as the line the dev wrote", async () => {
    const sim = await deployed(await loadWasmFixture("Cheats"));
    sim.procedure(28, ADD, new Uint8Array(new BigUint64Array([7n]).buffer));

    const { lines, texts, logs } = await printed(sim.getTrace().entries.at(-1)!, "Cheats");

    expect(texts).toEqual(["adding 7", "total is now 7"]);
    expect(lines).toEqual([33, 36]);
    // The printed words never became a protocol log.
    expect(logs).toEqual([]);
});

test("the reported function prints all four lines, the empty input and the whole output included", async () => {
    const sim = await deployed(await loadWasmFixture("CheatShapes"));
    sim.query(28, GET);

    const { texts } = await printed(sim.getTrace().entries.at(-1)!, "CheatShapes");

    expect(texts).toEqual(REPORTED_LINES);
});

test("every argument shape reads back as its value", async () => {
    const sim = await deployed(await loadWasmFixture("CheatShapes"));
    sim.procedure(28, PUT, putInput());

    const { texts } = await printed(sim.getTrace().entries.at(-1)!, "CheatShapes");

    expect(texts[0]).toBe("input.abc={a: 5, b: 7} input.abc.b=7 input.neg=-3 input.flag=1");
    expect(texts[1]).toBe("nums [0, 0, 0, 0] second 0 item {a: 0, b: 0}");
    expect(texts[2]).toMatch(/^owner "[A-Z]{60}" caller "[A-Z]{60}"$/);
    expect(texts[3]).toStartWith("state.get().balances=");
    // An rvalue has no declared type, so it prints as the unsigned register it travelled in.
    expect(texts[4]).toBe("neg plus one 18446744073709551614");
    expect(texts[5]).toBe("flag set");
    expect(texts).toHaveLength(6);
});

test("a print past line 255 still finds its site", async () => {
    const padding = 300;
    const compiled = await compileContractWithTypeScript({
        source: "\n".repeat(padding) + wasmFixtureManifest.CheatShapes.source,
        contractName: "CheatShapes",
        slot: 28,
        arenaSizeBytes: 1024 * 1024,
    });

    expect(compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    const sim = await deployed(compiled.wasm);
    sim.query(28, GET);

    const { lines, texts } = await printed(sim.getTrace().entries.at(-1)!, "CheatShapes", compiled.idl);

    expect(texts).toEqual(REPORTED_LINES);
    expect(lines).toEqual([46, 48, 49, 50].map((line) => line + padding));
});

test("the IDL file a deploy writes carries the cheat table intact", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "qinit-cheat-idl-")), "qinit.idl.json");
    saveContractIdl(28, { ...(await loadWasmFixtureIdl("CheatShapes")), codeHash: "00" }, path);

    const parsed = contractIdlForSlot(loadContractIdlFile(path), 28, "00");
    const sim = await deployed(await loadWasmFixture("CheatShapes"));
    sim.query(28, GET);

    const { texts } = await printed(sim.getTrace().entries.at(-1)!, "CheatShapes", parsed);

    expect(texts).toEqual(REPORTED_LINES);
});

test.if(HAS_CORE && HAS_WASI)(
    "the clang build of the reported function prints the same four lines",
    async () => {
        const clang = await buildContractWithClang({
            contractPath: join(import.meta.dir, "../../../../fixtures/CheatShapes.h"),
            contractName: "CheatShapes",
            slot: 28,
            corePath: CORE_PATH,
            outDir: mkdtempSync(join(tmpdir(), "qinit-cheat-clang-")),
        });

        expect(clang.ok, clang.stderr).toBe(true);

        const sim = await deployed(new Uint8Array(await Bun.file(clang.wasmPath!).arrayBuffer()));
        sim.query(28, GET);

        const { texts } = await printed(sim.getTrace().entries.at(-1)!, "CheatShapes");

        expect(texts).toEqual(REPORTED_LINES);
    },
    120_000,
);
