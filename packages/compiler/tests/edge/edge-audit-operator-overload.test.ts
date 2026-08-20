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
