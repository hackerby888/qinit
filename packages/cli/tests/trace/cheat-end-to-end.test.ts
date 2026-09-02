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
import { loadWasmFixture, loadWasmFixtureIdl, wasmFixtureManifest } from "../../../../test-utils/wasm-fixtures";
import { contractIdlForSlot, loadContractIdlFile, saveContractIdl } from "../../src/contracts/idl-file";
import { describeTrace } from "../../src/trace/format";

const GET = 1;
const PUT = 1;
const ADD = 1;

const REPORTED_LINES = ["Counter is 0", "Counter is 2 after adding 2", "input={}", "output=0", "state.get()"];
// The whole state under its head, in the rows `qinit state` draws: every container empty, the owner an all-zero id.
const STATE_BLOCK = [
    "counter 0",
    "nums [0..3] =0 ×4 (skipped)",
    "items [0..1] =0 ×2 (skipped)",
    expect.stringMatching(/^owner "[A-Z]{60}"$/),
    "balances slots[0..3] (unoccupied ×4; skipped)",
];

// A state large enough that no single line could hold it, printed whole.
const WIDE = `
using namespace QPI;
struct Wide2 {};
struct Wide : public ContractBase
{
    struct StateData { Array<uint64, 4096> nums; };
    struct Poke_input { uint64 value; };
    struct Poke_output {};

    PUBLIC_PROCEDURE(Poke)
    {
        state.mut().nums.set(4095, input.value);
        CC_PRINT(state.get());
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Poke, 1); }
};`;

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

const shapesIdl = () => loadWasmFixtureIdl("CheatShapes");

async function printed(entry: DebugEntry, idl: ContractIdl) {
    const view = await describeTrace(entry, undefined, idl.name, undefined, idl);

    return {
        lines: view.cheats.map((cheat) => cheat.line),
        texts: view.cheats.map((cheat) => cheat.text),
        blocks: view.cheats.map((cheat) => cheat.block?.map((line) => `${line.label} ${line.text}`.trim())),
        logs: view.logs,
    };
}

test("a CC_PRINT written in a contract reads back as the line the dev wrote", async () => {
    const sim = await deployed(await loadWasmFixture("Cheats"));
    sim.procedure(28, ADD, new Uint8Array(new BigUint64Array([7n]).buffer));

    const { lines, texts, logs } = await printed(sim.getTrace().entries.at(-1)!, await loadWasmFixtureIdl("Cheats"));

    expect(texts).toEqual(["adding 7", "total is now 7"]);
    expect(lines).toEqual([33, 36]);
    // The printed words never became a protocol log.
    expect(logs).toEqual([]);
});

test("the reported function prints all five lines, the whole state as a block", async () => {
    const sim = await deployed(await loadWasmFixture("CheatShapes"));
    sim.query(28, GET);

    const { texts, blocks } = await printed(sim.getTrace().entries.at(-1)!, await shapesIdl());

    expect(texts).toEqual(REPORTED_LINES);
    expect(blocks).toEqual([undefined, undefined, undefined, undefined, STATE_BLOCK]);
});

test("every argument shape reads back as its value", async () => {
    const sim = await deployed(await loadWasmFixture("CheatShapes"));
    sim.procedure(28, PUT, putInput());

    const { texts, blocks } = await printed(sim.getTrace().entries.at(-1)!, await shapesIdl());

    expect(texts[0]).toBe("input.abc={a: 5, b: 7} input.abc.b=7 input.neg=-3 input.flag=1");
    expect(texts[1]).toBe("nums [0, 0, 0, 0] second 0 item {a: 0, b: 0}");
    expect(texts[2]).toMatch(/^owner "[A-Z]{60}" caller "[A-Z]{60}"$/);
    expect(texts[3]).toBe("state.get().balances");
    expect(blocks[3]).toEqual(["slots[0..3] (unoccupied ×4; skipped)"]);
    // An rvalue has no declared type, so it prints as the unsigned register it travelled in.
    expect(texts[4]).toBe("neg plus one 18446744073709551614");
    expect(texts[5]).toBe("flag set");
    expect(texts).toHaveLength(6);
});

test("the block reflects the state the print saw", async () => {
    const sim = await deployed(await loadWasmFixture("CheatShapes"));
    sim.procedure(28, PUT, putInput());
    sim.query(28, GET);

    const { blocks } = await printed(sim.getTrace().entries.at(-1)!, await shapesIdl());

    expect(blocks[4]![0]).toBe("counter 5");
});

test("a 32 KB state arrives whole and folds to one zero run", async () => {
    const compiled = await compileContractWithTypeScript({ source: WIDE, contractName: "Wide", slot: 28, arenaSizeBytes: 1024 * 1024 });

    expect(compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    const sim = await deployed(compiled.wasm);
    sim.procedure(28, 1, new Uint8Array(new BigUint64Array([7n]).buffer));
    const entry = sim.getTrace().entries.at(-1)!;

    expect(entry.cheats.map((cheat) => cheat.size)).toEqual([4096 * 8]);

    const { texts, blocks } = await printed(entry, compiled.idl!);

    expect(texts).toEqual(["state.get()"]);
    expect(blocks[0]).toEqual(["nums [0..4094] =0 ×4095 (skipped)", "[4095] 7"]);
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

    const { lines, texts } = await printed(sim.getTrace().entries.at(-1)!, compiled.idl!);

    expect(texts).toEqual(REPORTED_LINES);
    expect(lines).toEqual([46, 48, 49, 50, 51].map((line) => line + padding));
});

test("the IDL file a deploy writes carries the cheat table intact", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "qinit-cheat-idl-")), "qinit.idl.json");
    saveContractIdl(28, { ...(await shapesIdl()), codeHash: "00" }, path);

    const parsed = contractIdlForSlot(loadContractIdlFile(path), 28, "00")!;
    const sim = await deployed(await loadWasmFixture("CheatShapes"));
    sim.query(28, GET);

    const { texts, blocks } = await printed(sim.getTrace().entries.at(-1)!, parsed);

    expect(texts).toEqual(REPORTED_LINES);
    expect(blocks[4]).toEqual(STATE_BLOCK);
});

test.if(HAS_CORE && HAS_WASI)(
    "the clang build of the reported function prints the same five lines",
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

        const { texts, blocks } = await printed(sim.getTrace().entries.at(-1)!, await shapesIdl());

        expect(texts).toEqual(REPORTED_LINES);
        expect(blocks[4]).toEqual(STATE_BLOCK);
    },
    120_000,
);
