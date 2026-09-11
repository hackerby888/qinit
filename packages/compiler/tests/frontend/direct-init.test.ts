// `T name(args);` in a body used to be read as a function declaration whenever the first argument was an identifier, so
// `AssetOwnershipIterator it(asset, sel);` never became a local. Class scope keeps the function reading.
import { describe, expect, test } from "bun:test";
import type { FunctionDecl, StructDecl, VariableDecl } from "../../src/ast";
import { AstKind, DiagnosticSeverity } from "../../src/shared/enums";
import { Lexer } from "../../src/frontend/lexer";
import { Parser } from "../../src/frontend/parser";

function parseStruct(source: string): StructDecl {
    const parser = new Parser(new Lexer(source).tokenize());
    const unit = parser.parseTranslationUnit();
    const parseErrors = parser.getDiagnostics().filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR);

    expect(parseErrors, `test source did not parse: ${source}`).toEqual([]);
    return unit.declarations.find((declaration): declaration is StructDecl => declaration.kind === AstKind.STRUCT)!;
}

function memberFunction(record: StructDecl, name: string): FunctionDecl {
    return record.members.find((member): member is FunctionDecl => member.kind === AstKind.FUNCTION && member.name === name)!;
}

describe("direct initialization in a body", () => {
    test("`T name(ident, ident)` is a local with a constructor initializer", () => {
        const record = parseStruct(`struct S { void f() { Foo x(asset, AssetOwnershipSelect::any()); Foo y(locals.asset); } };`);
        const body = memberFunction(record, "f").body!;
        const locals = (body.kind === AstKind.COMPOUND ? body.body : []).map((statement) => {
            expect(statement.kind).toBe(AstKind.DECLARATION);
            const declaration = (statement as { declaration: VariableDecl }).declaration;
            expect(declaration.kind).toBe(AstKind.VARIABLE);
            return [declaration.name, declaration.initializer?.kind, (declaration.initializer as { callArguments: unknown[] }).callArguments.length];
        });

        expect(locals).toEqual([
            ["x", AstKind.CONSTRUCT, 2],
            ["y", AstKind.CONSTRUCT, 1],
        ]);
    });

    test("a member whose parameter list starts with a type name is still a function", () => {
        const record = parseStruct(`struct S { void f(Foo x); void g(Foo); };`);

        expect(memberFunction(record, "f").params.map((param) => param.name)).toEqual(["x"]);
        expect(memberFunction(record, "g").params).toHaveLength(1);
    });

    test("a named parameter after the identifier keeps the function reading inside a local struct", () => {
        const record = parseStruct(`struct S { void f() { struct Local { void g(Foo x); }; } };`);

        expect(memberFunction(record, "f").body).toBeDefined();
    });
});
