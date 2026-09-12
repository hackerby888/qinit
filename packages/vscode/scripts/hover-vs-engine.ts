// The IDL hover's three claims, carried through to the machine that has to honour them.
//
// Hovering an entry states an index and an input/output codec, and those are what a developer builds a
// call from — the codec line is the qubic-cli format string `qinit call --in` takes. Every round so far
// has checked those claims against `buildContractIdl`, which is the same source that produced them.
// This one deploys the contract, encodes each input **from the hover's format string alone**, calls the
// index the hover gives, and checks the entry that answered is the one named. A wrong index, or a codec
// string that does not resolve to the layout the ABI wants, is a transaction sent to the wrong place.
//
// Each entry writes a tag no other entry writes, so a misdispatch cannot hide behind a plausible value.
// `Pad` is the reason the format string is resolved rather than read: `uint8, uint64` is sixteen bytes
// with the second field at offset 8, and a caller who packed it into nine would get no error back —
// a short input is zero-filled, so the call succeeds with the field silently dropped.
import { initK12 } from "@qinit/core";
import { QubicSimulator } from "@qinit/engine";
import { compileContractWithTypeScript, loadQpiHeader } from "@qinit/compiler";
import { analyzeContract } from "@qinit/compiler/analyzer";
import { layoutOf, structFieldOffsets } from "@qinit/proto/abi-fmt";
import { CORE_PATH, HAS_CORE } from "../../../test-utils/paths";

if (!HAS_CORE) {
    console.error("QINIT_CORE is required");
    process.exit(2);
}
await initK12();
const headers = loadQpiHeader(CORE_PATH);
const SLOT = 28;

// Indexes are deliberately out of order and gapped, and `Small`/`Bump` share index 1 — a function and a
// procedure are separate namespaces, which is only true if the engine dispatches on the kind as well.
const SOURCE = `using namespace QPI;
struct Desk2 {};
struct Desk : public ContractBase
{
    struct StateData { uint64 counter; sint64 signedSeen; };

    struct Echo_input { uint64 a; uint64 b; };
    struct Echo_output { uint64 tag; uint64 a; };
    struct Pad_input { uint8 flag; uint64 amount; };
    struct Pad_output { uint64 tag; uint64 amount; };
    struct Small_input {};
    struct Small_output { uint64 tag; };
    struct Bump_input { uint64 by; };
    struct Bump_output { uint64 tag; };
    struct Store_input { uint64 v; sint64 s; };
    struct Store_output { uint64 tag; sint64 s; };

    PUBLIC_FUNCTION(Echo) { output.tag = 3003; output.a = input.a; }
    PUBLIC_FUNCTION(Pad) { output.tag = 5005; output.amount = input.amount; }
    PUBLIC_FUNCTION(Small) { output.tag = 1111; }
    PUBLIC_PROCEDURE(Bump) { output.tag = 1001; state.mut().counter += input.by; }
    PUBLIC_PROCEDURE(Store) { output.tag = 9009; state.mut().signedSeen = input.s; output.s = input.s; }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Echo, 3);
        REGISTER_USER_FUNCTION(Pad, 2);
        REGISTER_USER_FUNCTION(Small, 1);
        REGISTER_USER_PROCEDURE(Bump, 1);
        REGISTER_USER_PROCEDURE(Store, 9);
    }
};
`;

/** The tag each body writes into `output.tag`; no two are the same. */
const TAGS: Record<string, bigint> = { Echo: 3003n, Pad: 5005n, Small: 1111n, Bump: 1001n, Store: 9009n };
/** The second field each entry echoes back, so a right index with a wrong payload still shows. */
const ECHOED: Record<string, bigint> = { Echo: 42n, Pad: 500n, Store: -7n };

const analysis = analyzeContract({ source: SOURCE, contractName: "Desk", slot: SLOT, qpiHeader: headers });
if (!analysis.idl) {
    console.error("the analyzer produced no IDL — the hover would have nothing to show");
    process.exit(2);
}
const built = await compileContractWithTypeScript({ source: SOURCE, contractName: "Desk", slot: SLOT, qpiHeader: headers });
const refused = built.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
if (refused.length) {
    console.error(`the probe contract does not build: ${refused[0].message}`);
    process.exit(2);
}

const simulator = new QubicSimulator();
simulator.deploy(SLOT, built.wasm);

/** Encodes from the hover's own format string, which is the only thing a developer reading it has. */
function encodeFromFormat(format: string, values: bigint[]): Uint8Array {
    if (!format) {
        return new Uint8Array(0);
    }
    const bytes = new Uint8Array(layoutOf(format).size);
    const view = new DataView(bytes.buffer);
    structFieldOffsets(format).forEach((field, index) => {
        const value = values[index] ?? 0n;
        if (field.size === 8) view.setBigInt64(field.off, value, true);
        else if (field.size === 4) view.setInt32(field.off, Number(value), true);
        else bytes[field.off] = Number(value & 0xffn);
    });
    return bytes;
}

console.log(`${"WHAT THE HOVER SAYS".padEnd(54)} ${"OUT".padStart(5)}  VERDICT`);
console.log("-".repeat(84));

const failures: string[] = [];
for (const [kind, entries] of [
    ["function", analysis.idl.functions],
    ["procedure", analysis.idl.procedures],
] as const) {
    for (const entry of entries as any[]) {
        const claim = `${kind} ${entry.name} · index ${entry.inputType} · in "${entry.input.format || "(empty)"}"`;
        const values = entry.name === "Pad" ? [1n, ECHOED.Pad] : entry.name === "Store" ? [11n, ECHOED.Store] : [ECHOED[entry.name] ?? 5n, 0n];
        let output: Uint8Array;
        try {
            const input = encodeFromFormat(entry.input.format, values);
            // The format string has to be a complete description on its own, or the hover is telling a
            // developer to encode a payload the contract will not read.
            if (entry.input.format && input.byteLength !== entry.input.size) {
                failures.push(`${entry.name}: the format string resolves to ${input.byteLength} B, the ABI wants ${entry.input.size}`);
            }
            output = kind === "function" ? simulator.query(SLOT, entry.inputType, input) : simulator.procedure(SLOT, entry.inputType, input);
        } catch (cause) {
            failures.push(`${entry.name}: ${cause instanceof Error ? cause.message : ""}`);
            console.log(`${claim.padEnd(54)} ${"—".padStart(5)}  THREW — ${cause instanceof Error ? cause.message.slice(0, 40) : ""}`);
            continue;
        }

        const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
        const notes: string[] = [];
        if (output.byteLength !== entry.output.size) notes.push(`${output.byteLength} B back, the hover said ${entry.output.size}`);
        const tag = output.byteLength >= 8 ? view.getBigUint64(0, true) : -1n;
        if (tag !== TAGS[entry.name]) {
            const answered = Object.entries(TAGS).find(([, value]) => value === tag)?.[0] ?? "nothing known";
            notes.push(`index ${entry.inputType} reached ${answered}, not ${entry.name}`);
        }
        const echoed = ECHOED[entry.name];
        if (echoed !== undefined && output.byteLength >= 16 && view.getBigInt64(8, true) !== echoed) {
            notes.push(`echoed ${view.getBigInt64(8, true)}, sent ${echoed}`);
        }
        if (notes.length) failures.push(`${entry.name}: ${notes.join("; ")}`);
        console.log(`${claim.padEnd(54)} ${`${output.byteLength} B`.padStart(5)}  ${notes.length ? `MISMATCH — ${notes.join("; ")}` : "ok"}`);
    }
}

// What the format string protects against, kept as a row so the reason the round did not file a finding
// stays visible: hand-packing `uint8, uint64` into nine bytes is answered with success and a lost field.
const pad = analysis.idl.functions.find((entry: any) => entry.name === "Pad");
const hand = new Uint8Array(9);
hand[0] = 1;
new DataView(hand.buffer).setBigUint64(1, ECHOED.Pad, true);
const answered = simulator.query(SLOT, pad.inputType, hand);
const dropped = new DataView(answered.buffer, answered.byteOffset, answered.byteLength).getBigUint64(8, true);
console.log(`\nhand-packed as nine bytes instead of the ${pad.input.size} \`${pad.input.format}\` resolves to:`);
console.log(`  the call still succeeds and amount comes back as ${dropped}, sent ${ECHOED.Pad} — a short input is zero-filled, never refused`);

console.log(
    `\n${failures.length ? `${failures.length} mismatch(es): ${failures.join(" · ")}` : "every entry answered on the index and in the size the hover states"}`,
);
process.exitCode = failures.length ? 1 : 0;
