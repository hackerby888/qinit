// Not whether the member list answers, but whether it is right.
//
// Round 9 mapped where the fallback answers — eighteen receiver shapes, all of them resolved — and left
// the harder question alone: the list it hands back is a list of names, and nothing has ever checked
// those names against the type. A list that quietly omits a field is a field the developer stops using;
// a list that invents one is a line that will not compile, offered as though it would. Both are worse
// than declining, because a decline at least falls back to clangd.
//
// The receivers with an exact, independent ground truth are the ones tied to a declared struct:
// `state.get()`/`state.mut()` are always `StateData`, and `input`/`output` inside an entry body are
// always that entry's own structs. The IDL names every field of all three, so the comparison is a set
// difference rather than a judgement — run against core's own deployed contracts rather than fixtures.
//
// Only an omission is a failure. The IDL lists the fields of the *payload*, and a struct can carry
// members that are not payload — GQMPROP's `SetProposal_input` is `ProposalDataV1<false>`, whose
// `supportScalarVotes` is a `static constexpr bool` occupying no bytes. Offering it is right and leaving
// it out of the IDL is right, so extras are printed for inspection rather than counted as inventions.
import { initK12 } from "@qinit/core";
import { analyzeContract, completeMembersAt } from "@qinit/compiler/analyzer";
import { loadQpiHeader } from "@qinit/compiler";
import { systemContracts, systemContractClosure } from "@qinit/build";
import { CORE_PATH, HAS_CORE } from "../../../test-utils/paths";

if (!HAS_CORE) {
    console.error("QINIT_CORE is required: this checks the member list against core's own contracts");
    process.exit(2);
}
await initK12();
const headers = loadQpiHeader(CORE_PATH);

/** Most positions in a file exercise the same code path, so a spread sample buys more than a prefix. */
const PER_RECEIVER = Number(process.env.QPI_MEMBER_SAMPLES ?? 12);

function sample<T>(items: T[], limit: number): T[] {
    if (items.length <= limit) return items;
    const step = items.length / limit;
    return Array.from({ length: limit }, (_, index) => items[Math.floor(index * step)]);
}

// `locals.input.offset` contains `input.` too, and the receiver there is `locals.input` — a different
// type with different fields. Only an occurrence that starts a receiver counts.
function offsetsOf(source: string, marker: string): number[] {
    const found: number[] = [];
    for (let at = source.indexOf(marker); at >= 0; at = source.indexOf(marker, at + 1)) {
        if (/[A-Za-z0-9_.]/.test(source[at - 1] ?? "")) continue;
        found.push(at + marker.length);
    }
    return found;
}

/** The body of `PUBLIC_FUNCTION(name)` and friends, by brace matching from the macro. */
function entryBody(source: string, name: string): { start: number; end: number } | undefined {
    const macro = new RegExp(`PUBLIC_(?:FUNCTION|PROCEDURE)(?:_WITH_LOCALS)?\\s*\\(\\s*${name}\\s*\\)`);
    const found = macro.exec(source);
    if (!found) return undefined;
    const open = source.indexOf("{", found.index + found[0].length);
    if (open < 0) return undefined;
    let depth = 0;
    for (let at = open; at < source.length; at++) {
        if (source[at] === "{") depth++;
        else if (source[at] === "}" && --depth === 0) return { start: open, end: at };
    }
    return undefined;
}

interface Case {
    receiver: string;
    expected: Set<string>;
    offsets: number[];
}

console.log(`member truth: ${systemContracts(CORE_PATH).length} deployed contracts · up to ${PER_RECEIVER} positions per receiver\n`);
console.log(`${"CONTRACT".padEnd(10)} ${"RECEIVERS".padStart(9)} ${"ASKED".padStart(6)} ${"DECLINED".padStart(8)}  RESULT`);
console.log("-".repeat(76));

let asked = 0;
let declined = 0;
const wrong: string[] = [];
const extras = new Set<string>();
for (const contract of systemContracts(CORE_PATH)) {
    const closure = systemContractClosure(CORE_PATH, contract.name).filter((other) => other.index !== contract.index);
    const calleeSources = closure.length ? closure.map((other) => ({ name: other.stateType, source: other.source, slot: other.index })) : undefined;
    const shared = { source: contract.source, contractName: contract.stateType, slot: contract.index, qpiHeader: headers, calleeSources };
    const idl = analyzeContract(shared).idl;
    if (!idl?.state) {
        console.log(`${contract.name.padEnd(10)} no IDL state — skipped`);
        continue;
    }

    const cases: Case[] = [];
    const stateFields = new Set(idl.state.fields.map((field) => field.name));
    for (const marker of ["state.get().", "state.mut()."]) {
        const offsets = sample(offsetsOf(contract.source, marker), PER_RECEIVER);
        if (offsets.length) cases.push({ receiver: marker, expected: stateFields, offsets });
    }
    for (const entry of [...idl.functions, ...idl.procedures]) {
        const body = entryBody(contract.source, entry.name);
        if (!body) continue;
        const within = contract.source.slice(body.start, body.end);
        for (const [marker, abi] of [
            ["input.", entry.input],
            ["output.", entry.output],
        ] as const) {
            if (!abi?.fields?.length) continue;
            const offsets = sample(
                offsetsOf(within, marker).map((offset) => offset + body.start),
                4,
            );
            if (offsets.length) cases.push({ receiver: `${entry.name}: ${marker}`, expected: new Set(abi.fields.map((field) => field.name)), offsets });
        }
    }

    let contractAsked = 0;
    let contractDeclined = 0;
    const problems: string[] = [];
    for (const probe of cases) {
        for (const offset of probe.offsets) {
            contractAsked++;
            let items;
            try {
                items = completeMembersAt({ ...shared, offset });
            } catch (cause) {
                problems.push(`${probe.receiver} threw ${cause instanceof Error ? cause.message.slice(0, 40) : ""}`);
                continue;
            }
            if (!items) {
                contractDeclined++;
                continue;
            }
            const offered = new Set(items.filter((item) => item.kind === "field").map((item) => item.name));
            for (const name of [...offered].filter((candidate) => !probe.expected.has(candidate))) {
                extras.add(`${contract.name} ${probe.receiver}${name}`);
            }
            const missing = [...probe.expected].filter((name) => !offered.has(name));
            if (missing.length) problems.push(`${probe.receiver} omits ${missing.join(", ")}`);
        }
    }

    asked += contractAsked;
    declined += contractDeclined;
    const unique = [...new Set(problems)];
    if (unique.length) wrong.push(`${contract.name}: ${unique.slice(0, 3).join(" · ")}`);
    console.log(
        `${contract.name.padEnd(10)} ${String(cases.length).padStart(9)} ${String(contractAsked).padStart(6)} ${String(contractDeclined).padStart(8)}  ` +
            (unique.length ? `${unique.length} WRONG — ${unique[0].slice(0, 60)}` : "every list matched the declared fields"),
    );
}

console.log(
    `\n${asked} positions asked · ${declined} declined (${((declined / asked) * 100).toFixed(1)}%) · ${wrong.length} contract(s) omitting a declared field`,
);
if (wrong.length) for (const line of wrong) console.log(`  ${line}`);
if (extras.size) console.log(`offered beyond the payload (not a defect — a struct may carry members the ABI does not): ${[...extras].join(", ")}`);
process.exitCode = wrong.length ? 1 : 0;
