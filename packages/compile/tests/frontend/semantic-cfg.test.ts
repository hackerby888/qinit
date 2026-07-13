import { describe, expect, test } from "bun:test";
import { Lexer } from "../../src/lexer";
import { Parser } from "../../src/parser";
import { validateAndDesugar } from "../../src/validate";

function validateSource(source: string) {
  const parser = new Parser(new Lexer(source).tokenize());
  const unit = parser.parseTranslationUnit();
  const parseErrors = parser
    .getDiagnostics()
    .filter((diagnostic) => diagnostic.severity === "error");

  expect(parseErrors, `test source did not parse: ${source}`).toEqual([]);
  return validateAndDesugar(unit).filter((diagnostic) => diagnostic.severity === "error");
}

describe("semantic validation - control-flow graph", () => {
  const rejected = [
    [
      "rejects a non-void function with only one returning if branch",
      "uint64 f(bool condition) { if (condition) return 1; }",
    ],
    [
      "rejects a non-void switch without a default return",
      "uint64 f(uint64 x) { switch (x) { case 0: return 1; case 1: return 2; } }",
    ],
    [
      "rejects a loop that can terminate without returning",
      "uint64 f(bool condition) { while (condition) { return 1; } }",
    ],
    [
      "rejects duplicate default labels",
      "uint64 f(uint64 x) { switch (x) { default: return 1; default: return 2; } }",
    ],
    [
      "rejects a non-constant case label",
      "uint64 f(uint64 x) { switch (x) { case x: return 1; default: return 2; } }",
    ],
    ["rejects a case label outside a switch", "uint64 f() { case 1: return 1; }"],
    ["rejects break outside a loop or switch", "void f() { break; }"],
    ["rejects continue outside a loop", "void f() { continue; }"],
    ["rejects an undefined goto label", "void f() { goto missing; }"],
    ["rejects duplicate goto labels", "void f() { again: ; again: ; }"],
    [
      "rejects goto that crosses an initialized local",
      "uint64 f() { goto done; uint64 value = 7; done: return value; }",
    ],
    ["rejects assignment to an rvalue", "void f(uint64 value) { 1 = value; }"],
    ["rejects incrementing a call result", "uint64 value() { return 1; } void f() { ++value(); }"],
    [
      "rejects binding a mutable reference to a temporary",
      "uint64 f() { uint64& value = 1; return value; }",
    ],
    [
      "rejects a non-default parameter after a default parameter",
      "uint64 f(uint64 first = 1, uint64 second) { return first + second; }",
    ],
    [
      "requires an explicit return even when a loop is syntactically infinite",
      "uint64 f() { while (true) {} }",
    ],
  ] as const;

  for (const [name, source] of rejected) {
    test(name, () => {
      expect(validateSource(source).length).toBeGreaterThan(0);
    });
  }

  const accepted = [
    [
      "accepts exhaustive if and else returns",
      "uint64 f(bool condition) { if (condition) return 1; else return 2; }",
    ],
    [
      "accepts nested exhaustive branches",
      "uint64 f(bool a, bool b) { if (a) { if (b) return 1; else return 2; } else { return 3; } }",
    ],
    [
      "accepts an exhaustive switch with a default",
      "uint64 f(uint64 x) { switch (x) { case 0: return 1; default: return 2; } }",
    ],
    [
      "accepts break and continue in their valid contexts",
      "void f(bool condition) { while (condition) { if (condition) continue; break; } switch (1) { case 1: break; default: break; } }",
    ],
    ["accepts a resolved forward goto", "uint64 f() { goto done; return 1; done: return 2; }"],
  ] as const;

  for (const [name, source] of accepted) {
    test(name, () => {
      expect(validateSource(source)).toEqual([]);
    });
  }
});
