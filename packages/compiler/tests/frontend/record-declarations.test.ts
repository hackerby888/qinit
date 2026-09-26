import { describe, expect, test } from "bun:test";
import type { ClassTemplateDecl, FunctionDecl, FunctionTemplateDecl, StructDecl } from "../../src/ast";
import { AstKind, DiagnosticSeverity } from "../../src/shared/enums";
import { Lexer } from "../../src/frontend/lexer";
import { Parser } from "../../src/frontend/parser";
import { validateAndDesugar } from "../../src/frontend/validation";
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
        const parseErrors = parser.getDiagnostics().filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR);

        expect(parseErrors).toEqual([]);

        const records = unit.declarations.filter((declaration): declaration is StructDecl => declaration.kind === AstKind.STRUCT);
        const templates = unit.declarations.filter((declaration): declaration is ClassTemplateDecl => declaration.kind === AstKind.CLASS_TEMPLATE);

        expect(records.map((record) => [record.name, record.hasBody, record.isUnion ?? false])).toEqual([
            ["Forward", false, false],
            ["Forward", true, false],
            ["Empty", true, false],
            ["Empty", true, false],
            ["EmptyClass", true, false],
            ["EmptyUnion", true, true],
        ]);
        expect(templates.map((template) => [template.name, template.hasBody])).toEqual([
            ["TemplateForward", false],
            ["TemplateForward", true],
        ]);

        const validationErrors = validateAndDesugar(unit).filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR);
        expect(validationErrors.map((diagnostic) => diagnostic.message)).toEqual(["duplicate type definition 'Empty'"]);
    });

    test("uses a nested template definition after its forward declaration", () => {
        const result = analyzeContract({
            source: `
struct NestedTemplateForward : public ContractBase {
  struct Base { uint64 value; };
  template <typename T> struct Wrapper;
  template <typename T> struct Wrapper : Base {};
  struct StateData { Wrapper<uint8> wrapper; };
};`,
            contractName: "NestedTemplateForward",
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
struct TemplateEmptyBase : public ContractBase {
  template <typename T> struct Empty {};
  struct StateData : Empty<uint8> { Empty<uint8> member; };
};`,
            contractName: "TemplateEmptyBase",
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
struct IndirectEmptyBase : public ContractBase {
  struct Empty {};
  struct Intermediate : Empty {};
  struct StateData : Intermediate { Empty member; };
};`,
            contractName: "IndirectEmptyBase",
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

    test("records const and static on member functions", () => {
        const source = `
struct S {
    uint64 a() const { return 1; }
    uint64 b() { return 2; }
    static uint64 c() { return 3; }
    template <typename T> T d() const { return T(); }
    template <typename T> static T e() { return T(); }
};
template <typename T> struct W { const T& get() const; T& mut(); };
`;
        const parser = new Parser(new Lexer(source).tokenize());
        const unit = parser.parseTranslationUnit();
        expect(parser.getDiagnostics().filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toEqual([]);

        const qualifiers = (members: StructDecl["members"]) =>
            members
                .filter((member): member is FunctionDecl | FunctionTemplateDecl => member.kind === AstKind.FUNCTION || member.kind === AstKind.FUNCTION_TEMPLATE)
                .map((member) => [member.name, member.isConst ?? false, member.isStatic ?? false]);
        const record = unit.declarations.find((declaration): declaration is StructDecl => declaration.kind === AstKind.STRUCT && declaration.name === "S")!;
        const template = unit.declarations.find((declaration): declaration is ClassTemplateDecl => declaration.kind === AstKind.CLASS_TEMPLATE)!;

        expect(qualifiers(record.members)).toEqual([
            ["a", true, false],
            ["b", false, false],
            ["c", false, true],
            ["d", true, false],
            ["e", false, true],
        ]);
        expect(qualifiers(template.members)).toEqual([
            ["get", true, false],
            ["mut", false, false],
        ]);
    });
});
