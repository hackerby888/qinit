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
        const nameTok = this.parser.state.expect("identifier", "namespace name");
        const name = nameTok?.text ?? "";
        let body: Declaration[] = [];
        if (this.parser.state.tryConsume("l_brace")) {
            body = this.parser.declarations.parseDeclarationList();
            this.parser.state.expect("r_brace", "namespace close");
        }
        return {
            kind: "namespace",
            name,
            body,
            span: this.parser.recovery.makeSpan(start),
        };
    }

    parseStruct(): StructDecl {
        const start = this.parser.state.next().span; // struct
        const nameTok = this.parser.state.expect("identifier", "struct name");
        const name = nameTok?.text ?? "";
        // Partial / explicit specialization: `struct Foo<ProposalDataYesNo, numOfVotes> : ... { ... }`.
        let specializationArgs: TypeSpec[] | undefined;
        if (this.parser.state.peek().kind === "l_angle") {
            specializationArgs = this.parser.records.parseSpecializationArgs();
        }
        const bases: TypeSpec[] = [];
        // Check for inheritance: struct Foo : public Base
        if (this.parser.state.tryConsume("colon")) {
            bases.push(this.parser.types.parseAccessAndType());
            while (this.parser.state.tryConsume("comma")) {
                bases.push(this.parser.types.parseAccessAndType());
            }
        }
        const members: Declaration[] = [];
        let hadBody = false;
        if (this.parser.state.tryConsume("l_brace")) {
            hadBody = true;
            members.push(...this.parser.declarations.parseClassMembers());
            this.parser.state.expect("r_brace", "struct close");
        }
        const struct: StructDecl = {
            kind: "struct",
            name,
            bases,
            members,
            specializationArgs,
            span: this.parser.recovery.makeSpan(start),
        };
        // Combined form: `struct Tag {...} field[N], field2;` — declarators after the body become member variables whose type is
        if (hadBody && this.parser.records.declaratorFollows()) {
            const declType: TypeSpec = { kind: "inline_struct", struct, span: start };
            while (this.parser.state.peek().kind === "star" || this.parser.state.peek().kind === "amp")
                this.parser.state.next();
            const first = this.parser.state.expect("identifier", "struct declarator")?.text ?? "";
            const vars = this.parser.functions.parseDeclaratorList(declType, first, false, false);
            for (const varValue of vars)
                this.parser.state.pendingDeclarations.push(varValue);
        }
        else {
            this.parser.state.tryConsume("semicolon");
        }
        return struct;
    }

    declaratorFollows(): boolean {
        const kind = this.parser.state.peek().kind;
        return kind === "identifier" || kind === "star" || kind === "amp" || kind === "l_bracket";
    }

    parseSpecializationArgs(): TypeSpec[] {
        this.parser.state.next(); // <
        const callArguments: TypeSpec[] = [];
        while (!this.parser.state.eof() && this.parser.state.peek().kind !== "r_angle") {
            const kind = this.parser.state.peek().kind;
            if (kind === "int_literal" ||
                kind === "l_paren" ||
                kind === "kw_sizeof" ||
                kind === "char_literal" ||
                kind === "minus" ||
                kind === "tilde" ||
                kind === "kw_true" ||
                kind === "kw_false") {
                callArguments.push({ kind: "expr_value", expression: this.parser.expressions.parseShift(), span: this.parser.state.peek().span });
            }
            else {
                callArguments.push(this.parser.types.parseTypeSpec());
            }
            if (!this.parser.state.tryConsume("comma"))
                break;
        }
        this.parser.state.consumeTemplateAngleClose();
        return callArguments;
    }

    parseUnion(): StructDecl {
        const start = this.parser.state.next().span; // union
        let name = "";
        // Union may be anonymous
        if (this.parser.state.peek().kind === "identifier") {
            name = this.parser.state.next().text;
        }
        const members: Declaration[] = [];
        let hadBody = false;
        if (this.parser.state.tryConsume("l_brace")) {
            hadBody = true;
            members.push(...this.parser.declarations.parseClassMembers());
            this.parser.state.expect("r_brace", "union close");
        }
        const union: StructDecl = {
            kind: "struct",
            name,
            bases: [],
            members,
            isUnion: true,
            span: this.parser.recovery.makeSpan(start),
        };
        // Combined form: `union Data {...} data;` — the declarator after the body is a member variable of this
        if (hadBody && this.parser.records.declaratorFollows()) {
            const declType: TypeSpec = { kind: "inline_struct", struct: union, span: start };
            while (this.parser.state.peek().kind === "star" || this.parser.state.peek().kind === "amp")
                this.parser.state.next();
            const first = this.parser.state.expect("identifier", "union declarator")?.text ?? "";
            const vars = this.parser.functions.parseDeclaratorList(declType, first, false, false);
            for (const varValue of vars)
                this.parser.state.pendingDeclarations.push(varValue);
        }
        else {
            this.parser.state.tryConsume("semicolon");
        }
        return union;
    }

    parseClassOrTemplate(): StructDecl | ClassTemplateDecl {
        // "class" keyword — could be a plain class or a template
        return this.parser.records.parseStruct(); // In QPI subset, class ≡ struct
    }
}
