// The oracle E17 lacked. Static tools accept a narrowing migration, so this redeploys each shape over a
// live contract that has already stored a value and prints what the value became.
import { initK12 } from "@qinit/core";
import { QubicSimulator } from "@qinit/engine";
import { compileContractWithTypeScript, loadQpiHeader } from "@qinit/compiler";
import { analyzeContract } from "@qinit/compiler/analyzer";
import { CORE_PATH, HAS_CORE } from "../../../test-utils/paths";

if (!HAS_CORE) {
    console.error("QINIT_CORE is required");
    process.exit(2);
}
await initK12();
const headers = loadQpiHeader(CORE_PATH);
const SLOT = 28;

// Every version reports through the same four uint64, so nothing narrowed is re-widened on the way out.
const OUTPUT = "uint64 a; uint64 b; uint64 c; uint64 bIsNegative;";
const READ = "output.a = state.get().a; output.b = state.get().b; output.c = state.get().c; output.bIsNegative = (state.get().b < 0) ? 1 : 0;";
const V1_FIELDS = "uint64 a; sint64 b; uint64 c;";
const COPY_ALL = "state.mut().a = oldState.a; state.mut().b = oldState.b; state.mut().c = oldState.c;";

function contract(state: string, old: string | null, migrate: string, write: string): string {
    return `using namespace QPI;
struct MigZoo2 {};
struct MigZoo : public ContractBase
{
    struct StateData { ${state} };
    ${old === null ? "" : `struct OldStateData { ${old} };`}
    struct Set_input { uint64 a; sint64 b; uint64 c; };
    struct Set_output {};
    struct Get_input {};
    struct Get_output { ${OUTPUT} };
    PUBLIC_PROCEDURE(Set) { ${write} }
    PUBLIC_FUNCTION(Get) { ${READ} }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Set, 1); REGISTER_USER_FUNCTION(Get, 1); }
    ${migrate === "" ? "" : `MIGRATE() { ${migrate} }`}
};
`;
}

interface Probe {
    name: string;
    state: string;
    /** `null` declares no `OldStateData`, which is also the only way to declare no `MIGRATE`. */
    old: string | null;
    migrate: string;
    /** A value only this probe's `MIGRATE` writes, so the row can say whether the entry ran at all. */
    sentinel?: bigint;
}

const PROBES: Probe[] = [
    { name: "identical layout, MIGRATE", state: V1_FIELDS, old: V1_FIELDS, migrate: COPY_ALL },
    { name: "identical layout, no MIGRATE", state: V1_FIELDS, old: null, migrate: "" },
    { name: "uint64 -> uint32, MIGRATE copies it", state: "uint32 a; sint64 b; uint64 c;", old: V1_FIELDS, migrate: COPY_ALL },
    { name: "uint64 -> uint8, MIGRATE copies it", state: "uint8 a; sint64 b; uint64 c;", old: V1_FIELDS, migrate: COPY_ALL },
    { name: "sint64 -> uint64, MIGRATE copies it", state: "uint64 a; uint64 b; uint64 c;", old: V1_FIELDS, migrate: COPY_ALL },
    { name: "sint64 -> sint32, MIGRATE copies it", state: "uint64 a; sint32 b; uint64 c;", old: V1_FIELDS, migrate: COPY_ALL },
    { name: "uint64 -> uint32, NO MIGRATE", state: "uint32 a; sint64 b; uint64 c;", old: null, migrate: "" },
    { name: "a field inserted first, NO MIGRATE", state: "uint64 z; uint64 a; sint64 b; uint64 c;", old: null, migrate: "" },
    // `registry.ts:64` runs MIGRATE only when `OldStateData` is exactly the size of the state on disk, so a
    // wrong `OldStateData` is skipped rather than refused. The 777 sentinel says which path was taken.
    {
        name: "MIGRATE with a short OldStateData",
        state: V1_FIELDS,
        old: "uint64 a; sint64 b;",
        migrate: "state.mut().a = oldState.a; state.mut().b = oldState.b; state.mut().c = 777;",
        sentinel: 777n,
    },
    // The realistic form of the one above: the layout really did change, so the migration that never
    // runs is the one that mattered, and the raw copy it falls back to is the row two above.
    {
        name: "short OldStateData + changed layout",
        state: "uint64 z; uint64 a; sint64 b; uint64 c;",
        old: "uint64 a; sint64 b;",
        migrate: "state.mut().z = 0; state.mut().a = oldState.a; state.mut().b = oldState.b; state.mut().c = 777;",
        sentinel: 777n,
    },
];

async function build(source: string) {
    const editor = analyzeContract({ source, contractName: "MigZoo", slot: SLOT, qpiHeader: headers }).diagnostics;
    const result = await compileContractWithTypeScript({ source, contractName: "MigZoo", slot: SLOT, qpiHeader: headers });
    return {
        wasm: result.wasm,
        refused: result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
        editorDiagnostics: editor.filter((diagnostic) => diagnostic.severity !== "information").length,
        backendDiagnostics: result.diagnostics.length,
    };
}

// Above 2^32 so a 32-bit field cannot hold it, and negative so a signedness change is visible.
const A = (1n << 40n) + 7n;
const B = -((1n << 40n) + 12345n);
const C = 99n;
const B_BITS = BigInt.asUintN(64, B);

const input = new Uint8Array(24);
const inputView = new DataView(input.buffer);
inputView.setBigUint64(0, A, true);
inputView.setBigInt64(8, B, true);
inputView.setBigUint64(16, C, true);

const v1 = await build(contract(V1_FIELDS, null, "", "state.mut().a = input.a; state.mut().b = input.b; state.mut().c = input.c;"));
if (v1.refused.length) {
    console.error(`v1 did not build: ${v1.refused[0].message}`);
    process.exit(2);
}

console.log(`v1 stored  a = ${A}   b = ${B}   c = ${C}   and b is negative\n`);
console.log(`${"REDEPLOYED AS".padEnd(36)} ${"a".padStart(16)} ${"b".padStart(21)} ${"c".padStart(5)} ${"b<0".padStart(4)}  DIAGS`);
console.log("-".repeat(93));

let intact = 0;
const damaged: string[] = [];
const skipped: string[] = [];
for (const probe of PROBES) {
    const built = await build(contract(probe.state, probe.old, probe.migrate, "state.mut().c = input.c;"));
    if (built.refused.length) {
        console.log(`${probe.name.padEnd(36)} REFUSED — ${built.refused[0].message.slice(0, 44)}`);
        continue;
    }

    const simulator = new QubicSimulator();
    simulator.deploy(SLOT, v1.wasm);
    simulator.procedure(SLOT, 1, input);
    // So a MIGRATE that reads `qpi.tick()` sees a live one, as round 10's fixture does.
    for (let tick = 0; tick < 5; tick++) simulator.advance();

    let cells: string;
    let lost = true;
    let ranMigrate: boolean | undefined;
    try {
        simulator.deploy(SLOT, built.wasm);
        const after = simulator.query(SLOT, 1);
        const view = new DataView(after.buffer, after.byteOffset, after.byteLength);
        const [a, b, c] = [view.getBigUint64(0, true), view.getBigUint64(8, true), view.getBigUint64(16, true)];
        const negative = view.getBigUint64(24, true) === 1n;
        lost = !(a === A && b === B_BITS && c === C && negative);
        if (probe.sentinel !== undefined) {
            ranMigrate = c === probe.sentinel;
            lost = !(a === A && b === B_BITS && negative);
        }
        const mark = (ok: boolean, text: string) => `${ok ? " " : "*"}${text}`;
        cells =
            `${mark(a === A, String(a)).padStart(16)} ${mark(b === B_BITS, String(b)).padStart(21)} ` +
            `${mark(c === C, String(c)).padStart(5)} ${mark(negative, negative ? "yes" : "no").padStart(4)}`;
    } catch (cause) {
        cells = `THREW: ${cause instanceof Error ? cause.message.slice(0, 40) : ""}`.padStart(48);
    }

    if (lost) damaged.push(probe.name);
    else intact++;
    if (ranMigrate === false) skipped.push(probe.name);
    console.log(
        `${probe.name.padEnd(36)} ${cells}  ${built.editorDiagnostics}/${built.backendDiagnostics}` +
            (ranMigrate === undefined ? "" : ranMigrate ? "  MIGRATE ran" : "  MIGRATE NEVER RAN — the raw copy did"),
    );
}

console.log(`\n* = not what v1 stored · DIAGS = editor / TypeScript backend, warnings included`);
console.log(
    `${intact} of ${PROBES.length} redeploys carried the state across unchanged; ${damaged.length} changed it, none of them with a diagnostic anywhere`,
);
if (damaged.length) console.log(`changed: ${damaged.join(" · ")}`);
if (skipped.length) console.log(`written but never executed: ${skipped.join(" · ")}`);
