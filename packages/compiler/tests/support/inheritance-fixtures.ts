// Probe contracts for inheritance. Every fixture makes the derived body compute something a base-only
// or memberwise guess would not, so a wrong answer is a different number rather than a crash.
import { wrapOperatorFixture as wrap } from "./operator-fixtures";

export interface InheritanceCase {
    name: string;
    source: string;
    /** What Clang computes from this source. Pinned from its build, never from arithmetic here. */
    expected: bigint;
}

export const CASES: InheritanceCase[] = [
    {
        name: "BaseFieldFromDerivedMethod",
        expected: 42n,
        source: wrap(`struct B { uint64 v; };
  struct D : B { uint64 twice() const { return v * 2; } };`, "D d;", `locals.d.v = 21;
       state.mut().result = locals.d.twice();`),
    },
    {
        // D declares nothing, so it has no method table of its own: the lookup has to reach the base.
        name: "InheritedMethodThroughDerived",
        expected: 42n,
        source: wrap(`struct B { uint64 v; uint64 own() const { return v + 1; } };
  struct D : B { };`, "D d;", `locals.d.v = 41;
       state.mut().result = locals.d.own();`),
    },
    {
        name: "DerivedShadowsBaseMethod",
        expected: 42n,
        source: wrap(`struct B { uint64 v; uint64 own() const { return 1; } };
  struct D : B { uint64 own() const { return 42; } };`, "D d;", `state.mut().result = locals.d.own();`),
    },
    {
        name: "ThreeLevelsDeep",
        expected: 42n,
        source: wrap(`struct A { uint64 v; };
  struct B : A { };
  struct C : B { uint64 read() const { return v + 2; } };`, "C c;", `locals.c.v = 40;
       state.mut().result = locals.c.read();`),
    },
    {
        // A derived class constructs its base first, whether or not it declares a constructor.
        name: "BaseConstructorRuns",
        expected: 42n,
        source: wrap(`struct B { uint64 v; B() { v = 42; } };
  struct D : B { };`, "D d;", `locals.d = D();
       state.mut().result = locals.d.v;`),
    },
    {
        name: "BaseConstructorRunsBeforeDerived",
        expected: 421n,
        source: wrap(`struct B { uint64 v; B() { v = 42; } };
  struct D : B { uint64 w; D() { w = 1; } };`, "D d;", `locals.d = D();
       state.mut().result = locals.d.v * 10 + locals.d.w;`),
    },
    {
        // operator== ignores `b`, so a byte compare answers 0 and the inherited body answers 1.
        name: "OperatorInheritedFromBase",
        expected: 1n,
        source: wrap(`struct B { uint64 a; uint64 b; bool operator==(const B& other) const { return a == other.a; } };
  struct D : B { };`, "D x; D y;", `locals.x.a = 1; locals.x.b = 2;
       locals.y.a = 1; locals.y.b = 99;
       state.mut().result = (locals.x == locals.y) ? 1 : 0;`),
    },
    {
        name: "DerivedFieldShadowsBase",
        expected: 42n,
        source: wrap(`struct B { uint64 v; };
  struct D : B { uint64 v; uint64 mine() const { return v; } };`, "D d;", `locals.d.v = 42;
       state.mut().result = locals.d.mine();`),
    },
    {
        name: "BaseMethodMutatesBaseField",
        expected: 42n,
        source: wrap(`struct B { uint64 v; void bump() { v = v + 2; } };
  struct D : B { void twice() { bump(); bump(); } };`, "D d;", `locals.d.v = 38;
       locals.d.twice();
       state.mut().result = locals.d.v;`),
    },
    {
        // The base is an instantiation, so the derived body reads a field whose width came from T.
        name: "BaseIsTemplateInstance",
        expected: 200100n,
        source: wrap(`template <typename T> struct B { T v; T doubled() const { return v * 2; } };
  struct D : B<uint8> { uint64 both() const { return doubled() * 1000 + v; } };`, "D d;", `locals.d.v = 100;
       state.mut().result = locals.d.both();`),
    },
];
