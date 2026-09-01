// Direct unit tests for the validation-side constant evaluator. It answers null where the analysis-side
// folder answers 0n (divide-by-zero), pinning which evaluator does what before anyone unifies them.
import { describe, expect, test } from "bun:test";
import { AstKind, BinaryOp, UnaryOp } from "../../src/shared/enums";
import { constKey, evalIntegralConst, isZeroLiteral, paramSignature, typeKey } from "../../src/frontend/validation/validation-helpers";
import type { Expression, FunctionDecl, TypeSpec } from "../../src/ast";

const SPAN = { start: 0, end: 0, line: 1, column: 1 };

const int = (value: string): Expression => ({ kind: AstKind.INT_LITERAL, value, span: SPAN }) as Expression;
const identifier = (name: string): Expression => ({ kind: AstKind.IDENTIFIER, name, span: SPAN }) as Expression;
const bin = (operator: BinaryOp, left: Expression, right: Expression): Expression =>
    ({ kind: AstKind.BINARY_OP, operator, left, right, span: SPAN }) as Expression;
const unary = (operator: UnaryOp, argument: Expression): Expression => ({ kind: AstKind.UNARY_OP, operator, argument, span: SPAN }) as Expression;
const call = (callee: string, callArguments: Expression[]): Expression =>
    ({ kind: AstKind.CALL, callee: identifier(callee), callArguments, span: SPAN }) as Expression;
const named = (name: string): TypeSpec => ({ kind: AstKind.NAME, name, span: SPAN }) as TypeSpec;
// There is no static_cast keyword, so the parser hands casts to the folder in this shape.
const templateCast = (castName: string, target: string, argument: Expression): Expression =>
    ({ kind: AstKind.TEMPLATE_CALL, callee: identifier(castName), templateArguments: [named(target)], callArguments: [argument], span: SPAN }) as Expression;

const BINARY_CASES: Record<string, { operator: BinaryOp; left: string; right: string; expected: bigint | null }> = {
    add: { operator: BinaryOp.ADD, left: "1", right: "2", expected: 3n },
    subtract: { operator: BinaryOp.SUBTRACT, left: "5", right: "2", expected: 3n },
    multiply: { operator: BinaryOp.MULTIPLY, left: "3", right: "4", expected: 12n },
    divide: { operator: BinaryOp.DIVIDE, left: "9", right: "2", expected: 4n },
    modulo: { operator: BinaryOp.MODULO, left: "7", right: "3", expected: 1n },
    "shift left": { operator: BinaryOp.SHIFT_LEFT, left: "1", right: "3", expected: 8n },
    "shift right": { operator: BinaryOp.SHIFT_RIGHT, left: "8", right: "2", expected: 2n },
    "bitwise and": { operator: BinaryOp.BITWISE_AND, left: "6", right: "4", expected: 4n },
    "bitwise or": { operator: BinaryOp.BITWISE_OR, left: "1", right: "2", expected: 3n },
    "bitwise xor": { operator: BinaryOp.BITWISE_XOR, left: "1", right: "3", expected: 2n },
    equal: { operator: BinaryOp.EQUAL, left: "2", right: "2", expected: 1n },
    "not equal": { operator: BinaryOp.NOT_EQUAL, left: "2", right: "2", expected: 0n },
    "less than": { operator: BinaryOp.LESS_THAN, left: "1", right: "2", expected: 1n },
    "greater than": { operator: BinaryOp.GREATER_THAN, left: "1", right: "2", expected: 0n },
    "less than or equal": { operator: BinaryOp.LESS_THAN_OR_EQUAL, left: "2", right: "2", expected: 1n },
    "greater than or equal": { operator: BinaryOp.GREATER_THAN_OR_EQUAL, left: "1", right: "2", expected: 0n },
    "logical and": { operator: BinaryOp.LOGICAL_AND, left: "1", right: "3", expected: 1n },
    "logical or": { operator: BinaryOp.LOGICAL_OR, left: "0", right: "0", expected: 0n },
    "divide by zero": { operator: BinaryOp.DIVIDE, left: "1", right: "0", expected: null },
    "modulo by zero": { operator: BinaryOp.MODULO, left: "1", right: "0", expected: null },
};

describe("integral constant evaluation", () => {
    for (const [name, testCase] of Object.entries(BINARY_CASES)) {
        test(`evaluates ${name}`, () => {
            expect(evalIntegralConst(bin(testCase.operator, int(testCase.left), int(testCase.right)))).toBe(testCase.expected);
        });
    }

    test("evaluates literals of every integral flavour", () => {
        expect(evalIntegralConst(int("0x10"))).toBe(16n);
        expect(evalIntegralConst({ kind: AstKind.BOOL_LITERAL, value: true, span: SPAN } as Expression)).toBe(1n);
        expect(evalIntegralConst({ kind: AstKind.CHAR_LITERAL, value: 65, span: SPAN } as Expression)).toBe(65n);
    });

    test("evaluates unary operators", () => {
        expect(evalIntegralConst(unary(UnaryOp.MINUS, int("5")))).toBe(-5n);
        expect(evalIntegralConst(unary(UnaryOp.PLUS, int("5")))).toBe(5n);
        expect(evalIntegralConst(unary(UnaryOp.BITWISE_NOT, int("0")))).toBe(-1n);
        expect(evalIntegralConst(unary(UnaryOp.LOGICAL_NOT, int("0")))).toBe(1n);
    });

    test("a malformed literal yields null instead of throwing", () => {
        expect(evalIntegralConst(int("09"))).toBeNull();
    });

    test("an identifier resolves only through the supplied callback", () => {
        expect(evalIntegralConst(identifier("FOO"))).toBeNull();
        expect(evalIntegralConst(identifier("FOO"), (name) => (name === "FOO" ? 12n : null))).toBe(12n);
    });

    test("a qualified name is resolved by its full spelling", () => {
        const qualified = { kind: AstKind.QUALIFIED_NAME, namespace: "NS", name: "FOO", span: SPAN } as Expression;
        expect(evalIntegralConst(qualified, (name) => (name === "NS::FOO" ? 3n : null))).toBe(3n);
    });

    test("an unresolvable operand poisons the whole expression", () => {
        expect(evalIntegralConst(bin(BinaryOp.ADD, int("1"), identifier("FOO")))).toBeNull();
    });

    test("a parenthesised expression evaluates its contents", () => {
        expect(evalIntegralConst({ kind: AstKind.PAREN, expression: int("7"), span: SPAN } as Expression)).toBe(7n);
    });

    test("a ternary evaluates only the selected branch", () => {
        const ternary = (condition: Expression): Expression =>
            ({ kind: AstKind.TERNARY, condition, then: int("7"), else_: int("9"), span: SPAN }) as Expression;
        expect(evalIntegralConst(ternary(int("1")))).toBe(7n);
        expect(evalIntegralConst(ternary(int("0")))).toBe(9n);
        expect(evalIntegralConst(ternary(identifier("FOO")))).toBeNull();
    });

    test("evaluates the QPI safe-math helpers", () => {
        expect(evalIntegralConst(call("div", [int("10"), int("3")]))).toBe(3n);
        expect(evalIntegralConst(call("mod", [int("10"), int("3")]))).toBe(1n);
        expect(evalIntegralConst(call("min", [int("3"), int("9")]))).toBe(3n);
        expect(evalIntegralConst(call("max", [int("3"), int("9")]))).toBe(9n);
        expect(evalIntegralConst(call("abs", [unary(UnaryOp.MINUS, int("4"))]))).toBe(4n);
    });

    test("a helper dividing by zero yields null", () => {
        expect(evalIntegralConst(call("div", [int("10"), int("0")]))).toBeNull();
        expect(evalIntegralConst(call("mod", [int("10"), int("0")]))).toBeNull();
    });

    test("an unknown callee yields null", () => {
        expect(evalIntegralConst(call("someHelper", [int("1")]))).toBeNull();
    });

    test("a call with an unresolvable argument yields null", () => {
        expect(evalIntegralConst(call("min", [int("1"), identifier("FOO")]))).toBeNull();
    });

    // A folded cast has to land on the value the emitter's narrowCastIr produces for the same cast, or a
    // constant disagrees with the runtime expression it was folded from.
    test("a C-style cast narrows to its target type", () => {
        const cast = (type: string, value: string): Expression =>
            ({ kind: AstKind.C_CAST, type: named(type), expression: int(value), span: SPAN }) as Expression;
        expect(evalIntegralConst(cast("uint8", "300"))).toBe(44n);
        expect(evalIntegralConst(cast("sint8", "200"))).toBe(-56n);
        expect(evalIntegralConst(cast("uint64", "300"))).toBe(300n);
    });

    test("static_cast reaches the folder as a template call and narrows", () => {
        expect(evalIntegralConst(templateCast("static_cast", "uint8", int("300")))).toBe(44n);
        expect(evalIntegralConst(templateCast("static_cast", "sint8", int("200")))).toBe(-56n);
        expect(evalIntegralConst(templateCast("static_cast", "bool", int("7")))).toBe(1n);
    });

    test("a nested static_cast narrows at each step", () => {
        expect(evalIntegralConst(templateCast("static_cast", "uint16", templateCast("static_cast", "uint8", int("300"))))).toBe(44n);
    });

    test("static_cast folds a resolved enum member and composes with arithmetic", () => {
        const member = identifier("E::Inc");
        const resolve = (name: string) => (name === "E::Inc" ? 5n : null);
        expect(evalIntegralConst(templateCast("static_cast", "uint16", member), resolve)).toBe(5n);
        expect(evalIntegralConst(bin(BinaryOp.ADD, templateCast("static_cast", "uint16", member), int("1")), resolve)).toBe(6n);
    });

    test("casts that only change the type leave the value alone", () => {
        expect(evalIntegralConst(templateCast("reinterpret_cast", "uint8", int("300")))).toBe(300n);
        expect(evalIntegralConst(templateCast("const_cast", "uint8", int("300")))).toBe(300n);
    });

    test("a static_cast to an unresolvable target does not narrow", () => {
        expect(evalIntegralConst(templateCast("static_cast", "SomeEnum", int("300")))).toBe(300n);
    });

    test("a static_cast with an unresolvable operand yields null", () => {
        expect(evalIntegralConst(templateCast("static_cast", "uint8", identifier("FOO")))).toBeNull();
    });

    test("sizeof resolves scalar names and rejects record names", () => {
        const sizeofType = { kind: AstKind.SIZEOF_TYPE, type: named("uint64"), span: SPAN } as Expression;
        const sizeofScalarExpr = { kind: AstKind.SIZEOF_EXPR, expression: identifier("uint32"), span: SPAN } as Expression;
        const sizeofRecordExpr = { kind: AstKind.SIZEOF_EXPR, expression: identifier("SomeStruct"), span: SPAN } as Expression;
        expect(evalIntegralConst(sizeofType)).toBe(8n);
        expect(evalIntegralConst(sizeofScalarExpr)).toBe(4n);
        expect(evalIntegralConst(sizeofRecordExpr)).toBeNull();
    });

    test("an unsupported node kind yields null", () => {
        expect(evalIntegralConst({ kind: AstKind.STRING_LITERAL, value: "x", span: SPAN } as Expression)).toBeNull();
    });
});

describe("constant and type keys", () => {
    test("integer literals compare by value, not spelling", () => {
        expect(constKey(int("5ULL"))).toBe("#5");
        expect(constKey(int("0x10"))).toBe("#16");
    });

    test("an unparseable literal falls back to its spelling", () => {
        expect(constKey(int("0x"))).toBe("#0x");
    });

    test("char and bool literals become numeric keys", () => {
        expect(constKey({ kind: AstKind.CHAR_LITERAL, value: 65, span: SPAN } as Expression)).toBe("#65");
        expect(constKey({ kind: AstKind.BOOL_LITERAL, value: true, span: SPAN } as Expression)).toBe("#1");
    });

    test("a negated literal keeps its sign", () => {
        expect(constKey(unary(UnaryOp.MINUS, int("5")))).toBe("#-5");
    });

    test("names key on their spelling", () => {
        expect(constKey(identifier("FOO"))).toBe("id:FOO");
        expect(constKey({ kind: AstKind.QUALIFIED_NAME, namespace: "NS", name: "FOO", span: SPAN } as Expression)).toBe("id:NS::FOO");
    });

    test("a non-constant expression has no key", () => {
        expect(constKey(call("someHelper", []))).toBeNull();
        expect(constKey(unary(UnaryOp.MINUS, call("someHelper", [])))).toBeNull();
    });

    test("zero literals are recognised in any radix", () => {
        expect(isZeroLiteral(int("0"))).toBe(true);
        expect(isZeroLiteral(int("0x0"))).toBe(true);
        expect(isZeroLiteral(int("1"))).toBe(false);
    });

    test("type keys spell out every wrapper", () => {
        expect(typeKey(named("uint64"))).toBe("uint64");
        expect(typeKey({ kind: AstKind.POINTER, pointee: named("uint8") } as TypeSpec)).toBe("uint8*");
        expect(typeKey({ kind: AstKind.ARRAY, element: named("uint8") } as TypeSpec)).toBe("uint8[]");
        expect(typeKey({ kind: AstKind.VOID } as TypeSpec)).toBe("void");
        expect(typeKey({ kind: AstKind.TEMPLATE_INSTANCE, name: "Array", callArguments: [named("uint64"), named("2")] } as TypeSpec)).toBe("Array<uint64,2>");
    });

    test("const and reference wrappers nest", () => {
        const constReference = { kind: AstKind.REFERENCE, referentType: { kind: AstKind.CONST, valueType: named("uint64") } } as TypeSpec;
        expect(typeKey(constReference)).toBe("const uint64&");
    });

    test("a parameter signature joins its type keys", () => {
        const fn = { params: [{ type: named("uint64") }, { type: { kind: AstKind.POINTER, pointee: named("uint8") } }] } as FunctionDecl;
        expect(paramSignature(fn)).toBe("uint64;uint8*");
    });
});
