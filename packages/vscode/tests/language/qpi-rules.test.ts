import { test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { scanQpi, scanLocals, scanLocalsForm } from "../../src/lint/qpi-rules";

const rulesOf = (s: string) => new Set(scanQpi(s).map((f) => f.rule));

test("flags each forbidden construct (one crafted violation per rule)", () => {
  expect(rulesOf('auto s = "hi";')).toContain("qpi/no-string");
  expect(rulesOf("char c = 'a';")).toContain("qpi/no-char");
  // C++14 digit separators are part of a numeric literal, not char literals — must NOT be flagged
  expect(rulesOf("uint64 x = 1" + String.fromCharCode(39) + "000" + String.fromCharCode(39) + "000;")).not.toContain("qpi/no-char");
  expect(rulesOf("uint64 m = 0xFFFF" + String.fromCharCode(39) + "FFFF;")).not.toContain("qpi/no-char");
  expect(rulesOf("#define FOO 1")).toContain("qpi/no-preprocessor");
  expect(rulesOf("uint64 q = a / b;")).toContain("qpi/no-division");
  expect(rulesOf("uint64 r = a % b;")).toContain("qpi/no-modulo");
  expect(rulesOf("uint64 arr[4];")).toContain("qpi/no-brackets");
  expect(rulesOf("void f(Args... a) {}")).toContain("qpi/no-varargs");
  expect(rulesOf("uint64 __x = 1;")).toContain("qpi/no-dunder");
  expect(rulesOf("float f = 1;")).toContain("qpi/no-float");
  expect(rulesOf("double d = 1;")).toContain("qpi/no-float");
  expect(rulesOf("union U { uint64 a; };")).toContain("qpi/no-union");
  expect(rulesOf("auto p = const_cast<T>(x);")).toContain("qpi/no-const-cast");
  expect(rulesOf("QpiContext ctx;")).toContain("qpi/no-qpicontext");
  expect(rulesOf("typedef uint64 Money;")).toContain("qpi/no-global-typedef");
  expect(rulesOf("using Money = uint64;")).toContain("qpi/no-global-using");
});

test("the qpi.h dev-include is an exception (no diagnostics); other directives are not", () => {
  expect(rulesOf('#include "qpi.h"')).toEqual(new Set());
  expect(rulesOf('#include "contracts/qpi.h"')).toEqual(new Set());
  expect(rulesOf("#include <qpi.h>")).toEqual(new Set());
  expect(rulesOf('#include "other.h"')).toContain("qpi/no-preprocessor");
  expect(rulesOf("#pragma once")).toContain("qpi/no-preprocessor");
});

test("comments and string bodies do not trigger inner rules", () => {
  expect(rulesOf("// a / b % c [0] #foo\nuint64 x = mul(a,b);")).toEqual(new Set());
  expect(rulesOf("/* a / b\n   % c [ ] # */\nuint64 x = 1;")).toEqual(new Set());
  // inside a string the only finding is the string itself — inner / # [ are skipped
  expect([...rulesOf('auto s = "a / b # [c]";')]).toEqual(["qpi/no-string"]);
});

test("allowed forms do not trigger", () => {
  expect(rulesOf("using namespace QPI;")).not.toContain("qpi/no-global-using");
  expect(rulesOf("uint64 p = a * b;")).not.toContain("qpi/no-division"); // * is multiplication
  // typedef/using inside a struct or function (local scope) is allowed
  expect(rulesOf("struct S { typedef uint64 T; using U = uint64; };")).toEqual(new Set());
});

test("real fixtures stay clean — zero false positives", () => {
  const dir = resolve("fixtures");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".h"))) {
    const src = readFileSync(join(dir, f), "utf8");
    if (/fault-injection|qpi-DIRTY/i.test(src)) continue; // deliberately-invalid fixtures (e.g. Trap.h raw `/`)
    const findings = scanQpi(src).map((x) => x.rule);
    expect({ file: f, findings }).toEqual({ file: f, findings: [] });
  }
});

// --- scanLocals (stack-local declarations inside function bodies) ---
const localsOf = (s: string) => scanLocals(s).map((f) => f.message.match(/`(\w+)`/)![1]);
const inProc = (body: string) => `struct X : public ContractBase { PUBLIC_PROCEDURE(Do) { ${body} } };`;

test("scanLocals flags stack-local declarations (incl. consecutive) inside a function body", () => {
  expect(localsOf(inProc("uint64 x; uint64 y = 1;"))).toEqual(["x", "y"]);
  expect(localsOf(inProc("Get_output out; Get_input in;"))).toEqual(["out", "in"]);
  expect(localsOf(inProc("for (uint64 i = 0; i < 3; i = i + 1) { }"))).toEqual(["i"]);
});

test("scanLocals flags TEMPLATED-type stack locals (Array/HashMap/QPI::), not comparisons", () => {
  expect(localsOf(inProc("Array<uint64, 4> arr;"))).toEqual(["arr"]);
  expect(localsOf(inProc("HashMap<id, uint64, 1024> m;"))).toEqual(["m"]);
  expect(localsOf(inProc("QPI::Array<uint64, 8> q;"))).toEqual(["q"]);
  // the reported case: a scalar local AND a templated local in the same body
  expect(localsOf(inProc("uint64 x = state.get().counter; Array<uint64, 4> arr;"))).toEqual(["x", "arr"]);
  // a comparison is not a templated declaration → flags only the real local
  expect(localsOf(inProc("uint64 y = a < b;"))).toEqual(["y"]);
  expect(scanLocals(inProc("for (locals.i = 0; locals.i < N; ++locals.i) { state.mut().t += locals.i; }"))).toEqual([]);
});

test("scanLocals covers EVERY QPI data structure + scalar declared on the stack", () => {
  const decls: Record<string, string> = {
    Array: "Array<uint64, 4> a;",
    HashMap: "HashMap<id, uint64, 1024> m;",
    HashSet: "HashSet<id, 512> s;",
    Collection: "Collection<Foo, 8> c;",
    LinkedList: "LinkedList<Bar, 16> l;",
    BitArray: "BitArray<256> b;",
    bit_4096: "bit_4096 z;",
    id: "id who;",
    uint64: "uint64 n;",
    sint64: "sint64 d = 0;",
    bit: "bit flag;",
    m256i: "m256i raw;",
    uint128: "uint128 big;",
    Asset: "Asset asset;",
    "QPI::Array": "QPI::Array<uint64, 8> q;",
    nestedTemplate: "HashMap<id, Array<uint64, 2>, 8> nested;",
  };
  for (const [kind, decl] of Object.entries(decls)) {
    expect({ [kind]: scanLocals(inProc(decl)).length }).toEqual({ [kind]: 1 });
  }
});

test("scanLocals does not flag assignments, calls, member access, or keywords", () => {
  expect(scanLocals(inProc("state.mut().counter += 1;"))).toEqual([]);
  expect(scanLocals(inProc("output.value = state.get().counter;"))).toEqual([]);
  expect(scanLocals(inProc("CALL(Get, in, out);"))).toEqual([]);
  expect(scanLocals(inProc("return;"))).toEqual([]);
});

test("scanLocals only looks inside function bodies — struct fields are not locals", () => {
  const src = `struct X : public ContractBase {
    struct StateData { uint64 counter; };
    struct Do_input { uint64 amount; };
    PUBLIC_FUNCTION(Q) { output.v = state.get().counter; }
  };`;
  expect(scanLocals(src)).toEqual([]);
});

test("scanLocals: real fixtures stay clean (they use _WITH_LOCALS / state)", () => {
  const dir = resolve("fixtures");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".h"))) {
    const hits = scanLocals(readFileSync(join(dir, f), "utf8")).map((x) => x.rule);
    expect({ file: f, hits }).toEqual({ file: f, hits: [] });
  }
});

// --- scanLocalsForm (plain function uses/defines locals → hint to use _WITH_LOCALS) ---
test("scanLocalsForm hints _WITH_LOCALS when a plain function defines or uses locals", () => {
  const withStruct = `struct X : public ContractBase { struct Do_locals { uint64 d; }; PUBLIC_PROCEDURE(Do) { locals.d = 1; } };`;
  expect(scanLocalsForm(withStruct).map((f) => f.rule)).toEqual(["qpi/needs-with-locals"]);
  expect(scanLocalsForm(withStruct)[0].message).toContain("PUBLIC_PROCEDURE_WITH_LOCALS(Do)");
  // uses locals without a struct → still hinted
  expect(scanLocalsForm(`struct X : public ContractBase { PUBLIC_FUNCTION(Q) { output.v = locals.tmp; } };`).map((f) => f.rule)).toEqual(["qpi/needs-with-locals"]);
  // correct _WITH_LOCALS usage → no hint
  expect(scanLocalsForm(`struct X : public ContractBase { struct Q_locals { uint64 t; }; PUBLIC_FUNCTION_WITH_LOCALS(Q) { locals.t = 1; } };`)).toEqual([]);
  // plain function with no locals → no hint
  expect(scanLocalsForm(`struct X : public ContractBase { PUBLIC_FUNCTION(Q) { output.v = 1; } };`)).toEqual([]);
});

test("scanLocalsForm: real fixtures stay clean", () => {
  const dir = resolve("fixtures");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".h"))) {
    const hits = scanLocalsForm(readFileSync(join(dir, f), "utf8")).map((x) => x.rule);
    expect({ file: f, hits }).toEqual({ file: f, hits: [] });
  }
});

// --- valid-construct matrix (the qpi.h surface) — must never produce warn/error findings ---
const warnsOf = (s: string) => scanQpi(s).filter((f) => f.severity !== "info").map((f) => f.rule);

test("valid QPI constructs never produce warn/error findings", () => {
  expect(warnsOf("uint64 a = div(x, y); uint64 b = mod(x, y); uint64 c = smul(x, y);")).toEqual([]);
  expect(warnsOf("uint64 a = div<uint128>(x, y);")).toEqual([]);                          // templated helper
  expect(warnsOf("v = arr.get(locals.i); arr.set(locals.i, v); m.contains(k);")).toEqual([]); // method access, not []
  expect(warnsOf("Status s = Status::Active; ProposalTypes::cls(x);")).toEqual([]);        // :: not a rule
  expect(warnsOf("using namespace QPI;")).toEqual([]);
  expect(warnsOf("uint64 p = a * b * c;")).toEqual([]);                                    // * = multiply
  expect(warnsOf("CALL_OTHER_CONTRACT_FUNCTION(QX, Fees, locals.in, locals.out);")).toEqual([]);
  expect(warnsOf("INVOKE_OTHER_CONTRACT_PROCEDURE(QEARN, lock, locals.in, locals.out, locals.amt);")).toEqual([]);
  expect(warnsOf("LOG_INFO(locals.msg);")).toEqual([]);
  // STATIC_ASSERT / static_assert with a message string is compile-time → not a runtime string
  expect(warnsOf('STATIC_ASSERT(A == B, "A == B");')).toEqual([]);
  expect(warnsOf('static_assert(sizeof(X) <= 1024, "too big");')).toEqual([]);
  // ...but a real runtime string is still flagged
  expect(scanQpi('auto s = "runtime";').map((f) => f.rule)).toContain("qpi/no-string");
});

test("for-loop over a locals member is fine; a raw for-init local is flagged", () => {
  const proc = (b: string) => `struct X : public ContractBase { PUBLIC_PROCEDURE_WITH_LOCALS(Do) { ${b} } };`;
  expect(scanLocals(proc("for (locals.i = 0; locals.i < N; ++locals.i) { locals.s += locals.i; }"))).toEqual([]);
  expect(scanLocals(proc("for (uint64 i = 0; i < N; ++i) { }")).map((f) => f.rule)).toEqual(["qpi/stack-local"]);
});

test("lifecycle hooks: stack-local detection + the _WITH_LOCALS hint both cover them", () => {
  // a stack local inside a lifecycle _WITH_LOCALS body is still flagged (FN_MACRO coverage)
  const init = `struct X : public ContractBase { struct INITIALIZE_locals { uint64 t; }; INITIALIZE_WITH_LOCALS() { uint64 tmp; locals.t = 0; } };`;
  expect(scanLocals(init).map((f) => f.rule)).toEqual(["qpi/stack-local"]);
  // a plain lifecycle hook that uses/defines locals → needs-with-locals hint, naming the _WITH_LOCALS form
  const plain = `struct X : public ContractBase { struct INITIALIZE_locals { uint64 t; }; INITIALIZE() { locals.t = 0; } };`;
  expect(scanLocalsForm(plain).map((f) => f.rule)).toEqual(["qpi/needs-with-locals"]);
  expect(scanLocalsForm(plain)[0].message).toContain("INITIALIZE_WITH_LOCALS()");
  // correct lifecycle _WITH_LOCALS usage → no hint
  expect(scanLocalsForm(`struct X : public ContractBase { struct BEGIN_EPOCH_locals { uint64 t; }; BEGIN_EPOCH_WITH_LOCALS() { locals.t = 1; } };`)).toEqual([]);
});
