// Every bug this pattern produced came from a lookup keyed by a class's name that answered only when
// the class owned an entry of its own. The shapes below are the ones that leave a class without one;
// the operations are the ones that consult such a lookup. Their product is generated rather than
// written out, so the combinations nobody thought of are covered too.

/** A class shape, plus how to spell the type and reach a uint64 field named `v`. */
export interface Shape {
    key: string;
    /** Declarations placed inside the contract. */
    declarations: string;
    /** The type a local of this shape is declared with. */
    type: string;
    /** The operations this shape's failure mode can actually reach, by key. */
    operations: readonly string[];
}

export const SHAPES: readonly Shape[] = [
    // The control: nothing unusual about it.
    { key: "own-methods", type: "Plain", operations: ["call-method", "equality"], declarations: `struct Plain { uint64 v; uint64 own() const { return v + 1; } bool operator==(const Plain& o) const { return v == o.v; } Plain() { v = 0; } };` },
    // Owns no methods at all, so a name-keyed table has no entry for it.
    { key: "inherits-all", type: "Heir", operations: ["call-method", "equality", "construct", "copy-assign"], declarations: `struct HeirBase { uint64 v; uint64 own() const { return v + 1; } bool operator==(const HeirBase& o) const { return v == o.v; } HeirBase() { v = 0; } };
  struct Heir : HeirBase { };` },
    // Spelled like a struct core declares.
    { key: "core-struct-name", type: "DateAndTime", operations: ["call-method", "equality", "construct"], declarations: `struct DateAndTime { uint64 v; uint64 own() const { return v + 1; } bool operator==(const DateAndTime& o) const { return v == o.v; } DateAndTime() { v = 0; } };` },
    // Its field is spelled like an enumerator core declares.
    { key: "member-named-v", type: "Holder", operations: ["call-method", "member-arithmetic", "member-shift"], declarations: `struct Holder { uint64 v; uint64 own() const { return v + 1; } bool operator==(const Holder& o) const { return v == o.v; } Holder() { v = 0; } };` },
    // Derives from an instantiation, so its fields' widths come from a template argument.
    { key: "derives-template", type: "FromTemplate", operations: ["call-method", "equality", "construct", "copy-assign"], declarations: `template <typename T> struct TemplateBase { T v; T own() const { return v + 1; } bool operator==(const TemplateBase& o) const { return v == o.v; } TemplateBase() { v = 0; } };
  struct FromTemplate : TemplateBase<uint64> { };` },
    // A template spelled like one core declares, instantiated by the contract.
    { key: "core-template-name", type: "Array<uint64, 2>", operations: ["call-method", "equality", "construct"], declarations: `template <typename T, uint64 L> struct Array { T v; T own() const { return v + 1; } bool operator==(const Array& o) const { return v == o.v; } Array() { v = 0; } };` },
    // Instantiated at a narrow argument, where a shared or unbound body reads the wrong width.
    { key: "narrow-template", type: "Narrow<uint8>", operations: ["call-method", "equality", "member-arithmetic", "member-shift", "copy-assign"], declarations: `template <typename T> struct Narrow { T v; T own() const { return v + 1; } bool operator==(const Narrow& o) const { return v == o.v; } Narrow() { v = 0; } };` },
];

/** An operation over two locals `a` and `b` of the shape's type, writing StateData.result. */
export interface Operation {
    key: string;
    body: string;
}

export const OPERATIONS: readonly Operation[] = [
    { key: "call-method", body: `locals.a.v = 41; state.mut().result = locals.a.own();` },
    { key: "equality", body: `locals.a.v = 7; locals.b.v = 7; state.mut().result = (locals.a == locals.b) ? 1 : 0;` },
    { key: "construct", body: `locals.a.v = 9; locals.a = TYPE(); state.mut().result = locals.a.v;` },
    { key: "member-arithmetic", body: `locals.a.v = 100; state.mut().result = locals.a.v * 3 + 1;` },
    { key: "copy-assign", body: `locals.a.v = 42; locals.b = locals.a; state.mut().result = locals.b.v;` },
    { key: "member-shift", body: `locals.a.v = 40; state.mut().result = (locals.a.v >> 1) + 22;` },
];

export function matrixSource(shape: Shape, operation: Operation): string {
    return `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  ${shape.declarations}
  struct StateData { uint64 result; };
  struct Go_input {}; struct Go_output {};
  struct Go_locals { ${shape.type} a; ${shape.type} b; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Go) { ${operation.body.replaceAll("TYPE", shape.type)} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;
}
