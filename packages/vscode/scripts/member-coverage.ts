// Where the member fallback answers. Every row is the same contract with one receiver varied, so a decline
// is about the receiver rather than the file around it.
import { initK12 } from "@qinit/core";
import { completeMembersAt } from "@qinit/compiler/analyzer";
import { loadQpiHeader } from "@qinit/compiler";
import { CORE_PATH, HAS_CORE } from "../../../test-utils/paths";

if (!HAS_CORE) {
    console.error("QINIT_CORE is required");
    process.exit(2);
}
await initK12();
const headers = loadQpiHeader(CORE_PATH);

const CALLEE = `using namespace QPI;
struct Vault2
{
};
struct Vault : public ContractBase
{
    struct Tag { uint64 rank; BitArray<8> bits; };
    struct StateData { uint64 seen; };
    struct Get_input { Tag detail; Array<uint64, 8> history; };
    struct Get_output { uint64 value; };
    PUBLIC_FUNCTION(Get) { output.value = state.get().seen; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
};
`;

/** The probe contract: one body line varies, everything else is fixed. */
function contract(body: string, oneLine = false): string {
    return `using namespace QPI;

struct Plain { uint64 outer; };

struct Desk2
{
};

struct Desk : public ContractBase
{
    struct Note { uint64 amount; uint8 kind; };
    struct Deep { Note note; Array<Note, 4> notes; };

    struct StateData
    {
        uint64 calls;
        Note last;
        HashMap<id, Note, 32> byOwner;
    };

    struct Read_input { uint64 index; };
    struct Read_output { uint64 value; };
    struct Read_locals
    {
        Note note;
        Deep deep;
        Plain plain;
        Array<Note, 4> notes;
        BitArray<16> flags;
        id who;
        Vault::Get_input vin;
        Vault::Get_output vout;
    };

    PUBLIC_FUNCTION_WITH_LOCALS(Read)${
        oneLine
            ? ` { ${body.trim()} CALL_OTHER_CONTRACT_FUNCTION(Vault, Get, locals.vin, locals.vout); }`
            : `
    {
${body}
        CALL_OTHER_CONTRACT_FUNCTION(Vault, Get, locals.vin, locals.vout);
        output.value = state.get().calls;
    }`
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
    }
};
`;
}

interface Shape {
    name: string;
    line: string;
    /** The receiver text whose trailing `.` the cursor sits after. */
    receiver: string;
    /** Render the entry body on one line — the shape that used to make the query decline (E16). */
    oneLine?: boolean;
}

const SHAPES: Shape[] = [
    { name: "locals.<struct-in-contract>.", line: "        locals.note.amount = 0;", receiver: "locals.note." },
    { name: "locals.<struct-in-file>.", line: "        locals.plain.outer = 0;", receiver: "locals.plain." },
    { name: "locals.<callee-type>.", line: "        locals.vin.detail.rank = 0;", receiver: "locals.vin." },
    { name: "locals.<callee-type>.<nested>.", line: "        locals.vin.detail.rank = 0;", receiver: "locals.vin.detail." },
    { name: "locals.<nested struct>.", line: "        locals.deep.note.amount = 0;", receiver: "locals.deep." },
    { name: "locals.<nested>.<nested>.", line: "        locals.deep.note.amount = 0;", receiver: "locals.deep.note." },
    { name: "locals.<Array>.", line: "        locals.notes.setAll(locals.note);", receiver: "locals.notes." },
    { name: "locals.<BitArray>.", line: "        locals.flags.setAll(0);", receiver: "locals.flags." },
    // E16: the entry body on one line, which used to make the query decline for every receiver in it.
    { name: "one-line body: locals.<struct>.", line: "        locals.note.amount = 0;", receiver: "locals.note.", oneLine: true },
    { name: "one-line body: state.get().", line: "        state.mut().calls = 0;", receiver: "state.mut().", oneLine: true },
    { name: "one-line body: locals.<callee>.", line: "        locals.vin.detail.rank = 0;", receiver: "locals.vin.", oneLine: true },
    { name: "locals.<Array>.get(0).", line: "        locals.notes.get(0).amount;", receiver: "locals.notes.get(0)." },
    { name: "state.get().", line: "        output.value = state.get().calls;", receiver: "state.get()." },
    { name: "state.get().<struct>.", line: "        output.value = state.get().last.amount;", receiver: "state.get().last." },
    { name: "state.mut().", line: "        state.mut().calls = 0;", receiver: "state.mut()." },
    { name: "input.", line: "        output.value = input.index;", receiver: "input." },
    { name: "output.", line: "        output.value = 0;", receiver: "output." },
    { name: "qpi.", line: "        locals.who = qpi.invocator();", receiver: "qpi." },
];

console.log(`member fallback coverage: ${SHAPES.length} receiver shapes\n`);
console.log(`${"RECEIVER".padEnd(34)} RESULT`);
console.log("-".repeat(78));

let answered = 0;
const declined: string[] = [];
for (const shape of SHAPES) {
    const source = contract(shape.line, shape.oneLine);
    const at = source.indexOf(shape.receiver);
    if (at < 0) {
        console.log(`${shape.name.padEnd(34)} PROBE BROKEN — receiver not in the body`);
        declined.push(`${shape.name} (probe)`);
        continue;
    }
    const offset = at + shape.receiver.length;
    let items;
    try {
        items = completeMembersAt({
            source,
            offset,
            contractName: "Desk",
            slot: 31,
            qpiHeader: headers,
            calleeSources: [{ name: "Vault", source: CALLEE, slot: 30 }],
        });
    } catch (cause) {
        console.log(`${shape.name.padEnd(34)} THREW — ${cause instanceof Error ? cause.message.slice(0, 40) : ""}`);
        declined.push(shape.name);
        continue;
    }
    if (!items) {
        console.log(`${shape.name.padEnd(34)} declined (undefined)`);
        declined.push(shape.name);
        continue;
    }
    answered++;
    console.log(
        `${shape.name.padEnd(34)} ${String(items.length).padStart(2)} members: ${items
            .map((i) => i.name)
            .slice(0, 6)
            .join(", ")}`,
    );
}

console.log(`\n${answered}/${SHAPES.length} shapes answered · ${declined.length} declined`);
if (declined.length) console.log(`declined: ${declined.join(", ")}`);
process.exitCode = declined.length ? 1 : 0;
