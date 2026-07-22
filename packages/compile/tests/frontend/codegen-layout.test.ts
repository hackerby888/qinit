// Codegen struct-layout unit tests: field offsets, sizes, alignment for scalars, nested structs, unions, base classes, template instantiations, and
import { describe, test, expect } from "bun:test";
import { CodeGenerationContext } from "../../src/codegen";
import { Sema } from "../../src/sema";
import type {
  TypeSpec,
  StructDecl,
  VariableDecl,
  TemplateParam,
  Declaration,
  Expression,
} from "../../src/ast";
import type { TemplateBindings } from "../../src/codegen";

// ---- helpers ----

const NO_SPAN = { start: 0, end: 0, line: 0, column: 0 };

const n = (name: string): TypeSpec => ({ kind: "name", name }) as TypeSpec;

const tinst = (name: string, callArguments: TypeSpec[]): TypeSpec =>
  ({ kind: "template_instance", name, callArguments }) as TypeSpec;

const exprVal = (value: number): TypeSpec =>
  ({
    kind: "expr_value",
    expression: { kind: "int_literal", value: String(value), span: NO_SPAN },
  }) as TypeSpec;

const ident = (name: string): Expression =>
  ({ kind: "identifier", name, span: NO_SPAN }) as Expression;

/** A non-static data member field. */
const fld = (name: string, type: TypeSpec): VariableDecl =>
  ({
    kind: "variable",
    name,
    type,
    isMember: true,
    isStatic: false,
    isConstexpr: false,
    isExtern: false,
    access: "public",
    span: NO_SPAN,
  }) as VariableDecl;

/** A static constexpr member — skipped by layout. */
const stat = (name: string, value: number): VariableDecl =>
  ({
    kind: "variable",
    name,
    type: n("uint64"),
    initializer: { kind: "int_literal", value: String(value), span: NO_SPAN },
    isConstexpr: true,
    isStatic: true,
    isMember: true,
    isExtern: false,
    access: "public",
    span: NO_SPAN,
  }) as VariableDecl;

/** Build a StructDecl. */
const sdecl = (
  name: string,
  members: Declaration[],
  options?: {
    bases?: TypeSpec[];
    isUnion?: boolean;
  },
): StructDecl =>
  ({
    kind: "struct",
    name,
    members,
    bases: options?.bases ?? [],
    isUnion: options?.isUnion,
    span: NO_SPAN,
  }) as StructDecl;

/** Build a ClassTemplate (the codegen-internal representation). */
const ctmpl = (params: TemplateParam[], members: Declaration[]) => ({ params, members });

const tparam = (name: string): TemplateParam =>
  ({ kind: "type", name, span: NO_SPAN }) as TemplateParam;

const ntparam = (name: string): TemplateParam =>
  ({ kind: "non_type", name, type: n("uint64"), span: NO_SPAN }) as TemplateParam;

// ---- Codegen instance ----

const makeCg = (): CodeGenerationContext => new CodeGenerationContext(new Sema());

// -------------------------------------------------------------------------- scalar sizes --------------------------------------------------------------------------

describe("Codegen — scalar sizes", () => {
  test.each([
    ["uint8", 1],
    ["uint16", 2],
    ["uint32", 4],
    ["uint64", 8],
    ["uint128", 16],
    ["sint8", 1],
    ["sint16", 2],
    ["sint32", 4],
    ["sint64", 8],
    ["bool", 1],
    ["bit", 1],
    ["id", 32],
    ["m256i", 32],
    ["signed char", 1],
    ["unsigned char", 1],
    ["signed short", 2],
    ["unsigned short", 2],
    ["signed int", 4],
    ["unsigned int", 4],
    ["signed long long", 8],
    ["unsigned long long", 8],
    ["long long", 8],
  ])("sizeof(%s) = %d", (name, expected) => {
    const codeGenerationContext = makeCg();
    expect(codeGenerationContext.sizeOfType(n(name))).toBe(expected);
  });

  test("sizeof(void) = 0", () => {
    const codeGenerationContext = makeCg();
    expect(codeGenerationContext.sizeOfType({ kind: "void" } as TypeSpec)).toBe(0);
  });

  test("pointer size = 4 (i32)", () => {
    const codeGenerationContext = makeCg();
    expect(codeGenerationContext.sizeOfType({ kind: "pointer", pointee: n("uint64") } as TypeSpec)).toBe(4);
  });
});

// -------------------------------------------------------------------------- simple structs --------------------------------------------------------------------------

describe("Codegen — simple struct layout", () => {
  test("two uint64 fields", () => {
    const codeGenerationContext = makeCg();
    const s = sdecl("S", [fld("a", n("uint64")), fld("b", n("uint64"))]);
    const layout = codeGenerationContext.layoutOf(s);
    expect(layout.fields.get("a")!.offset).toBe(0);
    expect(layout.fields.get("a")!.size).toBe(8);
    expect(layout.fields.get("b")!.offset).toBe(8);
    expect(layout.fields.get("b")!.size).toBe(8);
    expect(layout.size).toBe(16);
    expect(layout.align).toBe(8);
  });

  test("mixed-width with natural alignment", () => {
    const codeGenerationContext = makeCg();
    const s = sdecl("S", [fld("v1", n("uint8")), fld("v2", n("uint64")), fld("v3", n("uint16"))]);
    const layout = codeGenerationContext.layoutOf(s);
    expect(layout.fields.get("v1")!.offset).toBe(0);
    expect(layout.fields.get("v1")!.size).toBe(1);
    expect(layout.fields.get("v2")!.offset).toBe(8); // padded to 8
    expect(layout.fields.get("v2")!.size).toBe(8);
    expect(layout.fields.get("v3")!.offset).toBe(16);
    expect(layout.fields.get("v3")!.size).toBe(2);
    expect(layout.size).toBe(24); // aligned up to 8-byte boundary
    expect(layout.align).toBe(8);
  });

  test("uint8 + uint32 + uint8: natural packing", () => {
    const codeGenerationContext = makeCg();
    const s = sdecl("S", [fld("a", n("uint8")), fld("b", n("uint32")), fld("c", n("uint8"))]);
    const layout = codeGenerationContext.layoutOf(s);
    expect(layout.fields.get("a")!.offset).toBe(0);
    expect(layout.fields.get("b")!.offset).toBe(4); // aligned to 4
    expect(layout.fields.get("c")!.offset).toBe(8);
    expect(layout.size).toBe(12); // 9 rounded up to 12 (align 4)
  });

  test("struct size padded to max alignment", () => {
    const codeGenerationContext = makeCg();
    const s = sdecl("S", [fld("a", n("uint32")), fld("b", n("uint8"))]);
    const layout = codeGenerationContext.layoutOf(s);
    expect(layout.fields.get("a")!.offset).toBe(0);
    expect(layout.fields.get("b")!.offset).toBe(4);
    // raw size = 5, must round up to max alignment (=4) → 8
    expect(layout.size).toBe(8);
  });

  test("empty struct has size 0, align 1", () => {
    const codeGenerationContext = makeCg();
    const s = sdecl("Empty", []);
    const layout = codeGenerationContext.layoutOf(s);
    expect(layout.size).toBe(0);
    expect(layout.align).toBe(1);
    expect(layout.fields.size).toBe(0);
  });

  test("static constexpr members are skipped", () => {
    const codeGenerationContext = makeCg();
    const s = sdecl("S", [stat("K", 42), fld("a", n("uint64")), stat("M", 99)]);
    const layout = codeGenerationContext.layoutOf(s);
    expect(layout.fields.size).toBe(1);
    expect(layout.fields.get("a")!.offset).toBe(0);
  });
});

// -------------------------------------------------------------------------- nested structs --------------------------------------------------------------------------

describe("Codegen — nested struct layout", () => {
  test("struct containing another struct as a field", () => {
    const codeGenerationContext = makeCg();
    const inner = sdecl("Inner", [fld("x", n("uint32")), fld("y", n("uint32"))]);
    const outer = sdecl("Outer", [
      fld("flag", n("uint8")),
      fld("data", { kind: "inline_struct", struct: inner } as TypeSpec),
    ]);
    const layout = codeGenerationContext.layoutOf(outer);
    expect(layout.fields.get("flag")!.offset).toBe(0);
    expect(layout.fields.get("flag")!.size).toBe(1);
    // data (Inner) aligned to 4: offset 4, size 8
    expect(layout.fields.get("data")!.offset).toBe(4);
    expect(layout.fields.get("data")!.size).toBe(8);
    expect(layout.size).toBe(12);
  });
});

// -------------------------------------------------------------------------- unions --------------------------------------------------------------------------

describe("Codegen — union layout", () => {
  test("all fields at offset 0, size = max field size", () => {
    const codeGenerationContext = makeCg();
    const s = sdecl(
      "U",
      [fld("as_u8", n("uint8")), fld("as_u64", n("uint64")), fld("as_u32", n("uint32"))],
      { isUnion: true },
    );
    const layout = codeGenerationContext.layoutOf(s);
    expect(layout.fields.get("as_u8")!.offset).toBe(0);
    expect(layout.fields.get("as_u8")!.size).toBe(1);
    expect(layout.fields.get("as_u64")!.offset).toBe(0);
    expect(layout.fields.get("as_u64")!.size).toBe(8);
    expect(layout.fields.get("as_u32")!.offset).toBe(0);
    expect(layout.fields.get("as_u32")!.size).toBe(4);
    expect(layout.size).toBe(8); // max field size
    expect(layout.align).toBe(8); // max field align
  });
});

// -------------------------------------------------------------------------- base class inheritance --------------------------------------------------------------------------

describe("Codegen — base class layout", () => {
  test("base fields placed first, derived fields follow", () => {
    const codeGenerationContext = makeCg();
    const base = sdecl("Base", [fld("base_a", n("uint64")), fld("base_b", n("uint32"))]);
    // Register base in globalStructs so baseContribution resolves it
    codeGenerationContext.globalStructs.set("Base", base);

    const derived = sdecl(
      "Derived",
      [fld("derived_x", n("uint32")), fld("derived_y", n("uint64"))],
      { bases: [n("Base")] },
    );
    const layout = codeGenerationContext.layoutOf(derived);

    expect(layout.fields.get("base_a")!.offset).toBe(0);
    expect(layout.fields.get("base_b")!.offset).toBe(8);
    // derived fields after base (base size = 12 padded to 16)
    expect(layout.fields.get("derived_x")!.offset).toBe(16);
    expect(layout.fields.get("derived_y")!.offset).toBe(24);
    expect(layout.align).toBe(8);
  });

  test("multiple base classes stack sequentially", () => {
    const codeGenerationContext = makeCg();
    const b1 = sdecl("B1", [fld("x", n("uint32"))]);
    const b2 = sdecl("B2", [fld("y", n("uint64"))]);
    codeGenerationContext.globalStructs.set("B1", b1);
    codeGenerationContext.globalStructs.set("B2", b2);

    const derived = sdecl("D", [fld("z", n("uint32"))], { bases: [n("B1"), n("B2")] });
    const layout = codeGenerationContext.layoutOf(derived);

    expect(layout.fields.get("x")!.offset).toBe(0); // B1 first
    expect(layout.fields.get("y")!.offset).toBe(8); // B2 aligned to 8
    expect(layout.fields.get("z")!.offset).toBe(16); // derived after B2
  });
});

// -------------------------------------------------------------------------- templates --------------------------------------------------------------------------

describe("Codegen — template layout", () => {
  test("Array<uint64, 4> via layoutOfType", () => {
    const codeGenerationContext = makeCg();
    // Register the Array template with a minimal captured body
    codeGenerationContext.templates.set(
      "Array",
      ctmpl(
        [tparam("T"), ntparam("L")],
        [fld("_data", { kind: "array", element: n("T"), size: ident("L") } as TypeSpec)],
      ),
    );

    const layout = codeGenerationContext.layoutOfType(tinst("Array", [n("uint64"), exprVal(4)]));
    expect(layout).not.toBeNull();
    expect(layout!.size).toBe(32); // 8 * 4
    expect(layout!.align).toBe(8);
  });

  test("Array<uint8, 4> → 4 bytes", () => {
    const codeGenerationContext = makeCg();
    codeGenerationContext.templates.set(
      "Array",
      ctmpl(
        [tparam("T"), ntparam("L")],
        [fld("_data", { kind: "array", element: n("T"), size: ident("L") } as TypeSpec)],
      ),
    );
    expect(codeGenerationContext.layoutOfType(tinst("Array", [n("uint8"), exprVal(4)]))!.size).toBe(4);
  });

  test("template instantiation is cached (same key → same object)", () => {
    const codeGenerationContext = makeCg();
    codeGenerationContext.templates.set(
      "Array",
      ctmpl(
        [tparam("T"), ntparam("L")],
        [fld("_data", { kind: "array", element: n("T"), size: ident("L") } as TypeSpec)],
      ),
    );
    const a1 = codeGenerationContext.layoutOfType(tinst("Array", [n("uint64"), exprVal(4)]));
    const a2 = codeGenerationContext.layoutOfType(tinst("Array", [n("uint64"), exprVal(4)]));
    expect(a1).toBe(a2); // same object reference = cache hit
  });

  test("missing Array template fails instead of using an approximate formula", () => {
    const codeGenerationContext = makeCg();
    expect(() => codeGenerationContext.sizeOfType(tinst("Array", [n("uint64"), exprVal(4)]))).toThrow(
      /not captured.*refusing an approximate layout/,
    );
  });

  test("missing BitArray template fails instead of using an approximate formula", () => {
    const codeGenerationContext = makeCg();
    expect(() => codeGenerationContext.sizeOfType(tinst("BitArray", [exprVal(256)]))).toThrow(
      /not captured.*refusing an approximate layout/,
    );
  });
});

// -------------------------------------------------------------------------- wide types (uint128, id, m256i) --------------------------------------------------------------------------

describe("Codegen — wide types", () => {
  test("uint128 aligns to 8 (clamped from 16)", () => {
    const codeGenerationContext = makeCg();
    const s = sdecl("S", [fld("a", n("uint8")), fld("b", n("uint128"))]);
    const layout = codeGenerationContext.layoutOf(s);
    expect(layout.fields.get("a")!.offset).toBe(0);
    expect(layout.fields.get("b")!.offset).toBe(8); // aligned to 8, not 16
    expect(layout.fields.get("b")!.size).toBe(16);
    expect(layout.size).toBe(24); // 24 is already 8-aligned
  });

  test("id (32 bytes) aligns to 8", () => {
    const codeGenerationContext = makeCg();
    const s = sdecl("S", [fld("a", n("uint8")), fld("b", n("id"))]);
    const layout = codeGenerationContext.layoutOf(s);
    expect(layout.fields.get("b")!.offset).toBe(8);
    expect(layout.fields.get("b")!.size).toBe(32);
    expect(layout.size).toBe(40); // 40 is already 8-aligned
  });

  test("m256i (32 bytes) aligns to 8", () => {
    const codeGenerationContext = makeCg();
    const s = sdecl("S", [fld("a", n("m256i")), fld("b", n("uint8"))]);
    const layout = codeGenerationContext.layoutOf(s);
    expect(layout.fields.get("a")!.offset).toBe(0);
    expect(layout.fields.get("a")!.size).toBe(32);
    expect(layout.fields.get("b")!.offset).toBe(32);
  });
});

// -------------------------------------------------------------------------- layoutOfType via global structs --------------------------------------------------------------------------

describe("Codegen — layoutOfType via global structs", () => {
  test("resolves named struct globally", () => {
    const codeGenerationContext = makeCg();
    const s = sdecl("Point", [fld("x", n("uint64")), fld("y", n("uint64"))]);
    codeGenerationContext.globalStructs.set("Point", s);
    const layout = codeGenerationContext.layoutOfType(n("Point"));
    expect(layout).not.toBeNull();
    expect(layout!.size).toBe(16);
  });

  test("resolves through typedefs", () => {
    const codeGenerationContext = makeCg();
    const s = sdecl("Hidden", [fld("v", n("uint32"))]);
    codeGenerationContext.globalStructs.set("Hidden", s);
    codeGenerationContext.typedefs.set("Visible", n("Hidden"));
    const layout = codeGenerationContext.layoutOfType(n("Visible"));
    expect(layout).not.toBeNull();
    expect(layout!.size).toBe(4);
  });

  test("scalar type returns null layout", () => {
    const codeGenerationContext = makeCg();
    expect(codeGenerationContext.layoutOfType(n("uint64"))).toBeNull();
  });

  test("qualified nested structs keep their alignment", () => {
    const codeGenerationContext = makeCg();
    const query = sdecl("Query", [fld("tag", n("uint8")), fld("timestamp", n("uint64"))]);
    codeGenerationContext.globalStructs.set("Interface", sdecl("Interface", [query]));

    expect(codeGenerationContext.alignOfType(n("Interface::Query"))).toBe(8);
    expect(codeGenerationContext.layoutOf(sdecl("Input", [
      fld("query", n("Interface::Query")),
      fld("timeout", n("uint32")),
    ])).size).toBe(24);
  });

  test("qualified constants resolve through template bindings", () => {
    const codeGenerationContext = makeCg();
    codeGenerationContext.globalStructs.set("Price", sdecl("Price", [stat("oracleInterfaceIndex", 0)]));
    const bindings: TemplateBindings = {
      types: new Map([["OracleInterface", n("Price")]]),
      values: new Map(),
      structs: new Map(),
    };

    expect(codeGenerationContext.resolveConst("OracleInterface::oracleInterfaceIndex", bindings)).toBe(0n);
  });
});

// -------------------------------------------------------------------------- anonymous struct promotion --------------------------------------------------------------------------

describe("Codegen — anonymous struct promotion", () => {
  test("unnamed struct members are flattened into the parent", () => {
    const codeGenerationContext = makeCg();
    const anon = sdecl("", [fld("inner_x", n("uint32")), fld("inner_y", n("uint32"))]);
    const outer = sdecl("Outer", [
      fld("prefix", n("uint8")),
      anon as any as Declaration, // unnamed struct member
      fld("suffix", n("uint16")),
    ]);
    const layout = codeGenerationContext.layoutOf(outer);
    expect(layout.fields.get("prefix")!.offset).toBe(0);
    expect(layout.fields.get("prefix")!.size).toBe(1);
    expect(layout.fields.get("inner_x")!.offset).toBe(4); // aligned to 4
    expect(layout.fields.get("inner_x")!.size).toBe(4);
    expect(layout.fields.get("inner_y")!.offset).toBe(8);
    expect(layout.fields.get("inner_y")!.size).toBe(4);
    expect(layout.fields.get("suffix")!.offset).toBe(12);
    expect(layout.fields.get("suffix")!.size).toBe(2);
  });
});

// -------------------------------------------------------------------------- sizing through bindings --------------------------------------------------------------------------

describe("Codegen — sizeOfType with bindings", () => {
  test("resolves template param through binding", () => {
    const codeGenerationContext = makeCg();
    codeGenerationContext.templates.set(
      "Array",
      ctmpl(
        [tparam("T"), ntparam("L")],
        [fld("_data", { kind: "array", element: n("T"), size: ident("L") } as TypeSpec)],
      ),
    );
    const b: TemplateBindings = {
      types: new Map([["T", n("uint64")]]),
      values: new Map([["L", 8n]]),
      structs: new Map(),
    };
    const layout = codeGenerationContext.layoutOfType(tinst("Array", [n("T"), exprVal(8)]), b);
    expect(layout).not.toBeNull();
    expect(layout!.size).toBe(64); // uint64(8) * 8
  });
});

// -------------------------------------------------------------------------- fieldOf helper --------------------------------------------------------------------------

describe("Codegen — fieldOf", () => {
  test("resolves a named field's offset and size", () => {
    const codeGenerationContext = makeCg();
    const s = sdecl("S", [fld("a", n("uint64")), fld("b", n("uint32"))]);
    codeGenerationContext.globalStructs.set("S", s);

    const fa = codeGenerationContext.fieldOf(n("S"), "a");
    expect(fa).not.toBeNull();
    expect(fa!.offset).toBe(0);
    expect(fa!.size).toBe(8);

    const fb = codeGenerationContext.fieldOf(n("S"), "b");
    expect(fb!.offset).toBe(8);
    expect(fb!.size).toBe(4);
  });

  test("unknown field returns null", () => {
    const codeGenerationContext = makeCg();
    expect(codeGenerationContext.fieldOf(n("uint64"), "x")).toBeNull();
  });
});
