// Probe contracts for user-declared templates. Every fixture is built so a wrong answer is a
// different number, not a crash: two instantiations of one template compute different values from
// the same input, and both land in the single `result` field.
import { wrapOperatorFixture as wrap } from "./operator-fixtures";

export interface TemplateCase {
    name: string;
    source: string;
    /** What Clang computes from this source. Pinned from its build, never from arithmetic here. */
    expected: bigint;
}

// `v * 3 + 1` at 100 is 301 in uint64 and 45 in uint8, so an instantiation compiled once and reused
// for both widths answers 301 twice.
const WRAP = `template <typename T> struct Wrap {
    T v;
    T scaled() const { return v * 3 + 1; }
  };`;

const KEY = `template <typename T> struct Key {
    T a;
    T b;
    bool operator==(const Key& other) const { return a == other.a; }
  };`;

const AMOUNT = `template <typename T> struct Amount {
    T v;
    Amount() { v = 0; }
    Amount(T value) { v = value * 10 + 1; }
    bool operator==(const Amount& other) const { return v == other.v; }
  };`;

export const CASES: TemplateCase[] = [
    {
        name: "TwoInstantiations",
        expected: 301045n,
        source: wrap(
            WRAP,
            "Wrap<uint64> big; Wrap<uint8> small;",
            `locals.big.v = 100;
       locals.small.v = 100;
       state.mut().result = locals.big.scaled() * 1000 + locals.small.scaled();`,
        ),
    },
    {
        // The same two instantiations, touched the other way round. A cache that answers with
        // whichever body compiled first fails exactly one of this pair.
        name: "InstantiationOrder",
        expected: 45301n,
        source: wrap(
            WRAP,
            "Wrap<uint64> big; Wrap<uint8> small;",
            `locals.small.v = 100;
       locals.big.v = 100;
       state.mut().result = locals.small.scaled() * 1000 + locals.big.scaled();`,
        ),
    },
    {
        // `>>` on a signed T is arithmetic and on an unsigned T is logical. One shared lowering for
        // both instantiations gets one of them wrong.
        name: "SignednessThroughT",
        expected: 9223372036854775800n,
        source: wrap(
            `template <typename T> struct Shifter {
    T v;
    T half() const { return v >> 1; }
  };`,
            "Shifter<sint64> negative; Shifter<uint64> wide;",
            `locals.negative.v = -8;
       locals.wide.v = 0xFFFFFFFFFFFFFFF8ULL;
       state.mut().result = ((uint64)locals.negative.half()) + locals.wide.half();`,
        ),
    },
    {
        // operator== declared inside a template: overload resolution has to run per instantiation.
        name: "TemplateOperatorEquality",
        expected: 11n,
        source: wrap(
            KEY,
            "Key<uint64> left; Key<uint64> right; Key<uint8> narrowLeft; Key<uint8> narrowRight;",
            `locals.left = { 1, 2 };
       locals.right = { 1, 99 };
       locals.narrowLeft = { 1, 2 };
       locals.narrowRight = { 1, 99 };
       state.mut().result = ((locals.left == locals.right) ? 1 : 0) * 10 + ((locals.narrowLeft == locals.narrowRight) ? 1 : 0);`,
        ),
    },
    {
        name: "NonTypeParameter",
        expected: 33077n,
        source: wrap(
            `template <uint64 N> struct Scaled {
    uint64 v;
    uint64 f() const { return v * N + N; }
  };`,
            "Scaled<3> three; Scaled<7> seven;",
            `locals.three.v = 10;
       locals.seven.v = 10;
       state.mut().result = locals.three.f() * 1000 + locals.seven.f();`,
        ),
    },
    {
        // A contract template spelled like one core declares. The declaration-id fix keys plain
        // classes by declaration; a template instance is keyed by name and arguments only.
        name: "CoreTemplateNameCollision",
        expected: 12n,
        source: wrap(
            `template <typename T, uint64 L> struct Array {
    T items[L];
    T get(uint64 index) const { return items[index] + 7; }
  };`,
            "Array<uint64, 4> row;",
            `locals.row.items[2] = 5;
       state.mut().result = locals.row.get(2);`,
        ),
    },
    {
        name: "MemberFunctionTemplate",
        expected: 42144n,
        source: wrap(
            `struct Picker {
    template <typename T> T twice(T value) const { return value * 2; }
  };`,
            "Picker picker;",
            `state.mut().result = locals.picker.twice<uint64>(21) * 1000 + locals.picker.twice<uint8>(200);`,
        ),
    },
    {
        // Explicit specialization sits at file scope: specializing inside a class is not valid C++,
        // and a fixture Clang rejects would read as a gap in our compiler.
        name: "ExplicitSpecialization",
        expected: 12n,
        source: wrap(
            "",
            "Tag<uint64> general; Tag<uint8> special;",
            `state.mut().result = locals.general.id() * 10 + locals.special.id();`,
            `template <typename T> struct Tag { uint64 id() const { return 1; } };
template <> struct Tag<uint8> { uint64 id() const { return 2; } };`,
        ),
    },
    {
        name: "NestedInstantiation",
        expected: 42n,
        source: wrap(
            `template <typename T> struct Cell {
    T v;
    T get() const { return v; }
  };`,
            "Cell<Cell<uint64>> nested;",
            `locals.nested.v.v = 42;
       state.mut().result = locals.nested.get().v;`,
        ),
    },
    {
        // The base is an instantiation, so the derived body reads a field whose width came from T.
        name: "TemplateBaseClass",
        expected: 200300n,
        source: wrap(
            `template <typename T> struct Base {
    T v;
    T doubled() const { return v * 2; }
  };
  struct Derived : Base<uint8> {
    uint64 tripled() const { return v * 3; }
  };`,
            "Derived derived;",
            `locals.derived.v = 100;
       state.mut().result = locals.derived.doubled() * 1000 + locals.derived.tripled();`,
        ),
    },
    {
        name: "DefaultTemplateArgument",
        expected: 42n,
        source: wrap(
            `template <typename T = uint64> struct Def {
    T v;
    T f() const { return v + 1; }
  };`,
            "Def<> value;",
            `locals.value.v = 41;
       state.mut().result = locals.value.f();`,
        ),
    },
    {
        // A converting constructor inside a template: the scalar has to convert through the
        // instantiation's own T, not through whichever instantiation ranked first.
        name: "TemplateConversionConstructor",
        expected: 11n,
        source: wrap(
            AMOUNT,
            "Amount<uint64> wide; Amount<uint8> narrow;",
            `locals.wide = Amount<uint64>(5);
       locals.narrow = Amount<uint8>(5);
       state.mut().result = ((locals.wide == 5) ? 1 : 0) * 10 + ((locals.narrow == 5) ? 1 : 0);`,
        ),
    },
];
