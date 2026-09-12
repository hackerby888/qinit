// Round 18: receiver shapes the completion campaign had not measured, and the two that decline.
// Reports rather than asserts, so a regression is a number. QINIT_CORE must point at a core checkout.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { completeMembersAt, analyzeContract } from "@qinit/compiler/analyzer";
import { loadQpiHeader } from "@qinit/compiler";
import { getQpiContext } from "@qinit/compiler/driver/qpi-context";

const corePath = process.env.QINIT_CORE;
if (!corePath) {
    console.error("QINIT_CORE is not set");
    process.exit(2);
}

const qpiHeader = loadQpiHeader(corePath);

function contract(body: string, extraDeclarations = ""): string {
    return `using namespace QPI;
struct Desk2 {};
struct Desk : public ContractBase
{
    struct Tag { uint64 rank; uint8 band; };
${extraDeclarations}
    struct StateData { uint64 alpha; uint64 beta; Tag tag; Array<uint64, 8> lots; };
    struct Go_input { uint64 n; }; struct Go_output { uint64 v; };
    struct Go_locals { Tag tag; uint64 i; uint64 t; Array<uint64, 8> lots; };
    PUBLIC_FUNCTION_WITH_LOCALS(Go)
    {
${body}
    }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Go, 1); }
};
`;
}

function membersAt(source: string, upto: string): string[] | undefined {
    const index = source.indexOf(upto);
    if (index < 0) {
        throw new Error(`marker absent: ${upto}`);
    }

    return completeMembersAt({ source, offset: index + upto.length, contractName: "Desk", slot: 28, qpiHeader })?.map((item) => item.name);
}

// E23: the trigger is the for-initializer sharing the receiver's line, not the step or the body.
const LOOP_SHAPES: [string, string][] = [
    ["for header (E21)", "        for (locals.i = 0; locals.i < state.get().alpha; locals.i++) { locals.t = 1; }"],
    ["for init + braced body", "        for (locals.i = 0; locals.i < 8; locals.i++) { locals.t = state.get().alpha; }"],
    ["for without an init", "        for (; locals.i < 8; locals.i++) { locals.t = state.get().alpha; }"],
    ["for with an empty header", "        for (;;) { locals.t = state.get().alpha; }"],
    ["for body on its own line", "        for (locals.i = 0; locals.i < 8; locals.i++)\n        {\n            locals.t = state.get().alpha;\n        }"],
    ["braceless for body", "        for (locals.i = 0; locals.i < 8; locals.i++) locals.t = state.get().alpha;"],
    ["while, same line", "        while (locals.i < 8) { locals.t = state.get().alpha; }"],
    ["if, same line", "        if (locals.i < 8) { locals.t = state.get().alpha; }"],
];

console.log("loop and block shapes, completing `state.get().`");
for (const [label, body] of LOOP_SHAPES) {
    const source = contract(body);
    const members = membersAt(source, "state.get().");
    const compiles = analyzeContract({ source, contractName: "Desk", slot: 28, qpiHeader }).idl ? "compiles" : "REFUSED";
    console.log(`  ${members ? "ok  " : "MISS"}  ${label.padEnd(26)} -> ${members ? `${members.length} items` : "DECLINED"}   (contract ${compiles})`);
}

// E22: a receiver's base class is never walked, so every inherited member is invisible.
const derived = contract(
    "        locals.tag.rank = 1;",
    "    struct Base { uint64 common; uint8 flag; };\n    struct Derived : public Base { uint64 extra; };",
);
const withField = derived.replace("struct StateData { uint64 alpha;", "struct StateData { Derived thing; uint64 alpha;");
console.log("\ninherited members");
console.log(
    `  a contract's own Derived : public Base -> ${membersAt(withField.replace("locals.tag.rank = 1;", "output.v = state.get().thing.extra;"), "state.get().thing.")?.join(", ")}`,
);

const contextMembers = (macro: string, register: string) => {
    const source = `using namespace QPI;
struct Desk2 {};
struct Desk : public ContractBase
{
    struct StateData { uint64 alpha; };
    struct Go_input {}; struct Go_output { uint64 v; };
    struct Go_locals { id who; };
    ${macro}(Go) { locals.who = qpi.invocator(); }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_${register}(Go, 1); }
};
`;
    return membersAt(source, "qpi.") ?? [];
};

const inFunction = contextMembers("PUBLIC_FUNCTION_WITH_LOCALS", "FUNCTION");
const inProcedure = contextMembers("PUBLIC_PROCEDURE_WITH_LOCALS", "PROCEDURE");
console.log(`  qpi. in a function  -> ${inFunction.length} items`);
console.log(`  qpi. in a procedure -> ${inProcedure.length} items (missing ${inFunction.filter((name) => !inProcedure.includes(name)).length} it inherits)`);

// How much of core's real procedure code reaches for a method the procedure context does not offer.
const lib = getQpiContext(qpiHeader).lib;
const bare = (cls: string) => new Set([...(lib.templateMethods.get(cls)?.keys() ?? [])].filter((name) => !name.includes("/")));
const functionOnly = bare("QpiContextFunctionCall");
const procedureOwn = bare("QpiContextProcedureCall");

const contractDir = join(corePath, "src", "contracts");
const isProcedure = /\b(PUBLIC_PROCEDURE|PRIVATE_PROCEDURE)(_WITH_LOCALS)?\s*\(/;
const isFunction = /\b(PUBLIC_FUNCTION|PRIVATE_FUNCTION)(_WITH_LOCALS)?\s*\(/;
let callsInProcedures = 0;
let unofferedCalls = 0;

for (const file of readdirSync(contractDir).filter((name) => name.endsWith(".h"))) {
    let scope: "procedure" | "other" = "other";
    for (const line of readFileSync(join(contractDir, file), "utf8").split("\n")) {
        if (isProcedure.test(line)) scope = "procedure";
        else if (isFunction.test(line)) scope = "other";
        if (scope !== "procedure") continue;
        for (const call of line.matchAll(/\bqpi\.([A-Za-z_]\w*)\s*\(/g)) {
            callsInProcedures++;
            if (functionOnly.has(call[1]!) && !procedureOwn.has(call[1]!)) unofferedCalls++;
        }
    }
}

const share = callsInProcedures === 0 ? 0 : Math.round((unofferedCalls / callsInProcedures) * 100);
console.log(`  core's qpi.* calls inside procedures: ${callsInProcedures}, of which ${unofferedCalls} (${share}%) are not offered there`);
