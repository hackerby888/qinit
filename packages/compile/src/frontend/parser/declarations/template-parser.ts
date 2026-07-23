import { AstKind, TokenKind } from "../../../enums";
import type {
    ClassTemplateDecl,
    Declaration,
    FunctionTemplateDecl,
    Statement,
    TemplateParam,
    TypeSpec,
} from "../../../ast";
import { isTypeKeyword } from "../../../lexer";
import type { Parser } from "../parser";

export class TemplateParser {
    constructor(private readonly parser: Parser) {}

    parseTemplateDeclaration(): Declaration {
        this.parser.state.next(); // template
        this.parser.state.expect(TokenKind.L_ANGLE, "template params");
        const params = this.parser.templates.parseTemplateParams();
        this.parser.state.consumeTemplateAngleClose();
        const tok = this.parser.state.peek();
        if (tok.kind === TokenKind.KW_STRUCT || tok.kind === TokenKind.KW_CLASS) {
            const struct = this.parser.records.parseStruct();
            return {
                kind: AstKind.CLASS_TEMPLATE,
                name: struct.name,
                params,
                members: struct.members,
                bases: struct.bases,
                specializationArgs: struct.specializationArgs,
                span: struct.span,
            } as ClassTemplateDecl;
        }
        // Function template
        return this.parser.templates.parseFunctionTemplate(params);
    }

    parseTemplateParams(): TemplateParam[] {
        const params: TemplateParam[] = [];
        while (!this.parser.state.eof() && this.parser.state.peek().kind !== TokenKind.R_ANGLE) {
            const tok = this.parser.state.peek();
            if (tok.kind === TokenKind.KW_TYPENAME || tok.kind === TokenKind.KW_CLASS) {
                this.parser.state.next();
                const nameTok = this.parser.state.expect(TokenKind.IDENTIFIER, "template param name");
                if (!nameTok)
                    break;
                const name = nameTok.text;
                // Default: typename T = DefaultType
                let def: TypeSpec | undefined;
                if (this.parser.state.tryConsume(TokenKind.EQ)) {
                    def = this.parser.types.parseTypeSpec();
                }
                params.push({ kind: AstKind.TYPE, name, default: def });
            }
            else if (isTypeKeyword(tok.kind) || tok.kind === TokenKind.IDENTIFIER) {
                // Non-type parameter: uint64 L
                const type = this.parser.types.parseTypeSpec();
                const nameTok = this.parser.state.expect(TokenKind.IDENTIFIER, "non-type param name");
                if (!nameTok)
                    break;
                const name = nameTok.text;
                if (this.parser.state.tryConsume(TokenKind.EQ)) {
                    // The default value runs up to the closing `>` of the template list — don't let a top-level
                    this.parser.state.templateAngleDepth++;
                    const defVal = this.parser.expressions.parseExpression();
                    this.parser.state.templateAngleDepth--;
                    params.push({ kind: AstKind.NON_TYPE_DEFAULT, name, type, default: defVal });
                }
                else {
                    params.push({ kind: AstKind.NON_TYPE, name, type });
                }
            }
            else {
                break;
            }
            if (!this.parser.state.tryConsume(TokenKind.COMMA)) {
                break;
            }
        }
        return params;
    }

    parseFunctionTemplate(params: TemplateParam[]): FunctionTemplateDecl {
        // Storage-class / qualifier specifiers before the return type (static constexpr inline ...).
        let isConstexpr = false;
        while (true) {
            if (this.parser.state.tryConsumeKeyword("static")) {
                continue;
            }
            if (this.parser.state.tryConsumeKeyword("inline")) {
                continue;
            }
            if (this.parser.state.tryConsumeKeyword("constexpr")) {
                isConstexpr = true;
                continue;
            }
            if (this.parser.state.tryConsumeKeyword("friend")) {
                continue;
            }
            break;
        }
        const retType = this.parser.types.parseTypeSpec();
        const nameTok = this.parser.types.parseMaybeQualifiedName();
        if (!nameTok) {
            return {
                kind: AstKind.FUNCTION_TEMPLATE,
                name: "",
                params,
                returnType: retType,
                isConstexpr,
                span: this.parser.state.peek().span,
            };
        }
        this.parser.state.expect(TokenKind.L_PAREN, "function params");
        const functionParameters = this.parser.functions.parseFunctionParams();
        this.parser.state.expect(TokenKind.R_PAREN, "function params close");
        this.parser.state.tryConsumeKeyword("const");
        this.parser.state.tryConsumeKeyword("noexcept");
        let body: Statement | undefined;
        if (this.parser.state.peek().kind === TokenKind.L_BRACE) {
            body = this.parser.parseFunctionBody();
        }
        else {
            this.parser.state.expect(TokenKind.SEMICOLON, "function declaration");
        }
        return {
            kind: AstKind.FUNCTION_TEMPLATE,
            name: nameTok,
            params,
            functionParameters,
            returnType: retType,
            body,
            isConstexpr,
            span: this.parser.recovery.makeSpan(retType.span ?? this.parser.state.peek().span),
        };
    }
}
