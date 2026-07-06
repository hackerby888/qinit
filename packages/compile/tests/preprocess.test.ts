// Preprocessor unit tests: macro expansion, conditional directives, built-in defines,
// # and ## operators, recursion guard, varargs, backslash continuation.
import { describe, test, expect } from "bun:test";
import { Preprocessor } from "../src/preprocess";
import type { MacroDef } from "../src/preprocess";

/** Shortcut: preprocess with minimal opts (no qpiHeader so source controls everything). */
const pp = (source: string, opts?: { contractName?: string; contractIndex?: number; seedMacros?: Map<string, MacroDef>; qpiHeader?: string }) => {
  const p = new Preprocessor();
  return p.preprocess({
    source,
    qpiHeader: opts?.qpiHeader ?? "",
    contractName: opts?.contractName ?? "T",
    contractIndex: opts?.contractIndex ?? 0,
    seedMacros: opts?.seedMacros,
  });
};

/** Preprocess and return non-empty lines (trimmed) for easier assertions. */
const lines = (source: string, opts?: Parameters<typeof pp>[1]): string[] =>
  pp(source, opts)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

// ---- object-like macros ----

describe("object-like macros", () => {
  test("simple substitution", () => {
    const out = pp("#define FOO 42\nFOO");
    expect(out).toContain("42");
    expect(out).not.toContain("FOO");
  });

  test("empty body macro expands to nothing", () => {
    const out = pp("#define EMPTY\nbefore EMPTY after");
    expect(out).toContain("before  after");
  });

  test("macro body with whitespace", () => {
    const out = pp("#define GREET hello world\nGREET");
    expect(out).toContain("hello world");
  });

  test("multiple object-like macros", () => {
    const out = pp("#define A 1\n#define B 2\nA + B");
    expect(out).toContain("1 + 2");
  });

  test("macro not defined remains unchanged", () => {
    const out = pp("UNDEFINED_MACRO");
    expect(out).toContain("UNDEFINED_MACRO");
  });
});

// ---- function-like macros ----

describe("function-like macros", () => {
  test("simple two-arg macro", () => {
    const out = pp("#define ADD(x,y) ((x)+(y))\nADD(1,2)");
    expect(out).toContain("((1)+(2))");
  });

  test("macro with no params", () => {
    const out = pp("#define EMPTY() nothing\nEMPTY()");
    expect(out).toContain("nothing");
  });

  test("macro with one param", () => {
    const out = pp("#define SQUARE(x) ((x)*(x))\nSQUARE(5)");
    expect(out).toContain("((5)*(5))");
  });

  test("nested macro calls", () => {
    const out = pp("#define DOUBLE(x) ((x)+(x))\n#define SQUARE(x) ((x)*(x))\nSQUARE(DOUBLE(3))");
    // SQUARE body: ((x)*(x)). x = DOUBLE(3) = ((3)+(3)).
    // Substitution wraps: ((((3)+(3)))*(((3)+(3))))
    expect(out).toContain("((((3)+(3)))*(((3)+(3))))");
  });

  test("arguments with commas in nested parens", () => {
    const out = pp("#define WRAP(x) [x]\nWRAP((a,b,c))");
    expect(out).toContain("[(a,b,c)]");
  });

  test("function-like macro not invoked without parens passes through", () => {
    const out = pp("#define FN(x) x\nFN");
    expect(out).toContain("FN"); // FN without () is not expanded
  });

  test("whitespace between name and paren is allowed", () => {
    const out = pp("#define FN(x) x\nFN (42)");
    expect(out).toContain("42");
  });
});

// ---- token paste (##) ----

describe("token paste (##)", () => {
  test("simple concatenation", () => {
    const out = pp("#define PASTE(x,y) x##y\nPASTE(foo,bar)");
    expect(out).toContain("foobar");
  });

  test("paste with macro arguments", () => {
    const out = pp("#define VAR(n) var##n\nVAR(1)");
    expect(out).toContain("var1");
  });

  test("paste with one side constant", () => {
    const out = pp("#define PREFIX(x) prefix_##x\nPREFIX(data)");
    expect(out).toContain("prefix_data");
  });
});

// ---- stringification (#) ----

describe("stringification (#)", () => {
  test("simple stringification", () => {
    const out = pp('#define STR(x) #x\nSTR(hello)');
    expect(out).toContain('"hello"');
  });

  test("stringify with spaces in argument", () => {
    const out = pp('#define STR(x) #x\nSTR(hello world)');
    expect(out).toContain('"hello world"');
  });

  test("stringify does NOT match ##param (negative lookbehind)", () => {
    const out = pp("#define PASTE(x,y) x##y\nPASTE(a,b)");
    // ##y should NOT be stringified
    expect(out).toContain("ab");
    expect(out).not.toContain('"b"');
  });

  test("quotes in argument are escaped", () => {
    const out = pp('#define STR(x) #x\nSTR(he said "hi")');
    expect(out).toContain('"he said \\"hi\\""');
  });
});

// ---- recursion guard ----

describe("recursion guard", () => {
  test("direct self-reference stops after one expansion", () => {
    const out = pp("#define REC REC\nREC");
    // REC expands to REC (its body), which then is guarded → stays REC
    expect(out).toContain("REC");
  });

  test("indirect recursion via two macros stops", () => {
    const out = pp("#define A B\n#define B A\nA");
    // Both expand but guarded
    expect(out).not.toContain("A\nA"); // not infinite
  });
});

// ---- chained expansion ----

describe("chained expansion", () => {
  test("two-level chain: A → B → 42", () => {
    const out = pp("#define A B\n#define B 42\nA");
    expect(out).toContain("42");
  });

  test("three-level chain", () => {
    const out = pp("#define A B\n#define B C\n#define C 99\nA");
    expect(out).toContain("99");
  });

  test("chain of 4 (beyond 3-pass limit — still ok for short chains)", () => {
    // The recursive expander runs up to 3 passes. 3-hop chain A→B→C→D works
    // because D is object-like and each pass catches one level.
    const out = pp("#define A B\n#define B C\n#define C D\n#define D 42\nA");
    expect(out).toContain("42");
  });
});

// ---- conditional directives ----

describe("#ifdef / #ifndef / #else / #endif", () => {
  test("#ifdef defined macro emits the branch", () => {
    const out = pp("#define X\n#ifdef X\nyes\n#else\nno\n#endif");
    expect(out).toContain("yes");
    expect(out).not.toContain("no");
  });

  test("#ifdef undefined macro emits else branch", () => {
    const out = pp("#ifdef X\nyes\n#else\nno\n#endif");
    expect(out).toContain("no");
    expect(out).not.toContain("yes");
  });

  test("#ifdef with no #else omits body when undefined", () => {
    const out = pp("before\n#ifdef X\nhidden\n#endif\nafter");
    expect(out).toContain("before");
    expect(out).not.toContain("hidden");
    expect(out).toContain("after");
  });

  test("#ifndef defined macro emits else (inverted logic)", () => {
    const out = pp("#define X\n#ifndef X\nyes\n#else\nno\n#endif");
    expect(out).toContain("no");
    expect(out).not.toContain("yes");
  });

  test("#ifndef undefined macro emits branch", () => {
    const out = pp("#ifndef X\nyes\n#else\nno\n#endif");
    expect(out).toContain("yes");
    expect(out).not.toContain("no");
  });

  test("nested conditionals with nested truth", () => {
    const out = pp("#define A\n#ifdef A\n  #ifdef B\n  lone_b\n  #else\n  not_b\n  #endif\n#else\n  not_a\n#endif");
    // A defined, B not → else branch: "not_b", not "lone_b"
    expect(out).toContain("not_b");
    expect(out).not.toContain("lone_b");
    expect(out).not.toContain("not_a");
  });

  test("nested conditionals both defined", () => {
    const out = pp("#define A\n#define B\n#ifdef A\n  #ifdef B\n  b\n  #endif\n#endif");
    expect(out).toContain("b");
  });

  test("inactive branch skips macro expansion", () => {
    const out = pp("#ifdef UNDEFINED\n#define LEAK 1\n#endif\nLEAK");
    expect(out).toContain("LEAK"); // LEAK never defined
    expect(out).not.toContain("1");
  });

  test("inactive branch skips directives but emits newlines for line tracking", () => {
    const out = pp("before\n#ifdef UNDEFINED\n#define X 1\nX\n#endif\nafter");
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).not.toContain("X");
  });
});

// ---- #elif ----

describe("#elif", () => {
  test("#elif after untaken #if evaluates", () => {
    const out = pp("#define VER 2\n#if VER == 1\none\n#elif VER == 2\ntwo\n#else\nother\n#endif");
    expect(out).toContain("two");
    expect(out).not.toContain("one");
    expect(out).not.toContain("other");
  });

  test("#elif after taken #if stays off", () => {
    const out = pp("#define VER 1\n#if VER == 1\none\n#elif VER == 2\ntwo\n#endif");
    expect(out).toContain("one");
    expect(out).not.toContain("two");
  });

  test("multiple #elif chain picks first match", () => {
    const out = pp("#define VER 3\n#if VER == 1\none\n#elif VER == 2\ntwo\n#elif VER == 3\nthree\n#else\nother\n#endif");
    expect(out).toContain("three");
    expect(out).not.toContain("one");
    expect(out).not.toContain("two");
    expect(out).not.toContain("other");
  });
});

// ---- #if constant expression ----

describe("#if constant expression", () => {
  test("#if with equality comparison", () => {
    const out = pp("#define VER 3\n#if VER == 3\nyes\n#else\nno\n#endif");
    expect(out).toContain("yes");
    expect(out).not.toContain("no");
  });

  test("#if with greater-than comparison", () => {
    const out = pp("#if 5 > 3\nyes\n#else\nno\n#endif");
    expect(out).toContain("yes");
  });

  test("#if with logical AND", () => {
    const out = pp("#define A 1\n#define B 1\n#if A && B\nyes\n#else\nno\n#endif");
    expect(out).toContain("yes");
  });

  test("#if with logical OR", () => {
    const out = pp("#if 0 || 0\nno\n#else\nyes\n#endif");
    expect(out).toContain("yes");
  });

  test("#if with logical NOT", () => {
    const out = pp("#if !0\nyes\n#else\nno\n#endif");
    expect(out).toContain("yes");
  });

  test("#if with defined() function", () => {
    const out = pp("#define X\n#if defined(X)\nyes\n#else\nno\n#endif");
    expect(out).toContain("yes");
    expect(out).not.toContain("no");
  });

  test("#if with !defined(X)", () => {
    // X is NOT defined → defined(X) = 0 → !0 = 1 → condition TRUE → "yes"
    const out = pp("#if !defined(X)\nyes\n#else\nno\n#endif");
    expect(out).toContain("yes");
    expect(out).not.toContain("no");
  });

  test("#if with arithmetic", () => {
    const out = pp("#if (2 + 3) * 2 == 10\nyes\n#else\nno\n#endif");
    expect(out).toContain("yes");
  });

  test("#if with bitwise operators", () => {
    const out = pp("#if (5 & 4) == 4\nyes\n#else\nno\n#endif");
    expect(out).toContain("yes");
  });

  test("defined X without parens (defined X → 1/0)", () => {
    const out = pp("#define X\n#if defined X\nyes\n#else\nno\n#endif");
    expect(out).toContain("yes");
  });

  test("#if 0 is always false", () => {
    const out = pp("#if 0\nno\n#else\nyes\n#endif");
    expect(out).toContain("yes");
    expect(out).not.toContain("no");
  });
});

// ---- __LINE__ ----

describe("__LINE__", () => {
  test("__LINE__ expands to a number", () => {
    const out = pp("__LINE__");
    // source is appended after qpiHeader + "\n", so __LINE__ is a few lines in
    expect(out).toMatch(/[0-9]+/);
  });
});

// ---- built-in defines ----

describe("built-in defines", () => {
  test("CONTRACT_INDEX expands to the index", () => {
    const out = pp("CONTRACT_INDEX", { contractIndex: 7 });
    expect(out).toContain("7");
  });

  test("CONTRACT_STATE_TYPE expands to contract name", () => {
    const out = pp("CONTRACT_STATE_TYPE", { contractName: "Counter" });
    expect(out).toContain("Counter");
  });

  test("CONTRACT_STATE2_TYPE expands to name + '2'", () => {
    const out = pp("CONTRACT_STATE2_TYPE", { contractName: "Counter" });
    expect(out).toContain("Counter2");
  });

  test("NAME_CONTRACT_INDEX expands", () => {
    const out = pp("Counter_CONTRACT_INDEX", { contractName: "Counter", contractIndex: 5 });
    expect(out).toContain("5");
  });

  test("LITE_WASM_TU_BUILD is defined (empty expansion)", () => {
    const out = pp("LITE_WASM_TU_BUILD");
    // Expands to nothing (empty body), so the identifier disappears
    expect(out).not.toContain("LITE_WASM_TU_BUILD");
  });

  test("LITEDYN_CONTRACT_TU is defined (empty expansion)", () => {
    const out = pp("LITEDYN_CONTRACT_TU");
    expect(out).not.toContain("LITEDYN_CONTRACT_TU");
  });
});

// ---- #undef ----

describe("#undef", () => {
  test("#undef removes a macro", () => {
    const lns = lines("#define X 1\nX\n#undef X\nX");
    // First X → 1, second X stays X
    expect(lns).toContain("1");
    expect(lns).toContain("X");
  });

  test("#undef of undefined macro is a no-op", () => {
    const out = pp("#undef UNDEFINED\nUNDEFINED");
    expect(out).toContain("UNDEFINED");
  });

  test("#undef affects subsequent #ifdef", () => {
    const out = pp("#define X\n#undef X\n#ifdef X\nyes\n#else\nno\n#endif");
    expect(out).toContain("no");
  });
});

// ---- varargs ----

describe("variadic macros (...)", () => {
  test("varargs macro with __VA_ARGS__", () => {
    const out = pp("#define LOG(fmt,...) fmt(__VA_ARGS__)\nLOG(printf,\"%d\",42)");
    // __VA_ARGS__ joins extra args with ", " (comma-space)
    expect(out).toContain('printf("%d", 42)');
  });

  test("varargs with single extra arg", () => {
    const out = pp("#define SHOW(x,...) x + __VA_ARGS__\nSHOW(1,2)");
    expect(out).toContain("1 + 2");
  });

  test("varargs with no extra args", () => {
    const out = pp("#define WRAP(x,...) [x]\nWRAP(42)");
    expect(out).toContain("[42]");
  });

  test("named varargs __VA_ARGS__ with named prefix", () => {
    const out = pp("#define FMT(fmt,...) printf(fmt, __VA_ARGS__)\nFMT(\"%d %s\", 42, \"hi\")");
    expect(out).toContain('printf("%d %s", 42, "hi")');
  });
});

// ---- backslash line continuation ----

describe("backslash line continuation", () => {
  test("backslash-newline joins lines in macro body", () => {
    const out = pp("#define LONG 1 \\\n+ 2\nLONG");
    expect(out).toContain("1 + 2");
  });

  test("backslash-newline in #define body with multiple continuations", () => {
    const out = pp("#define MULTI a \\\nb \\\nc\nMULTI");
    expect(out).toContain("a b c");
  });
});

// ---- seed macros ----

describe("seed macros", () => {
  test("seed macros are available before preprocessing", () => {
    const seed = new Map<string, MacroDef>();
    seed.set("SEEDED", { name: "SEEDED", params: null, body: "from_seed", isVarArgs: false });
    const out = pp("SEEDED", { seedMacros: seed });
    expect(out).toContain("from_seed");
  });

  test("source can override seeded macros", () => {
    const seed = new Map<string, MacroDef>();
    seed.set("X", { name: "X", params: null, body: "from_seed", isVarArgs: false });
    const out = pp("#define X from_source\nX", { seedMacros: seed });
    expect(out).toContain("from_source");
    expect(out).not.toContain("from_seed");
  });
});

// ---- getDefines() ----

describe("getDefines", () => {
  test("getDefines returns the macro table after preprocessing", () => {
    const p = new Preprocessor();
    p.preprocess({
      source: "#define X 42\n#define ADD(x,y) ((x)+(y))",
      qpiHeader: "",
      contractName: "T",
      contractIndex: 0,
    });
    const defs = p.getDefines();
    expect(defs.get("X")?.body).toBe("42");
    expect(defs.get("X")?.params).toBeNull();
    expect(defs.get("ADD")?.body).toBe("((x)+(y))");
    expect(defs.get("ADD")?.params).toEqual(["x", "y"]);
  });

  test("getDefines includes built-in defines", () => {
    const p = new Preprocessor();
    p.preprocess({
      source: "",
      qpiHeader: "",
      contractName: "T",
      contractIndex: 7,
    });
    const defs = p.getDefines();
    expect(defs.has("CONTRACT_INDEX")).toBe(true);
    expect(defs.has("LITE_WASM_TU_BUILD")).toBe(true);
  });
});

// ---- edge cases ----

describe("edge cases", () => {
  test("empty source produces only built-in expansion", () => {
    const out = pp("");
    // Should not throw, produces empty output (no source to emit)
    expect(typeof out).toBe("string");
  });

  test("newlines are preserved for line numbering", () => {
    const out = pp("line1\nline2\nline3");
    const lns = out.split("\n");
    // Should have at least the 3 source lines (plus any header padding)
    expect(lns.length).toBeGreaterThanOrEqual(3);
  });

  test("macro inside macro body is expanded", () => {
    const out = pp("#define INNER 42\n#define OUTER INNER\nOUTER");
    expect(out).toContain("42");
  });
});
