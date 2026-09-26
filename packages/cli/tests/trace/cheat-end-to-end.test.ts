// The whole chain in one test: compile a contract that prints, run it, and read back the line — including through the IDL file a deploy leaves behind.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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

// every rvalue shape the typer names: the text is what the dev reads, so it has to be the same value whichever backend built the contract.
const ARITHMETIC = `
using namespace QPI;
constexpr sint32 Arith_LIMIT = 9;
struct Arith2 {};
struct Arith : public ContractBase
{
    struct StateData { uint64 total; };
    struct Get_input { sint8 a8; sint8 b8; sint32 a32; uint32 u32; sint64 a64; };
    struct Get_output { uint64 value; };

    PUBLIC_FUNCTION(Get)
    {
        CC_PRINT(-input.a32, input.a32 + input.u32, input.a32 + input.a64, input.a8 + input.b8, input.a8 << 2);
        CC_PRINT(input.a32 > 0 ? input.a32 + 1 : input.a64, input.a32 > 0 ? input.a8 : input.b8, (sint16)input.a64, (bool)input.a32, (sint64)input.a32);
        CC_PRINT(input.a32 + 1u, input.a32 + 1ll, input.a32 < input.a64, !input.a32, Arith_LIMIT + 1);
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
};`;

const ARITHMETIC_TEXTS = [
    "-input.a32=3 input.a32 + input.u32=4294967294 input.a32 + input.a64=-70003 input.a8 + input.b8=-200 input.a8 << 2=-400",
    "?=-70000 ?=-100 ?=-4464 ?=1 ?=-3",
    "input.a32 + 1=4294967294 input.a32 + 1=-2 input.a32 < input.a64=0 !input.a32=0 Arith_LIMIT + 1=10",
];

// Get_input: a8 = b8 = -100, a32 = -3, u32 = 1, a64 = -70000.
function arithmeticInput(): Uint8Array {
    const input = new Uint8Array(24);
    const view = new DataView(input.buffer);

    view.setInt8(0, -100);
    view.setInt8(1, -100);
    view.setInt32(4, -3, true);
    view.setUint32(8, 1, true);
    view.setBigInt64(16, -70000n, true);

    return input;
}

test("an arithmetic temporary reads back signed and at its own width", async () => {
    const compiled = await compileContractWithTypeScript({ source: ARITHMETIC, contractName: "Arith", slot: 28, arenaSizeBytes: 1024 * 1024 });

    expect(compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    const sim = await deployed(compiled.wasm);
    sim.query(28, GET, arithmeticInput());

    expect((await printed(sim.getTrace().entries.at(-1)!, compiled.idl!)).texts).toEqual(ARITHMETIC_TEXTS);
});

test.if(HAS_CORE && HAS_WASI)(
    "the clang build prints the same arithmetic values",
    async () => {
        const directory = mkdtempSync(join(tmpdir(), "qinit-cheat-arith-"));
        const contractPath = join(directory, "Arith.h");
        writeFileSync(contractPath, ARITHMETIC);

        const compiled = await compileContractWithTypeScript({ source: ARITHMETIC, contractName: "Arith", slot: 28, arenaSizeBytes: 1024 * 1024 });
        const clang = await buildContractWithClang({ contractPath, contractName: "Arith", slot: 28, corePath: CORE_PATH, outDir: directory });

        expect(clang.ok, clang.stderr).toBe(true);

        const sim = await deployed(new Uint8Array(await Bun.file(clang.wasmPath!).arrayBuffer()));
        sim.query(28, GET, arithmeticInput());

        expect((await printed(sim.getTrace().entries.at(-1)!, compiled.idl!)).texts).toEqual(ARITHMETIC_TEXTS);
    },
    120_000,
);

const GET = 1;
const PUT = 1;
const ADD = 1;

const REPORTED_LINES = ["Counter is 0", "Counter is 2 after adding 2", "input={}", "output=0", "state.get()"];
// The whole state under its head, in the rows `qinit state` draws: every container empty, the owner an all-zero id, and the inner HashMap its own block.
const STATE_SCALARS = [expect.stringMatching(/^counter \d+$/), expect.stringMatching(/^owner [A-Z]{60}$/), expect.stringMatching(/^inner\.value \d+$/)];
const STATE_BLOCKS = ["nums", "items", "balances", "inner.map"];

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
        scalars: view.cheats.map((cheat) => cheat.blocks?.fields.map((field) => `${field.name} ${field.value}`)),
        blocks: view.cheats.map((cheat) => cheat.blocks?.containers.map((container) => container.name)),
        rows: view.cheats.map((cheat) => cheat.blocks?.containers.map((container) => container.lines.map((line) => `${line.label} ${line.text}`.trim()))),
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

    const { texts, scalars, blocks, rows } = await printed(sim.getTrace().entries.at(-1)!, await shapesIdl());

    expect(texts).toEqual(REPORTED_LINES);
    expect(blocks).toEqual([undefined, undefined, undefined, undefined, STATE_BLOCKS]);
    expect(scalars[4]).toEqual(STATE_SCALARS);
    expect(rows[4]).toEqual([
        ["[0..3] =0 ×4 (skipped)"],
        ["[0..1] =0 ×2 (skipped)"],
        ["slots[0..3] (unoccupied ×4; skipped)"],
        ["slots[0..3] (unoccupied ×4; skipped)"],
    ]);
});

test("every argument shape reads back as its value", async () => {
    const sim = await deployed(await loadWasmFixture("CheatShapes"));
    sim.procedure(28, PUT, putInput());

    const { texts, blocks, rows } = await printed(sim.getTrace().entries.at(-1)!, await shapesIdl());

    expect(texts[0]).toBe("input.abc={a: 5, b: 7} input.abc.b=7 input.neg=-3 input.flag=1");
    expect(texts[1]).toBe("nums [0, 0, 0, 0] second 0 item {a: 0, b: 0}");
    expect(texts[2]).toMatch(/^owner [A-Z]{60} caller [A-Z]{60}$/);
    expect(texts[3]).toBe("state.get().balances");
    expect(blocks[3]).toEqual([""]);
    expect(rows[3]).toEqual([["slots[0..3] (unoccupied ×4; skipped)"]]);
    // an rvalue travels in the register, and reads back at the width and sign of its C++ type.
    expect(texts[4]).toBe("neg plus one -2");
    expect(texts[5]).toBe("flag set");
    expect(texts).toHaveLength(6);
});

test("the blocks reflect the state the print saw", async () => {
    const sim = await deployed(await loadWasmFixture("CheatShapes"));
    sim.procedure(28, PUT, putInput());
    sim.query(28, GET);

    const { scalars, rows } = await printed(sim.getTrace().entries.at(-1)!, await shapesIdl());

    expect(scalars[4]![0]).toBe("counter 5");
    // The nested HashMap took an entry, and it reads as a slot row rather than JSON.
    expect(scalars[4]![2]).toBe("inner.value 5");
    expect(rows[4]![3].filter((row) => !row.includes("unoccupied"))).toEqual(["slot[1] 5 = 7"]);
});

test("a 32 KB state arrives whole and folds to one zero run", async () => {
    const compiled = await compileContractWithTypeScript({ source: WIDE, contractName: "Wide", slot: 28, arenaSizeBytes: 1024 * 1024 });

    expect(compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    const sim = await deployed(compiled.wasm);
    sim.procedure(28, 1, new Uint8Array(new BigUint64Array([7n]).buffer));
    const entry = sim.getTrace().entries.at(-1)!;

    expect(entry.cheats.map((cheat) => cheat.size)).toEqual([4096 * 8]);

    const { texts, blocks, rows } = await printed(entry, compiled.idl!);

    expect(texts).toEqual(["state.get()"]);
    expect(blocks[0]).toEqual(["nums"]);
    expect(rows[0]).toEqual([["[0..4094] =0 ×4095 (skipped)", "[4095] 7"]]);
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
    expect(lines).toEqual([54, 56, 57, 58, 59].map((line) => line + padding));
});

test("the IDL file a deploy writes carries the cheat table intact", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "qinit-cheat-idl-")), "qinit.idl.json");
    saveContractIdl(28, { ...(await shapesIdl()), codeHash: "00" }, path);

    const parsed = contractIdlForSlot(loadContractIdlFile(path), 28, "00")!;
    const sim = await deployed(await loadWasmFixture("CheatShapes"));
    sim.query(28, GET);

    const { texts, blocks } = await printed(sim.getTrace().entries.at(-1)!, parsed);

    expect(texts).toEqual(REPORTED_LINES);
    expect(blocks[4]).toEqual(STATE_BLOCKS);
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

        const { texts, scalars, blocks } = await printed(sim.getTrace().entries.at(-1)!, await shapesIdl());

        expect(texts).toEqual(REPORTED_LINES);
        expect(blocks[4]).toEqual(STATE_BLOCKS);
        expect(scalars[4]).toEqual(STATE_SCALARS);
    },
    120_000,
);
