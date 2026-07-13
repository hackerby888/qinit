import type { ClassTemplateDecl, Declaration, FunctionTemplateDecl, Statement, TemplateParam, TypeSpec } from "../../../ast";
import { isTypeKeyword } from "../../../lexer";
import type { ParserInternals } from "../parser-context";

export function parseTemplateDeclaration(context: ParserInternals): Declaration {
    context.next(); // template
    context.expect("l_angle", "template params");
    const params = context.parseTemplateParams();
    context.consumeAngleClose();
    const tok = context.peek();
    if (tok.kind === "kw_struct" || tok.kind === "kw_class") {
        const struct = context.parseStruct();
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
    return context.parseFunctionTemplate(params);
}

export function parseTemplateParams(context: ParserInternals): TemplateParam[] {
    const params: TemplateParam[] = [];
    while (!context.eof() && context.peek().kind !== "r_angle") {
        const tok = context.peek();
        if (tok.kind === "kw_typename" || tok.kind === "kw_class") {
            context.next();
            const nameTok = context.expect("identifier", "template param name");
            if (!nameTok)
                break;
            const name = nameTok.text;
            // Default: typename T = DefaultType
            let def: TypeSpec | undefined;
            if (context.tryConsume("eq")) {
                def = context.parseTypeSpec();
            }
            params.push({ kind: "type", name, default: def });
        }
        else if (isTypeKeyword(tok.kind) || tok.kind === "identifier") {
            // Non-type parameter: uint64 L
            const type = context.parseTypeSpec();
            const nameTok = context.expect("identifier", "non-type param name");
            if (!nameTok)
                break;
            const name = nameTok.text;
            if (context.tryConsume("eq")) {
                // The default value runs up to the closing `>` of the template list — don't let a top-level
                context.gtDisabled++;
                const defVal = context.parseExpression();
                context.gtDisabled--;
                params.push({ kind: "non_type_default", name, type, default: defVal });
            }
            else {
                params.push({ kind: "non_type", name, type });
            }
        }
        else {
            break;
        }
        if (!context.tryConsume("comma")) {
            break;
        }
    }
    return params;
}

export function parseFunctionTemplate(context: ParserInternals, params: TemplateParam[]): FunctionTemplateDecl {
    // Storage-class / qualifier specifiers before the return type (static constexpr inline ...).
    let isConstexpr = false;
    while (true) {
        if (context.tryConsumeKw("static")) {
            continue;
        }
        if (context.tryConsumeKw("inline")) {
            continue;
        }
        if (context.tryConsumeKw("constexpr")) {
            isConstexpr = true;
            continue;
        }
        if (context.tryConsumeKw("friend")) {
            continue;
        }
        break;
    }
    const retType = context.parseTypeSpec();
    const nameTok = context.parseMaybeQualifiedName();
    if (!nameTok) {
        return {
            kind: "function_template",
            name: "",
            params,
            returnType: retType,
            isConstexpr,
            span: context.peek().span,
        };
    }
    context.expect("l_paren", "function params");
    const functionParameters = context.parseFunctionParams();
    context.expect("r_paren", "function params close");
    context.tryConsumeKw("const");
    context.tryConsumeKw("noexcept");
    let body: Statement | undefined;
    if (context.peek().kind === "l_brace") {
        body = context.parseFunctionBody();
    }
    else {
        context.expect("semicolon", "function declaration");
    }
    return {
        kind: "function_template",
        name: nameTok,
        params,
        functionParameters,
        returnType: retType,
        body,
        isConstexpr,
        span: context.makeSpan(retType.span ?? context.peek().span),
    };
}
