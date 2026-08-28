// Random control-flow programs for the differential fuzz. One AST is rendered twice — once as a QPI
// entry body (locals live in a `_locals` struct) and once as plain C++ for the gtest — so clang compiles
// the reference and Qinit compiles the contract from the same program, and any divergence is a codegen
// difference rather than a disagreement with a number someone typed.
//
// Pure: no IO, no Monaco, no engine. Unit-tested, and a failing seed can be printed and shrunk without
// rebuilding anything.

export interface GeneratedProgram {
    seed: number;
    /** Loop variables the program uses, beyond the accumulator. */
    vars: string[];
    /** Statements rendered with `locals.` qualification, for the contract entry. */
    contractBody: string;
    /** The same statements with bare locals, for the clang-compiled reference. */
    referenceBody: string;
    /** Upper bound on executed loop iterations — the generator's own termination proof. */
    steps: number;
}

// Same xorshift the container fuzz uses (tests/support/container-harness.ts), so a seed means the same
// thing across both suites.
function rng(seed: number): () => number {
    let state = (seed ^ 0x9e3779b9) >>> 0;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>>= 0);
    };
}

const MAX_DEPTH = 3;
// Keeps the product of nested loop bounds small enough that no program can run long, whatever the seed.
const STEP_BUDGET = 4096;

// Counters shared by every nested scope. They must not be copied when a loop descends, or the inner
// scopes' work never reaches the budget the outer scope is checking against.
interface Budget {
    steps: number;
    varCount: number;
}

interface Ctx {
    next: () => number;
    depth: number;
    /** Loop variables currently in scope, innermost last — `continue`/`break` need at least one. */
    loopVars: string[];
    /** Iterations the enclosing loops multiply by, so a nested bound can be capped against the budget. */
    factor: number;
    budget: Budget;
}

const pick = <T>(context: Ctx, items: readonly T[]): T => items[context.next() % items.length];

// Only + - * and comparisons: `/` and `%` are prohibited by qpi.h, and both trap on zero. uint64
// wraparound is defined, so no expression here can be undefined behaviour.
function expression(context: Ctx, depth = 0): string {
    const atoms = ["sum", ...context.loopVars, String(context.next() % 17), String(context.next() % 5)];
    if (depth >= 2) {
        return pick(context, atoms);
    }
    const left = expression(context, depth + 1);
    const right = expression(context, depth + 1);
    return `(${left} ${pick(context, ["+", "-", "*"])} ${right})`;
}

function condition(context: Ctx, depth = 0): string {
    const shape = context.next() % (depth >= 1 ? 4 : 6);
    const compare = () => `(${expression(context, 1)} ${pick(context, ["<", ">", "<=", ">=", "==", "!="])} ${expression(context, 1)})`;
    switch (shape) {
        case 0:
        case 1:
        case 2:
        case 3:
            return compare();
        // A logical operator whose right side is itself one forces the lowering's hoisted-temporary path
        // rather than its inline if-expression path.
        case 4:
            return `(${compare()} ${pick(context, ["&&", "||"])} ${condition(context, depth + 1)})`;
        default:
            return `(${compare()} ? ${compare()} : ${compare()})`;
    }
}

function block(context: Ctx, inLoop: boolean): string[] {
    const count = 1 + (context.next() % 3);
    const out: string[] = [];
    for (let index = 0; index < count; index++) {
        out.push(...statement(context, inLoop));
    }
    return out;
}

function statement(context: Ctx, inLoop: boolean): string[] {
    const canNest = context.depth < MAX_DEPTH && context.budget.steps < STEP_BUDGET;
    const shape = context.next() % (canNest ? 8 : 3);

    switch (shape) {
        case 0:
            return [`sum += ${expression(context)};`];
        case 1:
            return [`sum = ${expression(context)};`];
        case 2:
            return [`if (${condition(context)}) { sum += ${expression(context)}; } else { sum -= ${expression(context)}; }`];
        case 3:
        case 4:
            return loop(context, "for");
        case 5:
            return loop(context, "while");
        case 6:
            return loop(context, "do");
        default:
            return switchStatement(context, inLoop);
    }
}

function loop(context: Ctx, kind: "for" | "while" | "do"): string[] {
    const variable = `v${context.budget.varCount++}`;
    // The bound is a literal and is capped against what the enclosing loops already multiply by, so the
    // whole program stays inside STEP_BUDGET no matter how it nests.
    const headroom = Math.max(1, Math.floor(STEP_BUDGET / Math.max(1, context.factor)));
    const bound = 1 + (context.next() % Math.max(1, Math.min(6, headroom)));

    // budget is shared by reference on purpose — see Budget.
    const inner: Ctx = { ...context, depth: context.depth + 1, loopVars: [...context.loopVars, variable], factor: context.factor * bound };
    context.budget.steps += context.factor * bound;
    const body = block(inner, true);

    // `continue` in a for-loop is always safe because the update still runs. In while/do it can only go
    // after the increment, or the loop never advances.
    const jump: string[] = [];
    const roll = context.next() % 4;
    if (roll === 0) {
        jump.push(`if (${condition(context)}) { continue; }`);
    } else if (roll === 1) {
        jump.push(`if (${condition(context)}) { break; }`);
    }

    if (kind === "for") {
        return [`for (${variable} = 0; ${variable} < ${bound}; ${variable}++) {`, ...jump, ...body, `}`];
    }
    if (kind === "while") {
        return [`${variable} = 0;`, `while (${variable} < ${bound}) {`, `${variable}++;`, ...jump, ...body, `}`];
    }
    return [`${variable} = 0;`, `do {`, `${variable}++;`, ...jump, ...body, `} while (${variable} < ${bound});`];
}

function switchStatement(context: Ctx, inLoop: boolean): string[] {
    const selector = context.loopVars.length ? pick(context, context.loopVars) : "sum";
    const out = [`switch (${selector}) {`];
    const cases = 2 + (context.next() % 2);
    for (let index = 0; index < cases; index++) {
        out.push(`case ${index}:`);
        out.push(`sum += ${expression(context, 1)};`);
        const tail = context.next() % 4;
        // No `break` leaves the case falling through, which is the point of testing switch at all.
        if (tail === 0 && inLoop) {
            out.push(`continue;`);
        } else if (tail !== 1) {
            out.push(`break;`);
        }
    }
    out.push(`default:`, `sum += ${expression(context, 1)};`, `break;`, `}`);
    return out;
}

const indent = (lines: string[]): string => {
    let level = 0;
    return lines
        .map((line) => {
            if (line.startsWith("}")) level = Math.max(0, level - 1);
            const rendered = "    ".repeat(level + 2) + line;
            if (line.endsWith("{")) level++;
            return rendered;
        })
        .join("\n");
};

// `sum` and every `vN` become `locals.sum` / `locals.vN` for the contract; the reference keeps them bare.
const qualify = (line: string): string => line.replace(/\b(sum|v\d+)\b/g, "locals.$1");

export function generateProgram(seed: number): GeneratedProgram {
    const context: Ctx = { next: rng(seed), depth: 0, loopVars: [], factor: 1, budget: { steps: 0, varCount: 0 } };
    const lines = block(context, false);
    const vars = Array.from({ length: context.budget.varCount }, (_, index) => `v${index}`);

    return {
        seed,
        vars,
        contractBody: indent(lines.map(qualify)),
        referenceBody: indent(lines),
        steps: context.budget.steps,
    };
}

export function generatePrograms(start: number, count: number): GeneratedProgram[] {
    return Array.from({ length: count }, (_, index) => generateProgram(start + index));
}
