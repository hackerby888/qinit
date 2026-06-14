import { test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { scanQpi } from "../src/lint/qpi-rules";

const rulesOf = (s: string) => new Set(scanQpi(s).map((f) => f.rule));

test("flags each forbidden construct (one crafted violation per rule)", () => {
  expect(rulesOf('auto s = "hi";')).toContain("qpi/no-string");
  expect(rulesOf("char c = 'a';")).toContain("qpi/no-char");
  expect(rulesOf('#include "qpi.h"')).toContain("qpi/no-preprocessor");
  expect(rulesOf('#include "qpi.h"')).not.toContain("qpi/no-string"); // the include path isn't a QPI string literal
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
    const findings = scanQpi(readFileSync(join(dir, f), "utf8")).map((x) => x.rule);
    expect({ file: f, findings }).toEqual({ file: f, findings: [] });
  }
});
