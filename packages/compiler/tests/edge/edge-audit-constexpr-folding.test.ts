// Regression net for the constexpr folder in analysis/constant-evaluator.ts, which used to answer 0 for
// logical operators and for sizeof applied to a type name — both silent, since the runtime path is right.
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { edgeRunner } from "../support/edge-compile";

const run = edgeRunner("ConstexprFold");

const wrap = (declarations: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  ${declarations}
  struct StateData { uint64 result; };
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

// Each case declares a constant, then stores it, so the asserted value is what the folder produced.
const CASES: Record<string, { declarations: string; body: string; expected: bigint }> = {
    "logical and folds to one": {
        declarations: `static constexpr uint64 FOLD_AND_K = (1 && 1);`,
        body: `state.mut().result = FOLD_AND_K;`,
        expected: 1n,
    },
    "logical or folds to one": {
        declarations: `static constexpr uint64 FOLD_OR_K = (0 || 3);`,
        body: `state.mut().result = FOLD_OR_K;`,
        expected: 1n,
    },
    "logical and inside a ternary picks the then branch": {
        declarations: `static constexpr uint64 FOLD_A = 5;
  static constexpr uint64 FOLD_TERNARY_K = (FOLD_A > 1 && FOLD_A < 9) ? 7 : 9;`,
        body: `state.mut().result = FOLD_TERNARY_K;`,
        expected: 7n,
    },
    "logical and participates in arithmetic": {
        declarations: `static constexpr uint64 FOLD_SUM_K = (1 && 1) + 3;`,
        body: `state.mut().result = FOLD_SUM_K;`,
        expected: 4n,
    },
    "an enum initializer using logical and is one": {
        declarations: `enum FoldEnum { FOLD_ENUM_X = (1 && 1), FOLD_ENUM_Y };`,
        body: `state.mut().result = (uint64)FOLD_ENUM_X;`,
        expected: 1n,
    },
    "sizeof a struct name folds in a constexpr": {
        declarations: `struct FoldBlob { uint64 a; uint64 b; };
  static constexpr uint64 FOLD_SIZE_K = sizeof(FoldBlob);`,
        body: `state.mut().result = FOLD_SIZE_K;`,
        expected: 16n,
    },
    "sizeof a typedef name folds in a constexpr": {
        declarations: `static constexpr uint64 FOLD_SCALAR_K = sizeof(uint64);`,
        body: `state.mut().result = FOLD_SCALAR_K;`,
        expected: 8n,
    },
    "runtime sizeof of the same struct agrees with the fold": {
        declarations: `struct FoldBlob { uint64 a; uint64 b; };`,
        body: `state.mut().result = sizeof(FoldBlob);`,
        expected: 16n,
    },
    "constexpr modulo folds": {
        declarations: `static constexpr uint64 FOLD_MOD_K = 7 % 3;`,
        body: `state.mut().result = FOLD_MOD_K;`,
        expected: 1n,
    },
    "constexpr exclusive or folds": {
        declarations: `static constexpr uint64 FOLD_XOR_K = 1 ^ 3;`,
        body: `state.mut().result = FOLD_XOR_K;`,
        expected: 2n,
    },
    "constexpr bitwise not folds": {
        declarations: `static constexpr sint64 FOLD_NOT_K = ~0;`,
        body: `state.mut().result = (uint64)FOLD_NOT_K;`,
        expected: 18446744073709551615n,
    },
    "constexpr logical not folds": {
        declarations: `static constexpr uint64 FOLD_LNOT_K = !0;`,
        body: `state.mut().result = FOLD_LNOT_K;`,
        expected: 1n,
    },
    "constexpr min folds": {
        declarations: `static constexpr uint64 FOLD_MIN_K = min(3, 9);`,
        body: `state.mut().result = FOLD_MIN_K;`,
        expected: 3n,
    },
    "constexpr max folds": {
        declarations: `static constexpr uint64 FOLD_MAX_K = max(3, 9);`,
        body: `state.mut().result = FOLD_MAX_K;`,
        expected: 9n,
    },
    "constexpr abs folds": {
        declarations: `static constexpr sint64 FOLD_ABS_K = abs(-4);`,
        body: `state.mut().result = (uint64)FOLD_ABS_K;`,
        expected: 4n,
    },
    "constexpr div by zero folds to zero": {
        declarations: `static constexpr uint64 FOLD_DIV0_K = div(10, 0);`,
        body: `state.mut().result = FOLD_DIV0_K;`,
        expected: 0n,
    },
    "constexpr less than folds": {
        declarations: `static constexpr uint64 FOLD_LT_K = 1 < 2;`,
        body: `state.mut().result = FOLD_LT_K;`,
        expected: 1n,
    },
};

describe("edge audit — constexpr folding", () => {
    beforeAll(async () => {
        await initK12();
    });

    for (const [name, testCase] of Object.entries(CASES)) {
        test(name, async () => {
            expect(await run(wrap(testCase.declarations, testCase.body))).toBe(testCase.expected);
        });
    }
});
