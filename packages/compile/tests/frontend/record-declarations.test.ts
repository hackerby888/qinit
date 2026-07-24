import { describe, expect, test } from "bun:test";
import type {
  ClassTemplateDecl,
  StructDecl,
} from "../../src/ast";
import { AstKind, DiagnosticSeverity } from "../../src/enums";
import { Lexer } from "../../src/lexer";
import { Parser } from "../../src/parser";
import { validateAndDesugar } from "../../src/validate";
import { analyzeContract } from "../../src/analyzer";

describe("record declarations", () => {
  test("distinguishes forward declarations from empty definitions", () => {
    const source = `
struct Forward;
struct Forward {};
struct Empty {};
struct Empty {};
class EmptyClass {};
union EmptyUnion {};
template <typename T> struct TemplateForward;
template <typename T> struct TemplateForward {};
`;
    const parser = new Parser(new Lexer(source).tokenize());
    const unit = parser.parseTranslationUnit();
    const parseErrors = parser.getDiagnostics().filter(
      (diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR,
    );

    expect(parseErrors).toEqual([]);

    const records = unit.declarations.filter(
      (declaration): declaration is StructDecl => (
        declaration.kind === AstKind.STRUCT
      ),
    );
    const templates = unit.declarations.filter(
      (declaration): declaration is ClassTemplateDecl => (
        declaration.kind === AstKind.CLASS_TEMPLATE
      ),
    );

    expect(records.map((record) => [
      record.name,
      record.hasBody,
      record.isUnion ?? false,
    ])).toEqual([
      ["Forward", false, false],
      ["Forward", true, false],
      ["Empty", true, false],
      ["Empty", true, false],
      ["EmptyClass", true, false],
      ["EmptyUnion", true, true],
    ]);
    expect(templates.map((template) => [
      template.name,
      template.hasBody,
    ])).toEqual([
      ["TemplateForward", false],
      ["TemplateForward", true],
    ]);

    const validationErrors = validateAndDesugar(unit).filter(
      (diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR,
    );
    expect(validationErrors.map((diagnostic) => diagnostic.message)).toEqual([
      "duplicate type definition 'Empty'",
    ]);
  });

  test("uses a nested template definition after its forward declaration", () => {
    const result = analyzeContract({
      source: `
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Base { uint64 value; };
  template <typename T> struct Wrapper;
  template <typename T> struct Wrapper : Base {};
  struct StateData { Wrapper<uint8> wrapper; };
};`,
      name: "NestedTemplateForward",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.idl?.state.size).toBe(8);
    expect(result.idl?.state.fields[0]).toMatchObject({
      name: "wrapper",
      offset: 0,
      size: 8,
    });
  });

  test("keeps empty template bases distinct from same-type members", () => {
    const result = analyzeContract({
      source: `
struct CONTRACT_STATE_TYPE : public ContractBase {
  template <typename T> struct Empty {};
  struct StateData : Empty<uint8> { Empty<uint8> member; };
};`,
      name: "TemplateEmptyBase",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.idl?.state).toMatchObject({
      size: 2,
      align: 1,
      fields: [
        {
          name: "member",
          offset: 1,
          size: 1,
        },
      ],
    });
  });

  test("keeps indirect empty bases distinct from same-type members", () => {
    const result = analyzeContract({
      source: `
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Empty {};
  struct Intermediate : Empty {};
  struct StateData : Intermediate { Empty member; };
};`,
      name: "IndirectEmptyBase",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.idl?.state).toMatchObject({
      size: 2,
      align: 1,
      fields: [
        {
          name: "member",
          offset: 1,
          size: 1,
        },
      ],
    });
  });
});
