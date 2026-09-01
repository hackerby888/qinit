// Precedence as the parser actually resolves it, from real expression text. The constexpr tests next door
// hand-build their trees, so they pin the evaluator's walk and not the grouping the parser chose; both
// expression fuzzers parenthesize every subexpression, so neither can reach a precedence tier boundary.
// Reordering BINARY_TIERS therefore used to leave the whole suite green. Every row here parses a string.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Expression } from "../../src/ast";
import { AstKind, DiagnosticSeverity } from "../../src/shared/enums";
import { Lexer } from "../../src/frontend/lexer";
import { Parser } from "../../src/frontend/parser";
import { SemanticAnalyzer } from "../../src/semantics/semantic-analysis";

// A half-consumed expression reads as a shorter, passing one, so a parse is only accepted at EOF with no
// errors — the same guard parseLayout keeps in abi-fmt.ts.
function parse(text: string): Expression {
    const parser = new Parser(new Lexer(text).tokenize());
    const expression = parser.expressions.parseExpression();
    const errors = parser.getDiagnostics().filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR);

    expect({ text, errors: errors.map((diagnostic) => diagnostic.message), atEof: parser.state.eof() }).toEqual({ text, errors: [], atEof: true });
    return expression;
}

// Renders the tree fully parenthesized, dropping PAREN nodes: `2 + 3 * 4` and `2 + (3 * 4)` must render
// identically, which is what lets the paren rows below compare a bare spelling against an explicit one.
function shape(node: Expression): string {
    const expression = node as any;

    switch (expression.kind) {
        case AstKind.PAREN:
            return shape(expression.expression);
        case AstKind.BINARY_OP:
            return `(${shape(expression.left)} ${expression.operator} ${shape(expression.right)})`;
        case AstKind.UNARY_OP:
            return `(${expression.operator}${shape(expression.argument)})`;
        case AstKind.TERNARY:
            return `(${shape(expression.condition)} ? ${shape(expression.then)} : ${shape(expression.else_)})`;
        case AstKind.ASSIGN:
            return `(${shape(expression.left)} ${expression.operator} ${shape(expression.right)})`;
        case AstKind.INT_LITERAL:
            return String(expression.value);
        case AstKind.IDENTIFIER:
            return String(expression.name);
        default:
            return `<${expression.kind}>`;
    }
}

const grouping = (text: string): string => shape(parse(text));
const fold = (text: string): bigint | null => new SemanticAnalyzer().evaluateConstexpr(parse(text));

// ---- grouping the parser chose ----

describe("precedence — the grouping the parser chose", () => {
    // One row per BINARY_TIERS boundary, written from both sides: a tier that wrongly swallows its
    // neighbour shows up on one side only, so a single spelling per boundary would miss half the swaps.
    const ADJACENT_TIERS: [string, string][] = [
        ["1 || 0 && 0", "(1 || (0 && 0))"],
        ["0 && 0 || 1", "((0 && 0) || 1)"],
        ["1 && 2 | 4", "(1 && (2 | 4))"],
        ["2 | 4 && 1", "((2 | 4) && 1)"],
        ["1 | 2 ^ 3", "(1 | (2 ^ 3))"],
        ["2 ^ 3 | 1", "((2 ^ 3) | 1)"],
        ["1 ^ 2 & 3", "(1 ^ (2 & 3))"],
        ["2 & 3 ^ 1", "((2 & 3) ^ 1)"],
        ["1 & 2 == 2", "(1 & (2 == 2))"],
        ["2 == 2 & 1", "((2 == 2) & 1)"],
        ["1 == 2 < 3", "(1 == (2 < 3))"],
        ["2 < 3 == 1", "((2 < 3) == 1)"],
        ["1 < 2 << 3", "(1 < (2 << 3))"],
        ["2 << 3 < 1", "((2 << 3) < 1)"],
        ["1 << 2 + 3", "(1 << (2 + 3))"],
        ["2 + 3 << 1", "((2 + 3) << 1)"],
        ["1 + 2 * 3", "(1 + (2 * 3))"],
        ["2 * 3 + 1", "((2 * 3) + 1)"],
    ];

    test("every adjacent tier boundary binds the tighter operator first", () => {
        for (const [text, expected] of ADJACENT_TIERS) {
            expect({ text, shape: grouping(text) }).toEqual({ text, shape: expected });
        }
    });

    // Tiers that are not neighbours: a swap between two distant tiers can leave every adjacent pair intact.
    const DISTANT_TIERS: [string, string][] = [
        ["9 == 9 & 1", "((9 == 9) & 1)"],
        ["6 ^ 3 & 5 | 8", "((6 ^ (3 & 5)) | 8)"],
        ["1 + 2 * 3 - 4", "((1 + (2 * 3)) - 4)"],
        ["1 << 1 + 2 * 2", "(1 << (1 + (2 * 2)))"],
        ["2 + 3 < 4 + 5", "((2 + 3) < (4 + 5))"],
        ["1 + 2 == 3 && 4 > 2", "(((1 + 2) == 3) && (4 > 2))"],
        ["8 >> 1 + 1", "(8 >> (1 + 1))"],
        ["7 & 3 | 8", "((7 & 3) | 8)"],
    ];

    test("a tier boundary holds across the tiers between it", () => {
        for (const [text, expected] of DISTANT_TIERS) {
            expect({ text, shape: grouping(text) }).toEqual({ text, shape: expected });
        }
    });

    // Every tier at once, in one expression: the tightest operator has to end up deepest.
    test("all ten tiers in one expression nest strictly by precedence", () => {
        expect(grouping("1 || 2 && 3 | 4 ^ 5 & 6 == 7 < 8 << 9 + 10 * 11")).toBe("(1 || (2 && (3 | (4 ^ (5 & (6 == (7 < (8 << (9 + (10 * 11))))))))))");
    });
});

// ---- associativity ----

describe("precedence — associativity", () => {
    // Left-associative tiers: right-association changes the value of every one of these.
    const LEFT_ASSOCIATIVE: [string, string][] = [
        ["10 - 2 - 3", "((10 - 2) - 3)"],
        ["100 / 5 / 2", "((100 / 5) / 2)"],
        ["20 % 7 % 3", "((20 % 7) % 3)"],
        ["64 >> 2 << 1", "((64 >> 2) << 1)"],
        ["1 << 3 >> 1", "((1 << 3) >> 1)"],
        ["1 < 2 < 3", "((1 < 2) < 3)"],
        ["1 == 2 == 0", "((1 == 2) == 0)"],
        ["1 | 2 | 4", "((1 | 2) | 4)"],
        ["1 ^ 2 ^ 4", "((1 ^ 2) ^ 4)"],
        ["7 & 6 & 5", "((7 & 6) & 5)"],
        ["1 && 1 && 0", "((1 && 1) && 0)"],
        ["0 || 0 || 1", "((0 || 0) || 1)"],
        ["100 - 3 * 4 + 2", "((100 - (3 * 4)) + 2)"],
        ["2 * 3 * 4", "((2 * 3) * 4)"],
    ];

    test("binary tiers group left to right", () => {
        for (const [text, expected] of LEFT_ASSOCIATIVE) {
            expect({ text, shape: grouping(text) }).toEqual({ text, shape: expected });
        }
    });

    // Ternary and assignment are the two right-associative forms; both nest the other way from the tiers above.
    const RIGHT_ASSOCIATIVE: [string, string][] = [
        ["a ? b : c ? d : e", "(a ? b : (c ? d : e))"],
        ["a ? b ? c : d : e", "(a ? (b ? c : d) : e)"],
        ["x = y = 3", "(x = (y = 3))"],
        ["x = y += 3", "(x = (y += 3))"],
    ];

    test("ternary and assignment group right to left", () => {
        for (const [text, expected] of RIGHT_ASSOCIATIVE) {
            expect({ text, shape: grouping(text) }).toEqual({ text, shape: expected });
        }
    });
});

// ---- unary, ternary and assignment against the binary tiers ----

describe("precedence — unary, ternary and assignment", () => {
    // A prefix operator takes only its operand, never the binary expression the operand starts.
    const UNARY: [string, string][] = [
        ["~5 & 15", "((~5) & 15)"],
        ["!0 + 1", "((!0) + 1)"],
        ["-3 + 10", "((-3) + 10)"],
        ["-2 * 3", "((-2) * 3)"],
        ["!1 == 0", "((!1) == 0)"],
        ["~1 ^ 2", "((~1) ^ 2)"],
        ["-2 << 1", "((-2) << 1)"],
        ["~(1 | 2)", "(~(1 | 2))"],
        ["!(1 && 0)", "(!(1 && 0))"],
    ];

    test("a prefix operator binds tighter than every binary tier", () => {
        for (const [text, expected] of UNARY) {
            expect({ text, shape: grouping(text) }).toEqual({ text, shape: expected });
        }
    });

    // The ternary sits below every binary tier, and its middle arm is a full expression rather than one tier.
    const TERNARY: [string, string][] = [
        ["1 || 0 ? 2 : 3", "((1 || 0) ? 2 : 3)"],
        ["1 ? 2 + 3 : 4 * 5", "(1 ? (2 + 3) : (4 * 5))"],
        ["2 + 3 > 4 ? 1 << 2 : 7 & 3", "(((2 + 3) > 4) ? (1 << 2) : (7 & 3))"],
        ["1 & 2 ? 3 | 4 : 5 ^ 6", "((1 & 2) ? (3 | 4) : (5 ^ 6))"],
    ];

    test("the ternary sits below every binary tier", () => {
        for (const [text, expected] of TERNARY) {
            expect({ text, shape: grouping(text) }).toEqual({ text, shape: expected });
        }
    });

    // Assignment is looser still: everything to its right belongs to the right-hand side.
    const ASSIGNMENT: [string, string][] = [
        ["x = 1 + 2 * 3", "(x = (1 + (2 * 3)))"],
        ["x = 1 ? 2 : 3", "(x = (1 ? 2 : 3))"],
        ["x += 1 + 2", "(x += (1 + 2))"],
        ["x <<= 1 + 2", "(x <<= (1 + 2))"],
        ["x |= 1 & 2", "(x |= (1 & 2))"],
    ];

    test("assignment sits below the ternary and takes the whole right-hand side", () => {
        for (const [text, expected] of ASSIGNMENT) {
            expect({ text, shape: grouping(text) }).toEqual({ text, shape: expected });
        }
    });
});

// ---- parentheses ----

describe("precedence — parentheses", () => {
    // bare, the same grouping written out, and the other grouping. The third column is what keeps a row
    // honest: it proves the row would fail under a flipped tier rather than passing by coincidence.
    const PAREN_ROWS: [string, string, string][] = [
        ["2 + 3 * 4", "2 + (3 * 4)", "(2 + 3) * 4"],
        ["1 << 2 + 3", "1 << (2 + 3)", "(1 << 2) + 3"],
        ["7 & 3 | 8", "(7 & 3) | 8", "7 & (3 | 8)"],
        ["1 | 2 ^ 3", "1 | (2 ^ 3)", "(1 | 2) ^ 3"],
        ["9 == 9 & 1", "(9 == 9) & 1", "9 == (9 & 1)"],
        ["8 >> 1 + 1", "8 >> (1 + 1)", "(8 >> 1) + 1"],
        ["10 - 2 - 3", "(10 - 2) - 3", "10 - (2 - 3)"],
        ["100 / 5 / 2", "(100 / 5) / 2", "100 / (5 / 2)"],
        ["64 >> 2 << 1", "(64 >> 2) << 1", "64 >> (2 << 1)"],
        ["1 || 0 && 0", "1 || (0 && 0)", "(1 || 0) && 0"],
        ["~5 & 15", "(~5) & 15", "~(5 & 15)"],
        ["!0 + 1", "(!0) + 1", "!(0 + 1)"],
        ["2 * 3 + 4 * 5", "(2 * 3) + (4 * 5)", "2 * (3 + 4) * 5"],
        ["6 ^ 3 & 5 | 8", "(6 ^ (3 & 5)) | 8", "((6 ^ 3) & 5) | 8"],
        ["17 % 10 % 4", "(17 % 10) % 4", "17 % (10 % 4)"],
    ];

    test("explicit parentheses that match the precedence change neither shape nor value", () => {
        for (const [bare, same] of PAREN_ROWS) {
            expect({ bare, shape: grouping(bare) }).toEqual({ bare, shape: grouping(same) });
            expect({ bare, value: fold(bare) }).toEqual({ bare, value: fold(same) });
        }
    });

    test("the other grouping really is a different expression, so every row above can fail", () => {
        for (const [bare, , other] of PAREN_ROWS) {
            expect({ bare, shape: grouping(bare) }).not.toEqual({ bare, shape: grouping(other) });
            expect({ bare, value: fold(bare) }).not.toEqual({ bare, value: fold(other) });
        }
    });

    // Redundant and nested parentheses are transparent: they must not survive into the tree as structure.
    test("redundant and nested parentheses leave the tree alone", () => {
        expect(grouping("((((2)))) + ((3 * 4))")).toBe("(2 + (3 * 4))");
        expect(grouping("(2 + 3) * (4 + 5)")).toBe("((2 + 3) * (4 + 5))");
        expect(fold("((1 + 2)) * ((3))")).toBe(9n);
    });
});

// ---- values ----

// Every constant here was produced by natively-compiled clang, so the table is ground truth for C
// precedence rather than a restatement of what this parser happens to do.
const CLANG_VERIFIED: [string, bigint][] = [
    ["2 + 3 * 4", 14n],
    ["1 << 2 + 3", 32n],
    ["7 & 3 | 8", 11n],
    ["1 | 2 ^ 3", 1n],
    ["5 & 3 ^ 1", 0n],
    ["1 < 2 == 1", 1n],
    ["8 >> 1 + 1", 2n],
    ["1 << 3 >> 1", 4n],
    ["2 + 3 < 4 + 5", 1n],
    ["1 && 0 || 1", 1n],
    ["0 || 1 && 0", 0n],
    ["3 | 4 & 1 ^ 2", 3n],
    ["64 >> 2 << 1", 32n],
    ["9 == 9 & 1", 1n],
    ["2 * 3 == 6", 1n],
    ["1 + 2 * 3 - 2", 5n],
    ["10 - 2 - 3", 5n],
    ["2 * 3 + 4 * 5", 26n],
    ["1 << 1 + 2 * 2", 32n],
    ["6 ^ 3 & 5 | 8", 15n],
    ["100 - 3 * 4 + 2", 90n],
    ["1 ? 2 + 3 : 4 * 5", 5n],
    ["2 + 3 > 4 ? 1 << 2 : 7 & 3", 4n],
    ["~5 & 15", 10n],
    ["-3 + 10", 7n],
    ["!0 + 1", 2n],
    ["1 + 2 == 3 && 4 > 2", 1n],
    ["7 % 4", 3n],
    ["8 / 2", 4n],
    ["100 / 5 / 2", 10n],
    ["20 % 7 % 3", 0n],
];

describe("precedence — values", () => {
    test("a parsed expression folds to the value clang computes for it", () => {
        for (const [text, expected] of CLANG_VERIFIED) {
            expect({ text, value: fold(text) }).toEqual({ text, value: expected });
        }
    });
});

// ---- generated expressions, judged by clang ----

// The tables above cover the shapes someone thought of. These cover the ones nobody did: random trees,
// rendered with only the parentheses precedence cannot supply, then handed to clang for the answer.
const PRECEDENCE: Record<string, number> = {
    "||": 2,
    "&&": 3,
    "|": 4,
    "^": 5,
    "&": 6,
    "==": 7,
    "!=": 7,
    "<": 8,
    ">": 8,
    "<=": 8,
    ">=": 8,
    "<<": 9,
    ">>": 9,
    "+": 10,
    "-": 10,
    "*": 11,
    "/": 11,
    "%": 11,
};

const TERNARY_PRECEDENCE = 1;
const UNARY_PRECEDENCE = 12;

type Node =
    | { kind: "literal"; value: bigint }
    | { kind: "unary"; operator: "~" | "!" | "-"; operand: Node }
    | { kind: "binary"; operator: string; left: Node; right: Node }
    | { kind: "ternary"; condition: Node; then: Node; else_: Node };

// A tiny LCG rather than Math.random, so a failing expression reproduces from the seed the message carries.
function rng(seed: number): () => number {
    let state = (seed * 2654435761) >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

const pick = <T>(next: () => number, values: readonly T[]): T => values[Math.floor(next() * values.length)];

const OPERATORS = Object.keys(PRECEDENCE);

function generate(next: () => number, depth: number): Node {
    if (depth <= 0 || next() < 0.28) {
        return { kind: "literal", value: BigInt(Math.floor(next() * 16)) };
    }

    const roll = next();

    if (roll < 0.12) {
        return { kind: "unary", operator: pick(next, ["~", "!", "-"] as const), operand: generate(next, depth - 1) };
    }
    if (roll < 0.2) {
        return { kind: "ternary", condition: generate(next, depth - 1), then: generate(next, depth - 1), else_: generate(next, depth - 1) };
    }

    const operator = pick(next, OPERATORS);
    const left = generate(next, depth - 1);

    // `/` and `%` by zero is undefined in C, and the folder answers 0 for it; a shift needs a small
    // non-negative count for the two to agree at all. Both get a literal right operand instead of a subtree.
    if (operator === "/" || operator === "%") {
        return { kind: "binary", operator, left, right: { kind: "literal", value: BigInt(1 + Math.floor(next() * 9)) } };
    }
    if (operator === "<<" || operator === ">>") {
        return { kind: "binary", operator, left, right: { kind: "literal", value: BigInt(Math.floor(next() * 7)) } };
    }

    return { kind: "binary", operator, left, right: generate(next, depth - 1) };
}

const precedenceOf = (node: Node): number => {
    switch (node.kind) {
        case "literal":
            return UNARY_PRECEDENCE + 1;
        case "unary":
            return UNARY_PRECEDENCE;
        case "ternary":
            return TERNARY_PRECEDENCE;
        case "binary":
            return PRECEDENCE[node.operator];
    }
};

// Renders with only the parentheses precedence cannot supply — the whole point is that the parser has to
// rebuild this grouping from the operators alone. The table above is the specification the parser must meet.
function renderMinimal(node: Node): string {
    switch (node.kind) {
        case "literal":
            return String(node.value);
        case "unary": {
            // A unary operand that is itself unary is wrapped so `- -3` cannot lex as a decrement.
            const operand = renderMinimal(node.operand);
            const wrap = precedenceOf(node.operand) < UNARY_PRECEDENCE || node.operand.kind === "unary";
            return `${node.operator}${wrap ? `(${operand})` : operand}`;
        }
        case "ternary": {
            const condition = renderMinimal(node.condition);
            const wrapCondition = precedenceOf(node.condition) <= TERNARY_PRECEDENCE;
            // The middle arm is a full expression and the else arm is right-associative, so neither needs parentheses.
            return `${wrapCondition ? `(${condition})` : condition} ? ${renderMinimal(node.then)} : ${renderMinimal(node.else_)}`;
        }
        case "binary": {
            const own = PRECEDENCE[node.operator];
            const left = renderMinimal(node.left);
            const right = renderMinimal(node.right);
            const leftWrapped = precedenceOf(node.left) < own ? `(${left})` : left;
            // Left-associative, so an equal-precedence right operand still needs its own parentheses.
            const rightWrapped = precedenceOf(node.right) <= own ? `(${right})` : right;
            return `${leftWrapped} ${node.operator} ${rightWrapped}`;
        }
    }
}

function renderExplicit(node: Node): string {
    switch (node.kind) {
        case "literal":
            return String(node.value);
        case "unary":
            return `(${node.operator}(${renderExplicit(node.operand)}))`;
        case "ternary":
            return `((${renderExplicit(node.condition)}) ? (${renderExplicit(node.then)}) : (${renderExplicit(node.else_)}))`;
        case "binary":
            return `((${renderExplicit(node.left)}) ${node.operator} (${renderExplicit(node.right)}))`;
    }
}

// The folder works in arbitrary-precision BigInt while clang wraps at 64 bits, so a tree is only usable
// while every intermediate stays small. Returns null for anything that would leave the two disagreeing.
const MAGNITUDE_CAP = 1n << 40n;

function evaluate(node: Node): bigint | null {
    const bounded = (value: bigint): bigint | null => (value < -MAGNITUDE_CAP || value > MAGNITUDE_CAP ? null : value);

    switch (node.kind) {
        case "literal":
            return node.value;
        case "unary": {
            const operand = evaluate(node.operand);
            if (operand === null) {
                return null;
            }
            if (node.operator === "~") {
                return bounded(~operand);
            }
            if (node.operator === "!") {
                return operand === 0n ? 1n : 0n;
            }
            return bounded(-operand);
        }
        case "ternary": {
            const condition = evaluate(node.condition);
            if (condition === null) {
                return null;
            }
            return condition !== 0n ? evaluate(node.then) : evaluate(node.else_);
        }
        case "binary": {
            const left = evaluate(node.left);
            const right = evaluate(node.right);
            if (left === null || right === null) {
                return null;
            }
            switch (node.operator) {
                case "+":
                    return bounded(left + right);
                case "-":
                    return bounded(left - right);
                case "*":
                    return bounded(left * right);
                case "/":
                    return right === 0n ? null : bounded(left / right);
                case "%":
                    return right === 0n ? null : bounded(left % right);
                case "<<":
                    return bounded(left << right);
                case ">>":
                    return bounded(left >> right);
                case "&":
                    return bounded(left & right);
                case "|":
                    return bounded(left | right);
                case "^":
                    return bounded(left ^ right);
                case "==":
                    return left === right ? 1n : 0n;
                case "!=":
                    return left !== right ? 1n : 0n;
                case "<":
                    return left < right ? 1n : 0n;
                case ">":
                    return left > right ? 1n : 0n;
                case "<=":
                    return left <= right ? 1n : 0n;
                case ">=":
                    return left >= right ? 1n : 0n;
                case "&&":
                    return left !== 0n && right !== 0n ? 1n : 0n;
                default:
                    return left !== 0n || right !== 0n ? 1n : 0n;
            }
        }
    }
}

// Both arms of a ternary are evaluated here even though C takes only one, so a tree is rejected unless
// every branch stays in range — the unused arm still has to be renderable and safe.
function usable(node: Node): boolean {
    if (evaluate(node) === null) {
        return false;
    }
    switch (node.kind) {
        case "literal":
            return true;
        case "unary":
            return usable(node.operand);
        case "ternary":
            return usable(node.condition) && usable(node.then) && usable(node.else_);
        case "binary":
            return usable(node.left) && usable(node.right);
    }
}

interface GeneratedCase {
    seed: number;
    minimal: string;
    explicit: string;
}

function generateCases(count: number, depth: number): GeneratedCase[] {
    const cases: GeneratedCase[] = [];

    for (let seed = 1; cases.length < count && seed < count * 20; seed++) {
        const tree = generate(rng(seed), depth);
        if (!usable(tree)) {
            continue;
        }
        cases.push({ seed, minimal: renderMinimal(tree), explicit: renderExplicit(tree) });
    }

    return cases;
}

const GENERATED = generateCases(220, 5);

describe("precedence — generated expressions", () => {
    // Needs no toolchain: one tree rendered two ways has to parse to one shape, whatever that shape is.
    test("a generated tree parses the same with and without its optional parentheses", () => {
        expect(GENERATED.length).toBeGreaterThan(200);

        for (const { seed, minimal, explicit } of GENERATED) {
            expect({ seed, minimal, shape: grouping(minimal) }).toEqual({ seed, minimal, shape: grouping(explicit) });
        }
    });

    test("the deepest generated expressions still nest, rather than collapsing to a flat chain", () => {
        const deepest = GENERATED.map(({ minimal }) => grouping(minimal)).reduce((a, b) => (a.length >= b.length ? a : b));
        expect(deepest.length).toBeGreaterThan(60);
    });
});

// clang is the oracle for the generated values; without it the tables above still carry the coverage.
const CLANG = (() => {
    const probe = Bun.spawnSync(["clang", "--version"], { stdout: "ignore", stderr: "ignore" });
    return probe.success ? "clang" : null;
})();

describe.skipIf(CLANG === null)("precedence — generated expressions against clang", () => {
    test("every generated expression folds to the value clang computes for it", () => {
        // The oracle is built under the system temp directory, never in the checkout.
        const directory = mkdtempSync(join(tmpdir(), "qinit-precedence-"));

        try {
            const source = join(directory, "oracle.c");
            // Windows links to oracle.exe, and spawning the extensionless path there fails outright.
            const binary = join(directory, process.platform === "win32" ? "oracle.exe" : "oracle");
            const body = GENERATED.map(({ minimal }) => `  printf("%lld\\n", (long long)(${minimal}));`).join("\n");

            // -Wno-parentheses, not -w: chained comparisons are a hard error by default and -w does not
            // downgrade them, yet `a < b < c` is exactly the left-associativity these rows exist to pin.
            writeFileSync(source, `#include <stdio.h>\nint main(void) {\n${body}\n  return 0;\n}\n`);
            const build = Bun.spawnSync([CLANG!, "-Wno-parentheses", "-Wno-error", "-O0", "-o", binary, source]);
            expect(build.success ? "" : build.stderr.toString()).toBe("");

            const run = Bun.spawnSync([binary]);
            expect(run.success).toBe(true);
            // printf ends its lines with \r\n on Windows; BigInt tolerates the stray \r, the split reads better without it.
            const values = run.stdout.toString().trim().split(/\r?\n/);
            expect(values.length).toBe(GENERATED.length);

            for (const [index, { seed, minimal }] of GENERATED.entries()) {
                expect({ seed, minimal, value: fold(minimal) }).toEqual({ seed, minimal, value: BigInt(values[index]) });
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
        // Compiling and linking the oracle does not fit bun's 5s default on a cold Windows runner.
    }, 120000);
});
