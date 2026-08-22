// Two rules hold for every fixture here, because the defects this suite exists for were all silent.
//
// A fixture must disagree with the path it replaces: its declared body computes something the
// fallback — byte comparison, memberwise copy, the first-declared candidate — cannot produce, so a
// test cannot pass on the path it is meant to prove is gone.
//
// A test must have been seen to fail. Revert the fix and watch it go red before trusting it; a test
// that has never failed has not been shown to test anything.
import { beforeAll, describe, expect } from "bun:test";
import { initK12 } from "@qinit/core";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { edgeCompiler, edgeRunner } from "../support/edge-compile";
import { HAS_CORE } from "../../../../test-utils/paths";
import { bothDeclarationOrders, fixtureTest } from "../support/fixture-shapes";
import { ASSIGNING, FEE_AMOUNT, HALF_KEY, HELPER_MONEY, MONEY, wrapOperatorFixture as wrap } from "../support/operator-fixtures";

const run = edgeRunner("OperatorOverload");
const compile = edgeCompiler("OperatorOverload");

// operator== deliberately ignores `b`, so {1,2} and {1,99} are equal to the operator and different
// to memcmp. Every assertion below turns on that disagreement.

describe.skipIf(!HAS_CORE)("operator overload resolution", () => {
    beforeAll(initK12);

    fixtureTest("a declared operator== decides equality, not the bytes", async () => {
        const source = wrap(
            HALF_KEY,
            "HalfKey left; HalfKey right;",
            `locals.left = { 1, 2 };
       locals.right = { 1, 99 };
       state.mut().result = (locals.left == locals.right) ? 1 : 0;`,
        );

        // Byte equality would answer 0 here; only the declared body answers 1.
        expect(await run(source)).toBe(1n);
    });

    fixtureTest("!= is rewritten from operator== when only == is declared", async () => {
        const source = wrap(
            HALF_KEY,
            "HalfKey left; HalfKey right;",
            `locals.left = { 1, 2 };
       locals.right = { 1, 99 };
       state.mut().result = (locals.left != locals.right) ? 1 : 0;`,
        );

        // C++20 rewrites this to !(left == right). Byte inequality would answer 1.
        expect(await run(source)).toBe(0n);
    });

    // Core hashes a key by its raw bytes (KangarooTwelve over sizeof(KeyT)) but probes slots with
    // operator==. A key whose equality disagrees with its bytes therefore misses its own slot, in
    // both backends — the map is only coherent when the two notions agree. Pinned so the behaviour
    // is a recorded consequence rather than a surprise.
    fixtureTest("a byte-different probe misses its slot even when the operator calls it equal", async () => {
        const source = wrap(
            `${HALF_KEY}
  struct Pair { uint64 x; uint64 y; };`,
            "HalfKey stored; HalfKey probe;",
            `locals.stored = { 1, 2 };
       locals.probe = { 1, 99 };
       state.mut().map.set(locals.stored, { 7, 8 });
       state.mut().result = state.get().map.get(locals.probe, locals.hit) ? locals.hit.x : 0;`,
        )
            .replace("struct StateData { uint64 result; };", "struct StateData { uint64 result; HashMap<HalfKey, Pair, 1024> map; };")
            .replace("HalfKey stored; HalfKey probe;", "HalfKey stored; HalfKey probe; Pair hit;");

        // The probe differs from the stored key in `b`, so it hashes elsewhere and the declared
        // operator is never consulted for that slot.
        expect(await run(source)).toBe(0n);

        // The same key round-trips, which is the case the container is actually built for.
        expect(await run(source.replace("locals.probe = { 1, 99 };", "locals.probe = { 1, 2 };"))).toBe(7n);
    });

    fixtureTest("a key type with no operator== is rejected the way Clang rejects it", async () => {
        const source = wrap(
            `struct BareKey { uint64 a; uint64 b; };
  struct Pair { uint64 x; uint64 y; };`,
            "BareKey key;",
            `locals.key = { 1, 2 };
       state.mut().map.set(locals.key, { 7, 8 });`,
        ).replace("struct StateData { uint64 result; };", "struct StateData { uint64 result; HashMap<BareKey, Pair, 1024> map; };");

        const result = await compile(source);
        const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR);

        expect(errors.map((diagnostic) => diagnostic.message).join(" ")).toContain("no viable operator== for 'BareKey'");
    });

    fixtureTest("a relational operator with no candidate is reported the same way", async () => {
        const source = wrap(
            "struct BareKey { uint64 a; uint64 b; };",
            "BareKey left; BareKey right;",
            `locals.left = { 1, 2 };
       locals.right = { 3, 4 };
       state.mut().result = (locals.left < locals.right) ? 1 : 0;`,
        );

        const result = await compile(source);
        const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR);

        expect(errors.map((diagnostic) => diagnostic.message).join(" ")).toContain("no viable operator< for 'BareKey'");
    });

    fixtureTest("a declared unary operator is called", async () => {
        const source = wrap(
            "struct Flag { uint64 v; bit operator!() const { return v == 0; } };",
            "Flag flag;",
            `locals.flag = { 0 };
       state.mut().result = (!locals.flag) ? 1 : 0;`,
        );

        // v is 0, so the declared operator! answers true.
        expect(await run(source)).toBe(1n);
    });

    // `Price` is also a core oracle interface (src/oracle_interfaces/Price.h), a struct with no data
    // members. C++ resolves the nested declaration; a lookup that answers with the global one hands
    // the operator body an empty `this`, so the comparison can never see a field. The name is taken
    // from core on purpose — the test should break if that collision ever disappears upstream.
    const SHADOWED = (compared: string) => `struct Price {
    uint64 a;
    uint64 b;
    bit operator==(const Price& other) const { return ${compared} == other.${compared}; }
  };`;

    fixtureTest("a nested type shadows a global one of the same name", async () => {
        const source = wrap(
            SHADOWED("a"),
            "Price left; Price right;",
            `locals.left = { 7, 1 };
       locals.right = { 7, 2 };
       state.mut().result = (locals.left == locals.right) ? 1 : 0;`,
        );

        // The operands differ in `b`, so only the declared body — reading the contract's own Price —
        // answers 1.
        expect(await run(source)).toBe(1n);
    });

    // Comparing the second field pins the layout rather than its mere presence: a body compiled
    // against the wrong declaration cannot land on the right offset.
    fixtureTest("a shadowed type's operator reads its own field offsets", async () => {
        const source = wrap(
            SHADOWED("b"),
            "Price left; Price right;",
            `locals.left = { 1, 9 };
       locals.right = { 2, 9 };
       state.mut().result = (locals.left == locals.right) ? 1 : 0;`,
        );

        // Reading offset 0 instead would compare 1 against 2 and answer 0.
        expect(await run(source)).toBe(1n);
    });

    // `FeeAmount(n)` is spelled as a call, so it has no address of its own. Each case below is one a
    // Clang build accepts. The constructor scales its argument, so a field-wise fallback that skipped
    // it would store 5 where the declared body stores 51.

    fixtureTest("a constructor call assigns to an aggregate local", async () => {
        const source = wrap(
            FEE_AMOUNT,
            "FeeAmount bid;",
            `locals.bid = FeeAmount(5);
       state.mut().result = locals.bid.qus;`,
        );

        expect(await run(source)).toBe(51n);
    });

    fixtureTest("a constructor call is a comparison operand", async () => {
        const source = wrap(
            FEE_AMOUNT,
            "FeeAmount bid;",
            `locals.bid = FeeAmount(5);
       state.mut().result = (locals.bid == FeeAmount(5)) ? 1 : 0;`,
        );

        expect(await run(source)).toBe(1n);
    });

    // The parameter is `const FeeAmount&` and the argument is a number, so the converting constructor
    // has to run: it turns 5 into 51, which is what the left operand holds.
    fixtureTest("a scalar converts to the parameter's class", async () => {
        const source = wrap(
            FEE_AMOUNT,
            "FeeAmount bid;",
            `locals.bid = FeeAmount(5);
       state.mut().result = (locals.bid == 5) ? 1 : 0;`,
        );

        expect(await run(source)).toBe(1n);
    });

    fixtureTest("a constructor call is the left operand", async () => {
        const source = wrap(
            FEE_AMOUNT,
            "FeeAmount bid;",
            `locals.bid = FeeAmount(5);
       state.mut().result = (FeeAmount(5) == locals.bid) ? 1 : 0;`,
        );

        expect(await run(source)).toBe(1n);
    });

    // QPI::DateAndTime declares method bodies of its own, and the method index is keyed by the bare
    // class name. The field is called `value` to match QPI's, so QPI's operator== compiles against
    // this struct and answers wrongly instead of failing to compile — the silent case, which is the
    // one worth pinning.
    fixtureTest("a nested class runs its own methods, not a same-named QPI type's", async () => {
        const source = wrap(
            `struct DateAndTime {
    uint64 value;
    bit operator==(const DateAndTime& other) const { return 1; }
  };`,
            "DateAndTime left; DateAndTime right;",
            `locals.left.value = 1;
       locals.right.value = 2;
       state.mut().result = (locals.left == locals.right) ? 1 : 0;`,
        );

        // The declared body ignores the values. QPI::DateAndTime's compares them and would answer 0.
        expect(await run(source)).toBe(1n);
    });

    // Two operator== overloads of the same arity. The class one compares, the scalar one always
    // answers false, so picking the wrong body is visible in the result rather than in a diagnostic.
    const twoOverloads = (members: string) => `struct Two {
    uint64 q;
    Two() { q = 0; }
    Two(uint64 v) { q = v; }
    ${members}
  };`;
    const TWO_CANDIDATES = ["bit operator==(const Two& other) const { return q == other.q; }", "bit operator==(uint64 scalar) const { return 0; }"];

    for (const { order, members } of bothDeclarationOrders(TWO_CANDIDATES)) {
        fixtureTest(`a class-typed argument picks the class overload, ${order}`, async () => {
            const source = wrap(
                twoOverloads(members),
                "Two t;",
                `locals.t = Two(1);
       state.mut().result = (locals.t == Two(1)) ? 1 : 0;`,
            );

            expect(await run(source)).toBe(1n);
        });

        fixtureTest(`a scalar argument picks the scalar overload, ${order}`, async () => {
            const source = wrap(
                twoOverloads(members),
                "Two t;",
                `locals.t = Two(1);
       state.mut().result = (locals.t == 1) ? 1 : 0;`,
            );

            // The scalar body answers false. Reaching the class body instead would convert 1 and answer 1.
            expect(await run(source)).toBe(0n);
        });
    }

    // An operator that returns its own class produces an rvalue with no home of its own. The
    // constructor scales, so a comparison that skipped either body would not answer 1.

    fixtureTest("an operator result is a comparison operand", async () => {
        const source = wrap(
            MONEY,
            "Money a; Money b;",
            `locals.a = Money(2);
       locals.b = Money(3);
       state.mut().result = ((locals.a + locals.b) == Money(5)) ? 1 : 0;`,
        );

        expect(await run(source)).toBe(1n);
    });

    fixtureTest("an operator result is an argument", async () => {
        const source = wrap(
            MONEY,
            "Money a; Money b; Money total;",
            `locals.a = Money(2);
       locals.b = Money(3);
       locals.total = Money(5);
       state.mut().result = (locals.total == (locals.a + locals.b)) ? 1 : 0;`,
        );

        expect(await run(source)).toBe(1n);
    });

    // Both bodies compute something a memberwise copy would not, so a memcpy cannot answer for them.

    fixtureTest("a declared operator= runs instead of a memberwise copy", async () => {
        const source = wrap(
            ASSIGNING,
            "Box a; Box b;",
            `locals.a.v = 5;
       locals.b = locals.a;
       state.mut().result = locals.b.v;`,
        );

        expect(await run(source)).toBe(10n);
    });

    fixtureTest("a declared compound assignment runs", async () => {
        const source = wrap(
            ASSIGNING,
            "Box a; Box b;",
            `locals.a.v = 5;
       locals.b.v = 1;
       locals.b += locals.a;
       state.mut().result = locals.b.v;`,
        );

        expect(await run(source)).toBe(106n);
    });

    // A class that declares nothing keeps the copy C++ gives it implicitly.
    fixtureTest("a class with no declared assignment is still copied", async () => {
        const source = wrap(
            "struct Plain { uint64 v; uint64 w; };",
            "Plain source; Plain target;",
            `locals.source.v = 5;
       locals.source.w = 9;
       locals.target = locals.source;
       state.mut().result = locals.target.w;`,
        );

        expect(await run(source)).toBe(9n);
    });

    // A helper returns its class by value, so the comparison's left operand is a call with no home.

    fixtureTest("a helper's result is a comparison operand", async () => {
        const source = wrap(
            HELPER_MONEY,
            "Money m;",
            `locals.m = Money(5);
       state.mut().result = (makeMoney(5) == locals.m) ? 1 : 0;`,
        );

        expect(await run(source)).toBe(1n);
    });

    // The shape the uint128 fuzz corpus compares: a template helper's result on the left.
    fixtureTest("a template helper's result is a comparison operand", async () => {
        const source = wrap(
            "",
            "uint128 a; uint128 b;",
            `locals.a = uint128(0, 8);
       locals.b = uint128(0, 4);
       state.mut().result = (div<uint128>(locals.a, locals.b) == uint128(0, 2)) ? 1 : 0;`,
        );

        expect(await run(source)).toBe(1n);
    });

    // Two scalar overloads of one arity. Which one a literal binds to is a conversion-rank question,
    // not a source-order one, so both declaration orders must answer the same.
    const SCALAR_CANDIDATES = ["uint64 pick(uint64 wide) const { return 1; }", "uint64 pick(sint32 narrow) const { return 2; }"];

    for (const { order, members } of bothDeclarationOrders(SCALAR_CANDIDATES)) {
        const declaration = `struct Sc {\n    ${members}\n  };`;

        fixtureTest(`an int literal picks the int parameter, ${order}`, async () => {
            const source = wrap(declaration, "Sc s;", "state.mut().result = locals.s.pick(7);");

            // 7 is an int: sint32 is an exact match, uint64 only a conversion.
            expect(await run(source)).toBe(2n);
        });

        fixtureTest(`an unsigned long long literal picks the 64-bit parameter, ${order}`, async () => {
            const source = wrap(declaration, "Sc s;", "state.mut().result = locals.s.pick(7ull);");

            expect(await run(source)).toBe(1n);
        });
    }

    // m256i's own operators are x86 intrinsics, so the backend substitutes a byte compare for them.
    // That substitution has to keep working, and has to keep meaning "all 32 bytes".
    fixtureTest("id equality still compares the whole value", async () => {
        const equal = wrap(
            "",
            "id left; id right;",
            `locals.left = id(1, 2, 3, 4);
       locals.right = id(1, 2, 3, 4);
       state.mut().result = (locals.left == locals.right) ? 1 : 0;`,
        );
        const differsInLastLimb = wrap(
            "",
            "id left; id right;",
            `locals.left = id(1, 2, 3, 4);
       locals.right = id(1, 2, 3, 5);
       state.mut().result = (locals.left == locals.right) ? 1 : 0;`,
        );

        expect(await run(equal)).toBe(1n);
        expect(await run(differsInLastLimb)).toBe(0n);
    });
});
