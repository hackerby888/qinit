// Shared archetype shapes. Most ported Solidity tests reduce to one of a few skeletons — apply an
// operator to two inputs and read the result back, or drive a container through a fill/churn cycle —
// so the skeleton lives here and each archetype supplies only what makes it interesting.

import { emitContract } from "../emit";
import { edgeValues, maxOf, minOf, scalar, u64 } from "../encode";
import { widthOf } from "../axes";
import type { Archetype, AxisAssignment, BuiltContract, CallScript, CallStep, ScalarWidth } from "../types";

export const CORPUS_SLOT = 29;
export const ACTOR = "07".repeat(32);
export const ACTOR_B = "0b".repeat(32);

/** A script skeleton with the determinism knobs already pinned. */
export function script(steps: CallStep[], options: { epochLength?: number; identities?: string[] } = {}): CallScript {
    return {
        slot: CORPUS_SLOT,
        tick: 1000,
        epoch: 100,
        // Short enough that a script can actually reach END_EPOCH; DEFAULT_EPOCH_LENGTH is 3000.
        epochLength: options.epochLength ?? 8,
        identities: options.identities ?? [ACTOR, ACTOR_B],
        fund: [
            { id: 0, amount: "1000000000" },
            { id: 1, amount: "1000000000" },
        ],
        steps,
    };
}

/** The accumulator width that holds a `T`-typed result without losing it. */
export function accumulatorFor(width: ScalarWidth): "uint64" | "sint64" {
    return width.startsWith("sint") ? "sint64" : "uint64";
}

export interface BinaryOpOptions {
    /** The expression under test, given the two input field names. Must use QPI::div / QPI::mod for / and %. */
    expression: (a: string, b: string) => string;
    /** Operand pairs to drive. Defaults to the width's own edge ladder crossed with a small set. */
    operands?: (width: ScalarWidth) => [bigint, bigint][];
    /** Clamp the second operand away from zero, for operators where zero is covered by a dedicated archetype. */
    avoidZeroDivisor?: boolean;
}

/**
 * The workhorse shape: store the expression's value both at accumulator width and at the operand's own
 * width. The pair is what makes integer promotion observable — C++ widens both operands to `int` before
 * the operator, so the wide field and the narrow field disagree exactly when a promotion happened.
 */
export function binaryOpArchetype(meta: Omit<Archetype, "build" | "axes"> & { axes?: Archetype["axes"] }, options: BinaryOpOptions): Archetype {
    return {
        ...meta,
        axes: meta.axes ?? ["width", "placement"],
        build(axis: AxisAssignment): BuiltContract {
            const width = widthOf(axis, "uint64");
            const accumulator = accumulatorFor(width);
            const pairs = (options.operands ?? defaultOperands)(width).filter(([, b]) => !options.avoidZeroDivisor || b !== 0n);

            const source = emitContract({
                axis,
                name: meta.name,
                header: {
                    archetype: meta.name,
                    family: meta.family,
                    solidity: meta.solidity,
                    stresses: meta.stresses,
                    caveat: meta.caveat,
                    axis: `width=${width}${axis.placement ? ` placement=${axis.placement}` : ""}`,
                },
                state: `
                    ${accumulator} wide;
                    ${width} narrow;
                    uint64 calls;
                `,
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Apply",
                        kind: "procedure",
                        number: 1,
                        input: `${width} a;\n${width} b;`,
                        locals: `${accumulator} value;`,
                        body: `
                            locals.value = ${options.expression("input.a", "input.b")};
                            state.mut().wide = locals.value;
                            state.mut().narrow = ${options.expression("input.a", "input.b")};
                            state.mut().calls++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: `${accumulator} wide;\n${width} narrow;\nuint64 calls;`,
                        body: `
                            output.wide = state.get().wide;
                            output.narrow = state.get().narrow;
                            output.calls = state.get().calls;
                        `,
                    },
                ],
                initialize: "state.mut().wide = 0;\nstate.mut().narrow = 0;\nstate.mut().calls = 0;",
            });

            const steps: CallStep[] = [];
            for (const [a, b] of pairs) {
                steps.push({ kind: "procedure", entry: 1, in: scalar(width, a) + scalar(width, b), invocator: 0, note: `${a} op ${b}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    };
}

/** Edge pairs worth driving any binary operator with: boundaries, not middles. */
function defaultOperands(width: ScalarWidth): [bigint, bigint][] {
    const max = maxOf(width);
    const min = minOf(width);
    const edges = edgeValues(width);
    const pairs: [bigint, bigint][] = [
        [max, 1n],
        [max, max],
        [0n, 1n],
        [1n, 0n],
        [max - 1n, 2n],
    ];
    if (width.startsWith("sint")) {
        pairs.push([min, 1n], [min, -1n], [-1n, 1n]);
    } else {
        // 200 + 100 is the promotion case the testing doc warns about; it only fits the narrow widths.
        if (max >= 255n) pairs.push([200n, 100n]);
    }
    return pairs.filter(([a, b]) => edges.length > 0 && a <= max && b <= max && a >= min && b >= min);
}

export interface CounterStateOptions {
    /** Extra StateData members beyond the accumulator. */
    extraState?: string;
    /** Statements run by the single procedure. */
    body: string;
    /** Extra `_locals` members for the procedure. */
    locals?: string;
    /** Input struct for the procedure. */
    input?: string;
    /** Prelude declarations (namespaces, typedefs, enums). */
    prelude?: string;
    /** INITIALIZE body; defaults to zeroing the accumulator. */
    initialize?: string;
}

/**
 * The single-procedure shape: one `Run` procedure that mutates state and one `Read` function that
 * returns the accumulator. Used by archetypes whose interest is in what the body does, not in its I/O.
 */
export function singleProcedureArchetype(
    meta: Omit<Archetype, "build">,
    options: (axis: AxisAssignment) => CounterStateOptions & { steps: CallStep[] },
): Archetype {
    return {
        ...meta,
        build(axis: AxisAssignment): BuiltContract {
            const spec = options(axis);
            const source = emitContract({
                axis,
                name: meta.name,
                header: {
                    archetype: meta.name,
                    family: meta.family,
                    solidity: meta.solidity,
                    stresses: meta.stresses,
                    caveat: meta.caveat,
                    axis: describeAxis(axis),
                },
                prelude: spec.prelude,
                state: `uint64 accumulator;\nuint64 calls;\n${spec.extraState ?? ""}`,
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Run",
                        kind: "procedure",
                        number: 1,
                        input: spec.input,
                        locals: spec.locals ?? "uint64 scratch;",
                        body: `${spec.body}\nstate.mut().calls++;`,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 accumulator;\nuint64 calls;",
                        body: "output.accumulator = state.get().accumulator;\noutput.calls = state.get().calls;",
                    },
                ],
                initialize: spec.initialize ?? "state.mut().accumulator = 0;\nstate.mut().calls = 0;",
            });
            return { source, script: script(spec.steps) };
        },
    };
}

export interface TwoOperandSpec {
    /** StateData members the body writes, declared in full (`uint64 x;`). A `calls` counter is added. */
    state: string;
    /** `Run` body. `input.a` and `input.b` are uint64; write results into the members above. */
    body: string;
    /** `Run` locals. Defaults to a single scratch member. */
    locals?: string;
    /** Declarations placed above the contract. */
    prelude?: string;
    /** Whole struct declarations that live inside the contract. */
    extraStructs?: string;
    /** Operand pairs to drive; each is one procedure call followed by one read. */
    pairs: [bigint, bigint][];
    /**
     * Expected `Read` output after the pair at this index, as the values of the state members in
     * declaration order followed by the call count. Derived by hand from the language rule, never from a
     * backend: these rows are the campaign's only check on the two backends being wrong together.
     */
    expect?: { pair: number; values: bigint[]; note: string }[];
}

/**
 * Two uint64 operands in, several uint64 results in state, read back after every call. Most arithmetic
 * and resolution probes reduce to this, and sharing it keeps an archetype's own file down to the part
 * that is actually interesting.
 */
export function twoOperandArchetype(
    meta: Omit<Archetype, "build" | "axes"> & { axes?: Archetype["axes"] },
    spec: (axis: AxisAssignment) => TwoOperandSpec,
): Archetype {
    return {
        ...meta,
        axes: meta.axes ?? ["placement", "temporaries"],
        build(axis: AxisAssignment): BuiltContract {
            const shape = spec(axis);
            const members = shape.state
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
                .map((line) => line.replace(/;$/, "").split(/\s+/).slice(-1)[0]);
            const source = emitContract({
                axis,
                name: meta.name,
                header: {
                    archetype: meta.name,
                    family: meta.family,
                    solidity: meta.solidity,
                    stresses: meta.stresses,
                    caveat: meta.caveat,
                    axis: describeAxis(axis),
                },
                prelude: shape.prelude,
                extraStructs: shape.extraStructs,
                state: `${shape.state.trim()}\nuint64 calls;`,
                entries: [
                    {
                        name: "Run",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 a;\nuint64 b;",
                        locals: shape.locals ?? "uint64 scratch;",
                        body: `${shape.body}\nstate.mut().calls++;`,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: `${shape.state.trim()}\nuint64 calls;`,
                        body: [...members.map((member) => `output.${member} = state.get().${member};`), "output.calls = state.get().calls;"].join("\n"),
                    },
                ],
                initialize: [...members.map((member) => `state.mut().${member} = 0;`), "state.mut().calls = 0;"].join("\n"),
            });
            const steps: CallStep[] = [];
            for (const [a, b] of shape.pairs) {
                steps.push({ kind: "procedure", entry: 1, in: u64(a) + u64(b), invocator: 0, note: `${a} , ${b}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            const built = script(steps);
            if (shape.expect) {
                built.expect = shape.expect.map((row) => ({
                    // Pair n is procedure at 2n and its read at 2n+1.
                    step: row.pair * 2 + 1,
                    out: [...row.values, BigInt(row.pair + 1)].map((value) => u64(value)).join(""),
                    source: "cpp-rule" as const,
                    note: row.note,
                }));
            }
            return { source, script: built };
        },
    };
}

/** A compact, stable description of an axis assignment, for the emitted file's header comment. */
export function describeAxis(axis: AxisAssignment): string {
    const parts = Object.entries(axis)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`);
    return parts.length ? parts.join(" ") : "base";
}

/** An input of one uint64, the commonest single-argument shape. */
export function arg64(value: bigint | number): string {
    return u64(value);
}
