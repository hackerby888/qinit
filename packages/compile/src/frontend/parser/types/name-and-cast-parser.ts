import type { Expression } from "../../../ast";
import { isTypeKeyword } from "../../../lexer";
import type { ParserInternals } from "../parser-context";

const SCALAR_CAST_NAMES = new Set([
  "sint8",
  "uint8",
  "sint16",
  "uint16",
  "sint32",
  "uint32",
  "sint64",
  "uint64",
  "bit",
  "uint128",
  "uint128_t",
  "size_t",
  "int8_t",
  "uint8_t",
  "int16_t",
  "uint16_t",
  "int32_t",
  "uint32_t",
  "int64_t",
  "uint64_t",
]);

export function parseQualifiedName(context: ParserInternals, stopAtAngle = false): string {
    const parts: string[] = [];
    while (!context.eof()) {
        const tok = context.peek();
        if (stopAtAngle && tok.kind === "identifier" && context.peek(1).kind === "l_angle") {
            // Type position: `Sel<args>::type` is a dependent type — stop here and let the caller capture the template instance
            parts.push(context.next().text);
            break;
        }
        if (tok.kind === "kw_operator") {
            // operator overload name: consume `operator` + the operator symbol token(s).
            context.next();
            const opTok = context.peek();
            if (opTok.kind === "l_paren" && context.peek(1).kind === "r_paren") {
                context.next();
                context.next();
                parts.push("operator()");
            }
            else if (opTok.kind === "l_bracket" && context.peek(1).kind === "r_bracket") {
                context.next();
                context.next();
                parts.push("operator[]");
            }
            else if (opTok.kind === "identifier" ||
                isTypeKeyword(opTok.kind) ||
                opTok.kind === "kw_bool") {
                // conversion operator: operator bool() / operator T()
                parts.push("operator " + context.next().text);
            }
            else {
                parts.push("operator" + context.next().text);
            }
        }
        else if (tok.kind === "identifier") {
            parts.push(context.next().text);
            // ClassTemplate<args>::method — out-of-class definition. Drop the qualifier's template args
            if (context.peek().kind === "l_angle") {
                const save = (context.lex as any).index;
                if (context.skipAngleArgs() && context.peek().kind === "d_colon") {
                    // committed — fall through to the d_colon handler below
                }
                else {
                    (context.lex as any).index = save;
                }
            }
        }
        else if (tok.kind === "tilde" && context.peek(1).kind === "identifier") {
            // ~ClassName (destructor name)
            context.next();
            parts.push("~" + context.next().text);
        }
        else {
            break;
        }
        if (context.peek().kind === "d_colon") {
            context.next(); // ::
            parts.push("::");
            continue;
        }
        break;
    }
    if (parts.length === 0)
        return "";
    return parts.join("");
}

export function parseMaybeQualifiedName(context: ParserInternals): string {
    return context.parseQualifiedName();
}

export function skipAngleArgs(context: ParserInternals): boolean {
    if (context.peek().kind !== "l_angle")
        return false;
    context.next(); // <
    let depth = 1, guard = 0;
    while (!context.eof() && depth > 0 && guard++ < 500) {
        const kind = context.peek().kind;
        if (kind === "l_angle") {
            depth++;
            context.next();
            continue;
        }
        if (kind === "r_angle") {
            depth--;
            context.next();
            continue;
        }
        if (kind === "r_shift") {
            depth -= 2;
            context.next();
            continue;
        }
        if (kind === "semicolon" || kind === "l_brace")
            return false;
        context.next();
    }
    return depth <= 0;
}

export function isTypeCast(context: ParserInternals): boolean {
    const save = (context.lex as any).index;
    context.next(); // (
    let pureType = true;
    let sawTypeToken = false;
    let depth = 0;
    let saw = false;
    let sawNestedParen = false;
    let angleDepth = 0;
    let sawPtrRef = false;
    let tokenCount = 0;
    let loneIdent: string | null = null;
    let sawAngle = false;
    while (!context.eof()) {
        const token = context.peek();
        // In this subset, C-style casts have no parenthesized nested expressions.
        if (token.kind === "l_paren") {
            depth++;
            sawNestedParen = true;
            context.next();
            continue;
        }
        if (token.kind === "r_paren") {
            if (depth === 0) {
                context.next();
                break;
            }
            depth--;
            context.next();
            continue;
        }
        saw = true;
        const ok = isTypeKeyword(token.kind) ||
            token.kind === "kw_unsigned" ||
            token.kind === "kw_signed" ||
            token.kind === "kw_const" ||
            token.kind === "kw_struct" ||
            token.kind === "kw_enum" ||
            token.kind === "kw_class" ||
            token.kind === "star" ||
            token.kind === "amp" ||
            token.kind === "d_colon" ||
            token.kind === "l_angle" ||
            token.kind === "r_angle" ||
            token.kind === "r_shift" ||
            token.kind === "comma" ||
            token.kind === "identifier";
        // C-style casts here only target scalar type spellings.
        if (token.kind === "l_angle" && depth === 0)
            sawAngle = true;
        if ((token.kind === "r_angle" || token.kind === "r_shift") && angleDepth === 0)
            pureType = false;
        if (token.kind === "l_angle")
            angleDepth++;
        if (token.kind === "r_angle")
            angleDepth = Math.max(0, angleDepth - 1);
        if (token.kind === "r_shift")
            angleDepth = Math.max(0, angleDepth - 2);
        // In type-id context, `*`/`&` act as declarator suffixes inside template-free area.
        if ((token.kind === "star" || token.kind === "amp") && angleDepth === 0)
            sawPtrRef = true;
        if (sawPtrRef &&
            angleDepth === 0 &&
            (token.kind === "identifier" || token.kind === "d_colon" || isTypeKeyword(token.kind))) {
            pureType = false;
        }
        if (isTypeKeyword(token.kind) || token.kind === "identifier")
            sawTypeToken = true;
        if (!ok) {
            pureType = false;
        }
        tokenCount++;
        loneIdent = tokenCount === 1 && token.kind === "identifier" ? token.text : null;
        context.next();
    }
    // After the `)`, a cast must be followed by an operand (so `(id) + 5` is NOT a cast).
    const after = context.peek();
    const operandFollows = after.kind === "identifier" ||
        after.kind === "int_literal" ||
        after.kind === "l_paren" ||
        after.kind === "bang" ||
        after.kind === "tilde" ||
        after.kind === "minus" ||
        after.kind === "plus" ||
        after.kind === "amp" ||
        after.kind === "star" ||
        after.kind === "kw_true" ||
        after.kind === "kw_false" ||
        after.kind === "char_literal" ||
        after.kind === "string_literal" ||
        after.kind === "kw_this" ||
        after.kind === "kw_sizeof";
    (context.lex as any).index = save;
    // `(name) & x` / `(name) * x` / `(name) + x` / `(name) - x`: C++ resolves this
    if (loneIdent &&
        !SCALAR_CAST_NAMES.has(loneIdent) &&
        (after.kind === "amp" ||
            after.kind === "star" ||
            after.kind === "plus" ||
            after.kind === "minus")) {
        return false;
    }
    // A bare identifier in parens (`(L * 2 ...)` has operators → not pure) is a cast only
    return saw && pureType && sawTypeToken && operandFollows && !sawNestedParen && !sawAngle;
}

export function parseCast(context: ParserInternals): Expression {
    context.next(); // (
    const type = context.parseTypeSpec();
    context.expect("r_paren", "cast");
    const expression = context.parseUnary();
    return { kind: "c_cast", type, expression, span: expression.span };
}

export function parseSizeof(context: ParserInternals): Expression {
    const start = context.next().span; // sizeof
    if (context.tryConsume("l_paren")) {
        // sizeof(T) or sizeof(expr) Check if it's a type
        const tok = context.peek();
        if (isTypeKeyword(tok.kind) ||
            tok.kind === "kw_unsigned" ||
            tok.kind === "kw_signed" ||
            tok.kind === "kw_struct" ||
            tok.kind === "kw_enum" ||
            tok.kind === "kw_const" ||
            tok.kind === "kw_typename") {
            const type = context.parseTypeSpec();
            context.expect("r_paren", "sizeof type");
            return { kind: "sizeof_type", type, span: context.makeSpan(start) };
        }
        const expression = context.parseExpression();
        context.expect("r_paren", "sizeof expr");
        return { kind: "sizeof_expr", expression, span: context.makeSpan(start) };
    }
    // sizeof expr (without parens)
    const expression = context.parseUnary();
    return { kind: "sizeof_expr", expression, span: context.makeSpan(start) };
}
