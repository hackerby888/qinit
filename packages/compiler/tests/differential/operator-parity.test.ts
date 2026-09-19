// The operator edge suite asserts what each declared body should compute; this builds the same source with Clang, so an expectation cannot be wrong in both.
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";
import { PARITY_ARENA_BYTES, PARITY_SLOT, clangState, runState } from "../support/parity-runner";
import {
    ASSIGNING,
    COMPOUND,
    FEE_AMOUNT,
    HALF_KEY,
    HALF_KEY_BOOL,
    HELPER_MONEY,
    INDEXED,
    MONEY,
    wrapOperatorFixture as wrap,
} from "../support/operator-fixtures";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";

interface ParityCase {
    name: string;
    source: string;
    expected: bigint;
}

const CASES: ParityCase[] = [
    {
        name: "DeclaredEquality",
        source: wrap(
            HALF_KEY,
            "HalfKey left; HalfKey right;",
            `locals.left = { 1, 2 };
       locals.right = { 1, 99 };
       state.mut().result = (locals.left == locals.right) ? 1 : 0;`,
        ),
        expected: 1n,
    },
    {
        name: "ScalarConversion",
        source: wrap(
            FEE_AMOUNT,
            "FeeAmount bid;",
            `locals.bid = FeeAmount(5);
       state.mut().result = (locals.bid == 5) ? 1 : 0;`,
        ),
        expected: 1n,
    },
    {
        name: "OperatorResultOperand",
        source: wrap(
            MONEY,
            "Money a; Money b;",
            `locals.a = Money(2);
       locals.b = Money(3);
       state.mut().result = ((locals.a + locals.b) == Money(5)) ? 1 : 0;`,
        ),
        expected: 1n,
    },
    {
        name: "DeclaredAssignment",
        source: wrap(
            ASSIGNING,
            "Box a; Box b;",
            `locals.a.v = 5;
       locals.b = locals.a;
       state.mut().result = locals.b.v;`,
        ),
        expected: 10n,
    },
    {
        name: "DeclaredCompoundAssignment",
        source: wrap(
            ASSIGNING,
            "Box a; Box b;",
            `locals.a.v = 5;
       locals.b.v = 1;
       locals.b += locals.a;
       state.mut().result = locals.b.v;`,
        ),
        expected: 106n,
    },
    {
        name: "RewrittenInequality",
        source: wrap(
            HALF_KEY_BOOL,
            "BoolKey left; BoolKey right;",
            `locals.left = { 1, 2 };
       locals.right = { 1, 99 };
       state.mut().result = (locals.left != locals.right) ? 1 : 0;`,
        ),
        // C++20 rewrites this to !(left == right), and that operator ignores `b`.
        expected: 0n,
    },
    {
        name: "CompoundOperators",
        source: wrap(
            COMPOUND,
            "Acc a; Acc b;",
            `locals.a.v = 100;
       locals.b.v = 3;
       locals.a -= locals.b;
       locals.a *= locals.b;
       locals.a <<= locals.b;
       state.mut().result = locals.a.v;`,
        ),
        // 100 - 3 + 1000 = 1097; 1097 * 3 + 7 = 3298; (3298 << 3) | 1 = 26385.
        expected: 26385n,
    },
    {
        name: "SubscriptOperator",
        source: wrap(
            INDEXED,
            "Row row;",
            `locals.row.cells[2] = 5;
       state.mut().result = locals.row[2];`,
        ),
        // The declared body folds the index in; reading cells[2] straight would answer 5.
        expected: 52n,
    },
    {
        name: "TernaryOperand",
        source: wrap(
            MONEY,
            "Money a; Money b;",
            `locals.a = Money(2);
       locals.b = Money(3);
       state.mut().result = (((locals.a.qus < locals.b.qus) ? locals.a : locals.b) == Money(2)) ? 1 : 0;`,
        ),
        expected: 1n,
    },
    {
        name: "HelperResultOperand",
        source: wrap(
            HELPER_MONEY,
            "Money m;",
            `locals.m = Money(5);
       state.mut().result = (makeMoney(5) == locals.m) ? 1 : 0;`,
        ),
        expected: 1n,
    },
    // An `auto` local has its initializer's C++ type, so it wraps at that width; every row would differ under a 64-bit local.
    {
        name: "AutoFromNarrowMember",
        source: wrap(
            "",
            "uint8 narrow;",
            `locals.narrow = 200;
       auto copy = locals.narrow;
       copy += 100;
       state.mut().result = copy;`,
        ),
        expected: 44n,
    },
    {
        name: "AutoFromSignedNarrowMember",
        source: wrap(
            "",
            "sint8 narrow;",
            `locals.narrow = 100;
       auto copy = locals.narrow;
       copy += 100;
       state.mut().result = (uint64)(sint64)copy;`,
        ),
        expected: 0xffffffffffffffc8n,
    },
    {
        name: "AutoFromUnsignedMember",
        source: wrap(
            "",
            "uint32 counter;",
            `locals.counter = 4294967295u;
       auto next = locals.counter;
       next += 1;
       state.mut().result = next;`,
        ),
        expected: 0n,
    },
    {
        name: "AutoFromArithmetic",
        source: wrap(
            "",
            "uint32 counter;",
            `locals.counter = 4294967295u;
       auto next = locals.counter + 0u;
       next += 1;
       state.mut().result = next;`,
        ),
        expected: 0n,
    },
    {
        name: "AutoFromLiteral",
        source: wrap(
            "",
            "uint64 unused;",
            `auto value = 4294967295u;
       value += 2;
       state.mut().result = value;`,
        ),
        expected: 1n,
    },
    {
        name: "AutoFromPromotedSum",
        source: wrap(
            "",
            "uint8 left; uint8 right;",
            `locals.left = 200;
       locals.right = 100;
       auto sum = locals.left + locals.right;
       state.mut().result = sum;`,
        ),
        // Two uint8 operands promote to int, so the sum does not wrap at 256.
        expected: 300n,
    },
    {
        name: "AutoFromComparison",
        source: wrap(
            "",
            "uint64 limit;",
            `locals.limit = 9;
       auto over = locals.limit > 5;
       over += 1;
       state.mut().result = over;`,
        ),
        expected: 1n,
    },
    {
        name: "AutoFromTernary",
        source: wrap(
            "",
            "uint8 left; uint8 right;",
            `locals.left = 250;
       locals.right = 1;
       auto picked = locals.right ? locals.left : locals.right;
       picked += 10;
       state.mut().result = picked;`,
        ),
        expected: 4n,
    },
    {
        name: "AutoFromContextCall",
        source: wrap(
            "",
            "uint64 unused;",
            `auto tick = qpi.tick();
       tick -= tick + 1;
       state.mut().result = tick;`,
        ),
        expected: 4294967295n,
    },
    {
        name: "AutoFromWideMember",
        source: wrap(
            "",
            "uint64 wide;",
            `locals.wide = 1099511627776;
       auto copy = locals.wide;
       copy += 1;
       state.mut().result = copy;`,
        ),
        expected: 1099511627777n,
    },
];

const wasi = wasiToolchain();

describe.skipIf(!HAS_CORE)("operator lowering matches Clang on the same source", () => {
    beforeAll(initK12);

    for (const parityCase of CASES) {
        toolchainTest(
            parityCase.name,
            wasi,
            async () => {
                const mine = await compileContractWithTypeScript({
                    source: parityCase.source,
                    contractName: parityCase.name,
                    slot: PARITY_SLOT,
                    qpiHeader: loadQpiHeader(CORE_PATH),
                    arenaSizeBytes: PARITY_ARENA_BYTES,
                });
                expect(mine.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

                const ours = runState(mine.wasm);
                const theirs = await clangState(parityCase.name, parityCase.source, "operator-parity");

                // Parity is the claim; the pinned value says which answer both are expected to reach.
                expect(ours).toBe(theirs);
                expect(ours).toBe(parityCase.expected);
            },
            180000,
        );
    }
});

// An initializer whose type cannot be named would leave a 64-bit local that never wraps, so a strict build refuses it.
describe.skipIf(!HAS_CORE)("an auto local with no deducible type", () => {
    test("is refused by name", async () => {
        const compiled = await compileContractWithTypeScript({
            source: wrap("", "uint64 unused;", "auto nothing = nullptr; state.mut().result = 0;"),
            contractName: "AutoUndeducible",
            slot: PARITY_SLOT,
            qpiHeader: loadQpiHeader(CORE_PATH),
            arenaSizeBytes: PARITY_ARENA_BYTES,
        });
        const errors = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR).map((diagnostic) => diagnostic.message);

        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain("type deduction for auto local 'nothing'");
    });
});
