import { AstKind, TokenKind } from "../../../enums";
import type {
    ClassTemplateDecl,
    Declaration,
    NamespaceDecl,
    StructDecl,
    TypeSpec,
} from "../../../ast";
import type { Parser } from "../parser";

export class RecordParser {
    constructor(private readonly parser: Parser) {}

    parseNamespace(): NamespaceDecl {
        const start = this.parser.state.next().span; // namespace
        const nameTok = this.parser.state.expect(TokenKind.IDENTIFIER, "namespace name");
        const name = nameTok?.text ?? "";
        let body: Declaration[] = [];
        if (this.parser.state.tryConsume(TokenKind.L_BRACE)) {
            body = this.parser.declarations.parseDeclarationList();
            this.parser.state.expect(TokenKind.R_BRACE, "namespace close");
        }
        return {
            kind: AstKind.NAMESPACE,
            name,
            body,
            span: this.parser.recovery.makeSpan(start),
        };
    }

    parseStruct(): StructDecl {
        const start = this.parser.state.next().span; // struct
        const nameTok = this.parser.state.expect(TokenKind.IDENTIFIER, "struct name");
        const name = nameTok?.text ?? "";
        // Partial / explicit specialization: `struct Foo<ProposalDataYesNo, numOfVotes> : ... { ... }`.
        let specializationArgs: TypeSpec[] | undefined;
        if (this.parser.state.peek().kind === TokenKind.L_ANGLE) {
            specializationArgs = this.parser.records.parseSpecializationArgs();
        }
        const bases: TypeSpec[] = [];
        // Check for inheritance: struct Foo : public Base
        if (this.parser.state.tryConsume(TokenKind.COLON)) {
            bases.push(this.parser.types.parseAccessAndType());
            while (this.parser.state.tryConsume(TokenKind.COMMA)) {
                bases.push(this.parser.types.parseAccessAndType());
            }
        }
        const members: Declaration[] = [];
        let hadBody = false;
        if (this.parser.state.tryConsume(TokenKind.L_BRACE)) {
            hadBody = true;
            members.push(...this.parser.declarations.parseClassMembers());
            this.parser.state.expect(TokenKind.R_BRACE, "struct close");
        }
        const struct: StructDecl = {
            kind: AstKind.STRUCT,
            name,
            bases,
            members,
            specializationArgs,
            span: this.parser.recovery.makeSpan(start),
        };
        // Declarators after a combined struct body use the new struct as their type.
        if (hadBody && this.parser.records.declaratorFollows()) {
            const declType: TypeSpec = { kind: AstKind.INLINE_STRUCT, struct, span: start };
            while (this.parser.state.peek().kind === TokenKind.STAR || this.parser.state.peek().kind === TokenKind.AMP)
                this.parser.state.next();
            const first = this.parser.state.expect(TokenKind.IDENTIFIER, "struct declarator")?.text ?? "";
            const vars = this.parser.functions.parseDeclaratorList(declType, first, false, false);
            for (const varValue of vars)
                this.parser.state.pendingDeclarations.push(varValue);
        }
        else {
            this.parser.state.tryConsume(TokenKind.SEMICOLON);
        }
        return struct;
    }

    declaratorFollows(): boolean {
        const kind = this.parser.state.peek().kind;
        return kind === TokenKind.IDENTIFIER || kind === TokenKind.STAR || kind === TokenKind.AMP || kind === TokenKind.L_BRACKET;
    }

    parseSpecializationArgs(): TypeSpec[] {
        this.parser.state.next(); // <
        const callArguments: TypeSpec[] = [];
        while (!this.parser.state.eof() && this.parser.state.peek().kind !== TokenKind.R_ANGLE) {
            const kind = this.parser.state.peek().kind;
            if (kind === TokenKind.INT_LITERAL ||
                kind === TokenKind.L_PAREN ||
                kind === TokenKind.KW_SIZEOF ||
                kind === TokenKind.CHAR_LITERAL ||
                kind === TokenKind.MINUS ||
                kind === TokenKind.TILDE ||
                kind === TokenKind.KW_TRUE ||
                kind === TokenKind.KW_FALSE) {
                callArguments.push({ kind: AstKind.EXPR_VALUE, expression: this.parser.expressions.parseShift(), span: this.parser.state.peek().span });
            }
            else {
                callArguments.push(this.parser.types.parseTypeSpec());
            }
            if (!this.parser.state.tryConsume(TokenKind.COMMA))
                break;
        }
        this.parser.state.consumeTemplateAngleClose();
        return callArguments;
    }

    parseUnion(): StructDecl {
        const start = this.parser.state.next().span; // union
        let name = "";
        // Union may be anonymous
        if (this.parser.state.peek().kind === TokenKind.IDENTIFIER) {
            name = this.parser.state.next().text;
        }
        const members: Declaration[] = [];
        let hadBody = false;
        if (this.parser.state.tryConsume(TokenKind.L_BRACE)) {
            hadBody = true;
            members.push(...this.parser.declarations.parseClassMembers());
            this.parser.state.expect(TokenKind.R_BRACE, "union close");
        }
        const union: StructDecl = {
            kind: AstKind.STRUCT,
            name,
            bases: [],
            members,
            isUnion: true,
            span: this.parser.recovery.makeSpan(start),
        };
        // A declarator after a combined union body uses the new union as its type.
        if (hadBody && this.parser.records.declaratorFollows()) {
            const declType: TypeSpec = { kind: AstKind.INLINE_STRUCT, struct: union, span: start };
            while (this.parser.state.peek().kind === TokenKind.STAR || this.parser.state.peek().kind === TokenKind.AMP)
                this.parser.state.next();
            const first = this.parser.state.expect(TokenKind.IDENTIFIER, "union declarator")?.text ?? "";
            const vars = this.parser.functions.parseDeclaratorList(declType, first, false, false);
            for (const varValue of vars)
                this.parser.state.pendingDeclarations.push(varValue);
        }
        else {
            this.parser.state.tryConsume(TokenKind.SEMICOLON);
        }
        return union;
    }

    parseClassOrTemplate(): StructDecl | ClassTemplateDecl {
        // "class" keyword — could be a plain class or a template
        return this.parser.records.parseStruct(); // In QPI subset, class ≡ struct
    }
}
