// The Wasm backend used to compare any two aggregates as bytes, which silently ignored a declared
// operator== and accepted key types Clang rejects. Each case here compares values whose byte
// equality and declared equality disagree, so a byte comparison cannot produce the asserted answer.
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { edgeCompiler, edgeRunner } from "../support/edge-compile";
import { HAS_CORE } from "../../../../test-utils/paths";

const run = edgeRunner("OperatorOverload");
const compile = edgeCompiler("OperatorOverload");

// operator== deliberately ignores `b`, so {1,2} and {1,99} are equal to the operator and different
// to memcmp. Every assertion below turns on that disagreement.
const HALF_KEY = `struct HalfKey {
    uint64 a;
    uint64 b;
    bit operator==(const HalfKey& other) const { return a == other.a; }
  };`;

const wrap = (declarations: string, locals: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  ${declarations}
  struct StateData { uint64 result; };
  struct Go_input {}; struct Go_output {};
  struct Go_locals { ${locals} };
  PUBLIC_PROCEDURE_WITH_LOCALS(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

describe.skipIf(!HAS_CORE)("operator overload resolution", () => {
    beforeAll(initK12);

    test("a declared operator== decides equality, not the bytes", async () => {
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

    test("!= is rewritten from operator== when only == is declared", async () => {
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
    test("a byte-different probe misses its slot even when the operator calls it equal", async () => {
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

    test("a key type with no operator== is rejected the way Clang rejects it", async () => {
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

    test("a relational operator with no candidate is reported the same way", async () => {
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

    test("a declared unary operator is called", async () => {
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

    test("a nested type shadows a global one of the same name", async () => {
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
    test("a shadowed type's operator reads its own field offsets", async () => {
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
    const FEE_AMOUNT = `struct FeeAmount {
    uint64 qus;
    FeeAmount() { qus = 0; }
    FeeAmount(uint64 value) { qus = value * 10 + 1; }
    bit operator==(const FeeAmount& other) const { return qus == other.qus; }
  };`;

    test("a constructor call assigns to an aggregate local", async () => {
        const source = wrap(
            FEE_AMOUNT,
            "FeeAmount bid;",
            `locals.bid = FeeAmount(5);
       state.mut().result = locals.bid.qus;`,
        );

        expect(await run(source)).toBe(51n);
    });

    test("a constructor call is a comparison operand", async () => {
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
    test("a scalar converts to the parameter's class", async () => {
        const source = wrap(
            FEE_AMOUNT,
            "FeeAmount bid;",
            `locals.bid = FeeAmount(5);
       state.mut().result = (locals.bid == 5) ? 1 : 0;`,
        );

        expect(await run(source)).toBe(1n);
    });

    test("a constructor call is the left operand", async () => {
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
    test("a nested class runs its own methods, not a same-named QPI type's", async () => {
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
    const TWO_OVERLOADS = `struct Two {
    uint64 q;
    Two() { q = 0; }
    Two(uint64 v) { q = v; }
    bit operator==(const Two& other) const { return q == other.q; }
    bit operator==(uint64 scalar) const { return 0; }
  };`;

    test("a class-typed argument picks the class overload", async () => {
        const source = wrap(
            TWO_OVERLOADS,
            "Two t;",
            `locals.t = Two(1);
       state.mut().result = (locals.t == Two(1)) ? 1 : 0;`,
        );

        expect(await run(source)).toBe(1n);
    });

    test("a scalar argument picks the scalar overload", async () => {
        const source = wrap(
            TWO_OVERLOADS,
            "Two t;",
            `locals.t = Two(1);
       state.mut().result = (locals.t == 1) ? 1 : 0;`,
        );

        // The scalar body answers false. Reaching the class body instead would convert 1 and answer 1.
        expect(await run(source)).toBe(0n);
    });

    // An operator that returns its own class produces an rvalue with no home of its own. The
    // constructor scales, so a comparison that skipped either body would not answer 1.
    const MONEY = `struct Money {
    uint64 qus;
    Money() { qus = 0; }
    Money(uint64 value) { qus = value * 10 + 1; }
    Money operator+(const Money& other) const { return Money((qus + other.qus - 2) / 10); }
    bit operator==(const Money& other) const { return qus == other.qus; }
  };`;

    test("an operator result is a comparison operand", async () => {
        const source = wrap(
            MONEY,
            "Money a; Money b;",
            `locals.a = Money(2);
       locals.b = Money(3);
       state.mut().result = ((locals.a + locals.b) == Money(5)) ? 1 : 0;`,
        );

        expect(await run(source)).toBe(1n);
    });

    test("an operator result is an argument", async () => {
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

    // m256i's own operators are x86 intrinsics, so the backend substitutes a byte compare for them.
    // That substitution has to keep working, and has to keep meaning "all 32 bytes".
    test("id equality still compares the whole value", async () => {
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
