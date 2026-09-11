// Entry dispatch: how many entries a contract has, what numbers they carry, and who calls whom.

import { emitContract } from "../emit";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, CallStep } from "../types";
import type { EntrySpec as EmitEntry } from "../emit";

const SOL = "test/libsolidity/semanticTests";

function drive(values: bigint[], entry = 1): CallStep[] {
    const steps: CallStep[] = [];
    for (const value of values) {
        steps.push({ kind: "procedure", entry, in: u64(value), invocator: 0, note: `n=${value}` });
        steps.push({ kind: "function", entry: 1 });
    }
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}

const VALUES = [0n, 1n, 5n, 18446744073709551615n];

export const CONTROLFLOW_DISPATCH_ARCHETYPES: Archetype[] = [
    {
        name: "EntryNumbersWithGaps",
        family: "controlflow",
        solidity: `${SOL}/functionSelector/function_selector.sol`,
        stresses:
            "entries registered at 1, 5 and 9 rather than consecutively — a sparse dispatch table, driven at every registered number and at two unregistered ones",
        caveat: "Solidity's selectors are hashes and are sparse by nature; QPI's numbers are chosen, so a sparse table is a deliberate shape rather than the default.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "EntryNumbersWithGaps",
                header: {
                    archetype: "EntryNumbersWithGaps",
                    family: "controlflow",
                    solidity: `${SOL}/functionSelector/function_selector.sol`,
                    stresses: "a sparse registration table",
                    caveat: "QPI entry numbers are chosen, not hashed",
                    axis: "sparse dispatch",
                },
                state: "uint64 first;\nuint64 fifth;\nuint64 ninth;\nuint64 calls;",
                entries: [
                    {
                        name: "First",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: "state.mut().first += input.value;\nstate.mut().calls++;",
                    },
                    {
                        name: "Fifth",
                        kind: "procedure",
                        number: 5,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: "state.mut().fifth += input.value * 5;\nstate.mut().calls++;",
                    },
                    {
                        name: "Ninth",
                        kind: "procedure",
                        number: 9,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: "state.mut().ninth += input.value * 9;\nstate.mut().calls++;",
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 3,
                        output: "uint64 first;\nuint64 fifth;\nuint64 ninth;\nuint64 calls;",
                        body: `
                            output.first = state.get().first;
                            output.fifth = state.get().fifth;
                            output.ninth = state.get().ninth;
                            output.calls = state.get().calls;
                        `,
                    },
                ],
                initialize: "state.mut().first = 0;\nstate.mut().fifth = 0;\nstate.mut().ninth = 0;\nstate.mut().calls = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(2), invocator: 0 },
                    { kind: "procedure", entry: 5, in: u64(2), invocator: 0 },
                    { kind: "procedure", entry: 9, in: u64(2), invocator: 0 },
                    { kind: "function", entry: 3 },
                    { kind: "procedure", entry: 5, in: u64(3), invocator: 0, note: "the middle of the table again" },
                    { kind: "procedure", entry: 9, in: u64(4), invocator: 0 },
                    { kind: "function", entry: 3 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "ManyEntriesOneContract",
        family: "controlflow",
        solidity: `${SOL}/functionSelector/many_functions.sol`,
        stresses:
            "eight procedures and four functions in one contract, each touching a different state member — a wide dispatch table where a shifted index writes the wrong member",
        axes: ["placement"],
        build(axis) {
            const procedures: EmitEntry[] = Array.from({ length: 8 }, (_, index) => ({
                name: `Set${index}`,
                kind: "procedure" as const,
                number: index + 1,
                input: "uint64 value;",
                locals: "uint64 scratch;",
                body: `locals.scratch = input.value + ${index};\nstate.mut().slot${index} = locals.scratch;\nstate.mut().calls++;`,
            }));
            const functions: EmitEntry[] = Array.from({ length: 4 }, (_, index) => ({
                name: `Read${index}`,
                kind: "function" as const,
                number: index + 1,
                output: "uint64 a;\nuint64 b;\nuint64 calls;",
                body: `output.a = state.get().slot${index * 2};\noutput.b = state.get().slot${index * 2 + 1};\noutput.calls = state.get().calls;`,
            }));
            const source = emitContract({
                axis,
                name: "ManyEntriesOneContract",
                header: {
                    archetype: "ManyEntriesOneContract",
                    family: "controlflow",
                    solidity: `${SOL}/functionSelector/many_functions.sol`,
                    stresses: "twelve registered entries over eight state members",
                    axis: "wide dispatch table",
                },
                state: `${Array.from({ length: 8 }, (_, index) => `uint64 slot${index};`).join("\n")}\nuint64 calls;`,
                entries: [...procedures, ...functions],
                initialize: `${Array.from({ length: 8 }, (_, index) => `state.mut().slot${index} = 0;`).join("\n")}\nstate.mut().calls = 0;`,
            });
            const steps: CallStep[] = [];
            for (let index = 0; index < 8; index++) {
                steps.push({ kind: "procedure", entry: index + 1, in: u64(100 + index), invocator: 0, note: `Set${index}` });
            }
            for (let index = 0; index < 4; index++) steps.push({ kind: "function", entry: index + 1 });
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "HelperSharedByFunctionAndProcedure",
        family: "controlflow",
        solidity: `${SOL}/functionCall/internal_function_calls.sol`,
        stresses:
            "one private function called from a public function and from a public procedure — the same helper reached from a read-only frame and from a mutating one",
        caveat: "Solidity's internal functions are callable from view and non-view alike; QPI's read-only rule is enforced structurally, which is what makes the shared helper interesting.",
        axes: ["placement", "temporaries"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "HelperSharedByFunctionAndProcedure",
                header: {
                    archetype: "HelperSharedByFunctionAndProcedure",
                    family: "controlflow",
                    solidity: `${SOL}/functionCall/internal_function_calls.sol`,
                    stresses: "a private helper called from both entry kinds",
                    caveat: "the read-only rule is structural in QPI",
                    axis: "shared helper",
                },
                state: "uint64 stored;\nuint64 procedureCalls;\nuint64 lastComputed;",
                entries: [
                    {
                        name: "Compute",
                        kind: "function",
                        visibility: "private",
                        number: 0,
                        input: "uint64 value;",
                        output: "uint64 result;",
                        locals: "uint64 scratch;",
                        body: `
                            locals.scratch = input.value * 3 + 1;
                            output.result = locals.scratch + state.get().stored;
                        `,
                    },
                    {
                        name: "Apply",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "Compute_input request;\nCompute_output reply;",
                        body: `
                            locals.request.value = input.value;
                            CALL(Compute, locals.request, locals.reply);
                            state.mut().stored = locals.reply.result;
                            state.mut().lastComputed = locals.reply.result;
                            state.mut().procedureCalls++;
                        `,
                    },
                    {
                        name: "Peek",
                        kind: "function",
                        number: 1,
                        input: "uint64 value;",
                        output: "uint64 result;\nuint64 stored;\nuint64 procedureCalls;",
                        locals: "Compute_input request;\nCompute_output reply;",
                        body: `
                            locals.request.value = input.value;
                            CALL(Compute, locals.request, locals.reply);
                            output.result = locals.reply.result;
                            output.stored = state.get().stored;
                            output.procedureCalls = state.get().procedureCalls;
                        `,
                    },
                ],
                initialize: "state.mut().stored = 0;\nstate.mut().procedureCalls = 0;\nstate.mut().lastComputed = 0;",
            });
            const steps: CallStep[] = [];
            for (const value of VALUES) {
                steps.push({ kind: "function", entry: 1, in: u64(value), note: "peek must not move the digest" });
                steps.push({ kind: "procedure", entry: 1, in: u64(value), invocator: 0 });
                steps.push({ kind: "function", entry: 1, in: u64(value) });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "GuardLadderEightDeep",
        family: "controlflow",
        solidity: `${SOL}/controlFlow/nested_if.sol`,
        stresses:
            "eight nested guards, each writing before it descends, so the state records exactly how deep the input got — a branch tree where one inverted condition changes the recorded depth",
        axes: ["placement"],
        build(axis) {
            const depth = 8;
            let body = "";
            for (let level = 0; level < depth; level++) {
                body += `if (input.value > ${level * 10})\n{\nstate.mut().depth = ${level + 1};\nstate.mut().marks += ${level + 1};\n`;
            }
            body += "state.mut().bottom++;\n";
            body += "}\n".repeat(depth);
            const source = emitContract({
                axis,
                name: "GuardLadderEightDeep",
                header: {
                    archetype: "GuardLadderEightDeep",
                    family: "controlflow",
                    solidity: `${SOL}/controlFlow/nested_if.sol`,
                    stresses: "eight levels of nested guards with a write at each level",
                    axis: "guard ladder",
                },
                state: "uint64 depth;\nuint64 marks;\nuint64 bottom;\nuint64 calls;",
                entries: [
                    { name: "Descend", kind: "procedure", number: 1, input: "uint64 value;", locals: "uint64 scratch;", body: `${body}state.mut().calls++;` },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 depth;\nuint64 marks;\nuint64 bottom;\nuint64 calls;",
                        body: `
                            output.depth = state.get().depth;
                            output.marks = state.get().marks;
                            output.bottom = state.get().bottom;
                            output.calls = state.get().calls;
                        `,
                    },
                ],
                initialize: "state.mut().depth = 0;\nstate.mut().marks = 0;\nstate.mut().bottom = 0;\nstate.mut().calls = 0;",
            });
            return { source, script: script(drive([0n, 1n, 35n, 71n, 80n, 18446744073709551615n])) };
        },
    },

    {
        name: "CallInsideLoopReusingLocals",
        family: "controlflow",
        solidity: `${SOL}/functionCall/call_in_loop.sol`,
        stresses:
            "a private call inside a loop whose request and reply buffers are reused every iteration — the locals frame is not re-zeroed between calls, so a leftover value from the previous iteration is visible if the callee does not write it",
        caveat: "Solidity's memory is fresh per internal call; QPI's `_locals` is an arena the caller owns, which is the difference this archetype exists to pin.",
        axes: ["placement", "loopShape", "temporaries"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "CallInsideLoopReusingLocals",
                header: {
                    archetype: "CallInsideLoopReusingLocals",
                    family: "controlflow",
                    solidity: `${SOL}/functionCall/call_in_loop.sol`,
                    stresses: "reused call buffers across loop iterations",
                    caveat: "the locals arena is not re-zeroed per call",
                    axis: "call in a loop",
                },
                state: "uint64 sum;\nuint64 lastPartial;\nuint64 iterations;\nuint64 unwrittenSeen;",
                entries: [
                    {
                        name: "Step",
                        kind: "function",
                        visibility: "private",
                        number: 0,
                        input: "uint64 value;\nuint64 skip;",
                        output: "uint64 doubled;\nuint64 untouched;",
                        locals: "uint64 scratch;",
                        body: `
                            locals.scratch = input.value * 2;
                            output.doubled = locals.scratch;
                            // Deliberately leaves output.untouched alone on the odd iterations.
                            if (input.skip == 0)
                            {
                                output.untouched = input.value + 1000;
                            }
                        `,
                    },
                    {
                        name: "Run",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "uint64 i;\nStep_input request;\nStep_output reply;",
                        body: `
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.request.value = locals.i;
                                locals.request.skip = QPI::mod(locals.i, 2ULL);
                                CALL(Step, locals.request, locals.reply);
                                state.mut().sum += locals.reply.doubled;
                                state.mut().lastPartial = locals.reply.untouched;
                                if (locals.request.skip != 0 && locals.reply.untouched != 0)
                                {
                                    state.mut().unwrittenSeen++;
                                }
                                state.mut().iterations++;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 sum;\nuint64 lastPartial;\nuint64 iterations;\nuint64 unwrittenSeen;",
                        body: `
                            output.sum = state.get().sum;
                            output.lastPartial = state.get().lastPartial;
                            output.iterations = state.get().iterations;
                            output.unwrittenSeen = state.get().unwrittenSeen;
                        `,
                    },
                ],
                initialize: "state.mut().sum = 0;\nstate.mut().lastPartial = 0;\nstate.mut().iterations = 0;\nstate.mut().unwrittenSeen = 0;",
            });
            return { source, script: script(drive([0n, 1n, 2n, 5n])) };
        },
    },

    {
        name: "ShortCircuitWithCallOperands",
        family: "controlflow",
        solidity: `${SOL}/expressions/short_circuit.sol`,
        stresses:
            "a boolean chain whose operands are values produced by a private call, where the right-hand call must not happen when the left settles the answer",
        caveat: "Solidity's short-circuit skips a function call the same way; the port makes the skipped call observable by having the callee count itself.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "ShortCircuitWithCallOperands",
                header: {
                    archetype: "ShortCircuitWithCallOperands",
                    family: "controlflow",
                    solidity: `${SOL}/expressions/short_circuit.sol`,
                    stresses: "an operand the short circuit must skip",
                    caveat: "the skipped call counts itself so the skip is visible",
                    axis: "short circuit",
                },
                state: "uint64 leftCalls;\nuint64 rightCalls;\nuint64 andTrue;\nuint64 orTrue;",
                entries: [
                    {
                        name: "Left",
                        kind: "procedure",
                        visibility: "private",
                        number: 0,
                        input: "uint64 value;",
                        output: "uint64 result;",
                        locals: "uint64 scratch;",
                        body: "state.mut().leftCalls++;\nlocals.scratch = input.value;\noutput.result = locals.scratch > 10 ? 1 : 0;",
                    },
                    {
                        name: "Right",
                        kind: "procedure",
                        visibility: "private",
                        number: 0,
                        input: "uint64 value;",
                        output: "uint64 result;",
                        locals: "uint64 scratch;",
                        body: "state.mut().rightCalls++;\nlocals.scratch = input.value;\noutput.result = locals.scratch > 100 ? 1 : 0;",
                    },
                    {
                        name: "Evaluate",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "Left_input leftIn;\nLeft_output leftOut;\nRight_input rightIn;\nRight_output rightOut;",
                        body: `
                            locals.leftIn.value = input.value;
                            CALL(Left, locals.leftIn, locals.leftOut);
                            if (locals.leftOut.result != 0)
                            {
                                locals.rightIn.value = input.value;
                                CALL(Right, locals.rightIn, locals.rightOut);
                                if (locals.rightOut.result != 0)
                                {
                                    state.mut().andTrue++;
                                }
                                state.mut().orTrue++;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 leftCalls;\nuint64 rightCalls;\nuint64 andTrue;\nuint64 orTrue;",
                        body: `
                            output.leftCalls = state.get().leftCalls;
                            output.rightCalls = state.get().rightCalls;
                            output.andTrue = state.get().andTrue;
                            output.orTrue = state.get().orTrue;
                        `,
                    },
                ],
                initialize: "state.mut().leftCalls = 0;\nstate.mut().rightCalls = 0;\nstate.mut().andTrue = 0;\nstate.mut().orTrue = 0;",
            });
            return { source, script: script(drive([0n, 5n, 50n, 500n])) };
        },
    },

    {
        name: "AccumulateWithContinueFilter",
        family: "controlflow",
        solidity: `${SOL}/controlFlow/continue_in_loop.sol`,
        stresses:
            "a filtering loop where `continue` skips the accumulate but not the counter — two counters that must diverge by exactly the number of skipped iterations",
        axes: ["placement", "loopShape"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "AccumulateWithContinueFilter",
                header: {
                    archetype: "AccumulateWithContinueFilter",
                    family: "controlflow",
                    solidity: `${SOL}/controlFlow/continue_in_loop.sol`,
                    stresses: "continue skipping the accumulate but not the counter",
                    axis: "filtering loop",
                },
                state: "uint64 visited;\nuint64 accumulated;\nuint64 skipped;\nuint64 sum;",
                entries: [
                    {
                        name: "Filter",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "uint64 i;",
                        body: `
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                state.mut().visited++;
                                if (QPI::mod(locals.i, 3ULL) == 0)
                                {
                                    state.mut().skipped++;
                                    continue;
                                }
                                state.mut().accumulated++;
                                state.mut().sum += locals.i * locals.i;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 visited;\nuint64 accumulated;\nuint64 skipped;\nuint64 sum;",
                        body: `
                            output.visited = state.get().visited;
                            output.accumulated = state.get().accumulated;
                            output.skipped = state.get().skipped;
                            output.sum = state.get().sum;
                        `,
                    },
                ],
                initialize: "state.mut().visited = 0;\nstate.mut().accumulated = 0;\nstate.mut().skipped = 0;\nstate.mut().sum = 0;",
            });
            return { source, script: script(drive([0n, 1n, 3n, 10n, 33n])) };
        },
    },

    {
        name: "ReadOnlyFunctionCallsPrivateProcedure",
        family: "controlflow",
        solidity: `${SOL}/functionCall/view_calls_nonview.sol`,
        stresses:
            "a public function whose body calls a private *procedure* — a mutating callee reached from a read-only frame, which both build gates must treat the same way",
        caveat: "Solidity rejects a view function calling a non-view one at compile time, and so does clang: the CALL macro hands the function's context to a procedure and there is no conversion. The TypeScript backend used to accept it and perform the write; it now refuses it too.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "ReadOnlyFunctionCallsPrivateProcedure",
                header: {
                    archetype: "ReadOnlyFunctionCallsPrivateProcedure",
                    family: "controlflow",
                    solidity: `${SOL}/functionCall/view_calls_nonview.sol`,
                    stresses: "a read-only entry calling a mutating private entry",
                    caveat: "both backends reject: a function's context cannot convert to the procedure context CALL forwards",
                    axis: "view calls non-view",
                },
                state: "uint64 counter;\nuint64 reads;",
                entries: [
                    {
                        name: "Bump",
                        kind: "procedure",
                        visibility: "private",
                        number: 0,
                        input: "uint64 value;",
                        output: "uint64 result;",
                        locals: "uint64 scratch;",
                        body: "locals.scratch = input.value;\nstate.mut().counter += locals.scratch;\noutput.result = state.get().counter;",
                    },
                    {
                        name: "Peek",
                        kind: "function",
                        number: 1,
                        input: "uint64 value;",
                        output: "uint64 result;",
                        locals: "Bump_input request;\nBump_output reply;",
                        body: `
                            locals.request.value = input.value;
                            CALL(Bump, locals.request, locals.reply);
                            output.result = locals.reply.result;
                        `,
                    },
                ],
                initialize: "state.mut().counter = 0;\nstate.mut().reads = 0;",
            });
            return { source, script: script([{ kind: "function", entry: 1, in: u64(1) }]) };
        },
    },
];
