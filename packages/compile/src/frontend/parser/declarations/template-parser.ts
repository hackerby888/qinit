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
        this.parser.state.expect("l_angle", "template params");
        const params = this.parser.templates.parseTemplateParams();
        this.parser.state.consumeTemplateAngleClose();
        const tok = this.parser.state.peek();
        if (tok.kind === "kw_struct" || tok.kind === "kw_class") {
            const struct = this.parser.records.parseStruct();
            return {
                kind: "class_template",
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
        while (!this.parser.state.eof() && this.parser.state.peek().kind !== "r_angle") {
            const tok = this.parser.state.peek();
            if (tok.kind === "kw_typename" || tok.kind === "kw_class") {
                this.parser.state.next();
                const nameTok = this.parser.state.expect("identifier", "template param name");
                if (!nameTok)
                    break;
                const name = nameTok.text;
                // Default: typename T = DefaultType
                let def: TypeSpec | undefined;
                if (this.parser.state.tryConsume("eq")) {
                    def = this.parser.types.parseTypeSpec();
                }
                params.push({ kind: "type", name, default: def });
            }
            else if (isTypeKeyword(tok.kind) || tok.kind === "identifier") {
                // Non-type parameter: uint64 L
                const type = this.parser.types.parseTypeSpec();
                const nameTok = this.parser.state.expect("identifier", "non-type param name");
                if (!nameTok)
                    break;
                const name = nameTok.text;
                if (this.parser.state.tryConsume("eq")) {
                    // The default value runs up to the closing `>` of the template list — don't let a top-level
                    this.parser.state.templateAngleDepth++;
                    const defVal = this.parser.expressions.parseExpression();
                    this.parser.state.templateAngleDepth--;
                    params.push({ kind: "non_type_default", name, type, default: defVal });
                }
                else {
                    params.push({ kind: "non_type", name, type });
                }
            }
            else {
                break;
            }
            if (!this.parser.state.tryConsume("comma")) {
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
                kind: "function_template",
                name: "",
                params,
                returnType: retType,
                isConstexpr,
                span: this.parser.state.peek().span,
            };
        }
        this.parser.state.expect("l_paren", "function params");
        const functionParameters = this.parser.functions.parseFunctionParams();
        this.parser.state.expect("r_paren", "function params close");
        this.parser.state.tryConsumeKeyword("const");
        this.parser.state.tryConsumeKeyword("noexcept");
        let body: Statement | undefined;
        if (this.parser.state.peek().kind === "l_brace") {
            body = this.parser.parseFunctionBody();
        }
        else {
            this.parser.state.expect("semicolon", "function declaration");
        }
        return {
            kind: "function_template",
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
