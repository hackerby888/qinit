// Recursive-descent parser for the QPI C++ subset.

import type { Token, TokenKind } from "./lexer";
import { Lexer, isTypeKeyword } from "./lexer";
import type {
  Span,
  TypeSpec,
  Expression,
  Statement,
  Declaration,
  StructDecl,
  ClassTemplateDecl,
  FunctionTemplateDecl,
  FunctionDecl,
  VariableDecl,
  EnumDecl,
  EnumeratorDecl,
  TypedefDeclNode,
  NamespaceDecl,
  StaticAssertDecl,
  ExternBlockDecl,
  FriendDecl,
  EmptyDecl,
  TemplateParam,
  ParamDecl,
  AccessSpec,
  TranslationUnit,
  UnaryOp,
  BinaryOp,
  AssignOp,
} from "./ast";

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  span: Span;
  // "fidelity": the construct was dropped or lowered to a placeholder, so the emitted module would not faithfully reproduce
  category?: "fidelity";
}

// Scalar typedef spellings that remain casts even in the `(name) & x` binary-ambiguous position.
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

export class Parser {
  private lex: Lexer;
  private diagnostics: Diagnostic[] = [];
  // Diagnostics raised while parsing a function body in isolation. They stay visible (getDiagnostics
  private bodyDiagnostics: Diagnostic[] = [];
  // While > 0 (inside a template parameter/argument list), a top-level `>` / `>>` closes the list rather than
  private gtDisabled = 0;
  // Extra declarations produced by a single parse step (e.g. `struct {...} a, b[4];` yields the
  private pending: Declaration[] = [];

  constructor(tokens: Token[]) {
    this.lex = new Lexer("");
    // Inject pre-tokenized stream
    (this.lex as any).tokens = tokens;
    (this.lex as any).index = 0;
    // Ensure there's an eof token
    if (tokens.length === 0 || tokens[tokens.length - 1].kind !== "eof") {
      tokens.push({ kind: "eof", text: "", span: { start: 0, end: 0, line: 0, column: 0 } });
    }
  }

  parseTranslationUnit(): TranslationUnit {
    const start = this.peek().span;
    const declarations: Declaration[] = [];

    while (!this.eof()) {
      const before = (this.lex as any).index;
      const errsBefore = this.diagnostics.length;
      const declaration = this.parseDeclaration();
      if (declaration && declaration.kind !== "empty") declarations.push(declaration);
      while (this.pending.length) declarations.push(this.pending.shift()!);
      this.recover(before, errsBefore);
    }

    const end = this.last().span;
    return {
      declarations: declarations,
      span: { start: start.start, end: end.end, line: start.line, column: start.column },
    };
  }

  getDiagnostics(): Diagnostic[] {
    return [...this.diagnostics, ...this.bodyDiagnostics];
  }

  // Parse function bodies in isolation when qpi.h bodies exceed expression subset.
  private parseFunctionBody(): Statement {
    const toks = (this.lex as any).tokens as Token[];
    const openIdx = (this.lex as any).index;

    let depth = 0;
    let closeIdx = -1;
    for (let tokIndex = openIdx; tokIndex < toks.length; tokIndex++) {
      const kind = toks[tokIndex].kind;
      if (kind === "l_brace") {
        depth++;
      } else if (kind === "r_brace") {
        depth--;
        if (depth === 0) {
          closeIdx = tokIndex;
          break;
        }
      } else if (kind === "eof") {
        break;
      }
    }

    if (closeIdx < 0) {
      this.next(); // unbalanced — best-effort inline parse
      return this.parseCompoundStatement();
    }

    const slice = toks.slice(openIdx, closeIdx + 1);
    slice.push({ kind: "eof", text: "", span: toks[closeIdx].span });
    const sub = new Parser(slice);
    sub.next(); // consume `{`
    const body = sub.parseCompoundStatement();
    for (const diagnostic of sub.diagnostics) this.bodyDiagnostics.push(diagnostic);
    for (const bodyDiagnostic of sub.bodyDiagnostics) this.bodyDiagnostics.push(bodyDiagnostic);

    (this.lex as any).index = closeIdx + 1; // resume after the matched `}`
    return body;
  }

  // ---- Token helpers ----

  private peek(offset: number = 0): Token {
    return this.lex.peek(offset);
  }

  private next(): Token {
    const tok = this.lex.next();
    this._last = tok;
    return tok;
  }

  private last(): Token {
    return this._last ?? this.peek();
  }

  private eof(): boolean {
    return this.peek().kind === "eof";
  }

  private expect(kind: TokenKind, context: string): Token | null {
    const tok = this.peek();
    if (tok.kind === kind) {
      return this.next();
    }
    this.diagnostics.push({
      severity: "error",
      message: `Expected ${kind} but got ${tok.kind} (${tok.text}) in ${context}`,
      span: tok.span,
    });
    return null;
  }

  private tryConsume(kind: TokenKind): Token | null {
    if (this.peek().kind === kind) {
      return this.next();
    }
    return null;
  }

  private tryConsumeKw(kw: string): Token | null {
    const tok = this.peek();
    if (tok.text === kw) {
      return this.next();
    }
    return null;
  }

  // Close a template angle. C++ lexes `>>` (and `>=`) as one token; when it closes nested template
  private consumeAngleClose(): void {
    const tok = this.peek();
    const idx = (this.lex as any).index;
    const toks = (this.lex as any).tokens as Token[];
    if (tok.kind === "r_angle") {
      this.next();
      return;
    }
    if (tok.kind === "r_shift") {
      toks[idx] = { kind: "r_angle", text: ">", span: tok.span };
      this._last = tok;
      return; // consumed one '>', the remaining '>' stays as the current token
    }
    if (tok.kind === "gt_eq") {
      toks[idx] = { kind: "eq", text: "=", span: tok.span };
      this._last = tok;
      return;
    }
    this.expect("r_angle", "template close");
  }

  // ---- Declarations ----

  private parseDeclaration(): Declaration | null {
    const tok = this.peek();

    switch (tok.kind) {
      case "kw_namespace":
        return this.parseNamespace();
      case "kw_struct":
        return this.parseStruct();
      case "kw_class":
        return this.parseClassOrTemplate();
      case "kw_template":
        return this.parseTemplateDeclaration();
      case "kw_enum":
        return this.parseEnum();
      case "kw_typedef":
        return this.parseTypedef();
      case "kw_using":
        return this.parseUsing();
      case "kw_static_assert":
        return this.parseStaticAssertDecl();
      case "kw_extern":
        return this.parseExternBlock();
      case "kw_friend":
        return this.parseFriend();
      case "kw_public":
      case "kw_protected":
      case "kw_private":
        return this.parseAccessSpec();
      case "kw_constexpr":
      case "kw_static":
      case "kw_inline":
      case "kw_virtual":
        return this.parseFunctionOrVariable(); // with modifiers
      case "kw_const":
        // `const Type& name = ...` — a const qualifier belongs to the type, so peek the whole type
        return this.parseFunctionOrVariablePeekType();
      case "hash":
        return this.parsePreprocessorLine();
      case "kw_signed":
      case "kw_unsigned":
      case "kw_void":
      case "kw_bool":
      case "kw_char":
      case "kw_short":
      case "kw_int":
      case "kw_long":
      case "kw_double":
      case "kw_float":
      case "kw_auto":
      // collapsed multi-word builtin types (the lexer merges `unsigned int` → kw_unsigned_int etc.)
      case "kw_signed_char":
      case "kw_unsigned_char":
      case "kw_signed_short":
      case "kw_unsigned_short":
      case "kw_signed_int":
      case "kw_unsigned_int":
      case "kw_signed_long_long":
      case "kw_unsigned_long_long":
      case "kw_long_long":
        // Type keyword at top level → likely a variable declaration (or free function)
        return this.parseFunctionOrVariablePeekType();
      case "identifier":
        // Could be: function definition, variable declaration, or constructor
        return this.parseIdentifierDeclaration();
      case "semicolon":
        this.next(); // empty declaration
        return { kind: "empty", span: tok.span } as EmptyDecl;
      case "kw_union":
        return this.parseUnion();
      case "kw_operator": {
        // Conversion operator: `operator Type() const { ... }` — no leading return type. Parsed as a
        this.next();
        const targetType = this.parseTypeSpec();
        const targetName = targetType.kind === "name" ? targetType.name : "?";
        return this.parseFunctionRest(
          `operator ${targetName}`,
          targetType,
          false,
          false,
          false,
          false,
          false,
        );
      }
      default:
        // Skip unknown token — qpi.h has constructs our subset parser doesn't handle. Recorded as a
        this.bodyDiagnostics.push({
          severity: "warning",
          category: "fidelity",
          message: `skipped unparseable token '${tok.text}' (${tok.kind})`,
          span: tok.span,
        });
        this.next();
        return { kind: "empty", span: tok.span } as EmptyDecl;
    }
  }

  private parseNamespace(): NamespaceDecl {
    const start = this.next().span; // namespace
    const nameTok = this.expect("identifier", "namespace name");
    const name = nameTok?.text ?? "";

    let body: Declaration[] = [];

    if (this.tryConsume("l_brace")) {
      body = this.parseDeclarationList();
      this.expect("r_brace", "namespace close");
    }

    return {
      kind: "namespace",
      name,
      body,
      span: this.makeSpan(start),
    };
  }

  private parseStruct(): StructDecl {
    const start = this.next().span; // struct
    const nameTok = this.expect("identifier", "struct name");
    const name = nameTok?.text ?? "";

    // Partial / explicit specialization: `struct Foo<ProposalDataYesNo, numOfVotes> : ... { ... }`.
    let specializationArgs: TypeSpec[] | undefined;
    if (this.peek().kind === "l_angle") {
      specializationArgs = this.parseSpecializationArgs();
    }

    const bases: TypeSpec[] = [];

    // Check for inheritance: struct Foo : public Base
    if (this.tryConsume("colon")) {
      bases.push(this.parseAccessAndType());
      while (this.tryConsume("comma")) {
        bases.push(this.parseAccessAndType());
      }
    }

    const members: Declaration[] = [];
    let hadBody = false;
    if (this.tryConsume("l_brace")) {
      hadBody = true;
      members.push(...this.parseClassMembers());
      this.expect("r_brace", "struct close");
    }

    const struct: StructDecl = {
      kind: "struct",
      name,
      bases,
      members,
      specializationArgs,
      span: this.makeSpan(start),
    };

    // Combined form: `struct Tag {...} field[N], field2;` — declarators after the body become member variables whose type is
    if (hadBody && this.declaratorFollows()) {
      const declType: TypeSpec = { kind: "inline_struct", struct, span: start };
      while (this.peek().kind === "star" || this.peek().kind === "amp") this.next();
      const first = this.expect("identifier", "struct declarator")?.text ?? "";
      const vars = this.parseDeclaratorList(declType, first, false, false);
      for (const varValue of vars) this.pending.push(varValue);
    } else {
      this.tryConsume("semicolon");
    }

    return struct;
  }

  // True when a variable declarator (not `;`) follows a record body: an identifier, `*`, `&`, or `[`.
  private declaratorFollows(): boolean {
    const kind = this.peek().kind;
    return kind === "identifier" || kind === "star" || kind === "amp" || kind === "l_bracket";
  }

  // Parse the `<...>` of a (partial) class specialization head — `struct Foo<ProposalDataYesNo, numOfVotes>`.
  private parseSpecializationArgs(): TypeSpec[] {
    this.next(); // <
    const callArguments: TypeSpec[] = [];
    while (!this.eof() && this.peek().kind !== "r_angle") {
      const kind = this.peek().kind;
      if (
        kind === "int_literal" ||
        kind === "l_paren" ||
        kind === "kw_sizeof" ||
        kind === "char_literal" ||
        kind === "minus" ||
        kind === "tilde" ||
        kind === "kw_true" ||
        kind === "kw_false"
      ) {
        callArguments.push({ kind: "expr_value", expression: this.parseShift(), span: this.peek().span });
      } else {
        callArguments.push(this.parseTypeSpec());
      }
      if (!this.tryConsume("comma")) break;
    }
    this.consumeAngleClose();
    return callArguments;
  }

  private parseUnion(): StructDecl {
    const start = this.next().span; // union
    let name = "";

    // Union may be anonymous
    if (this.peek().kind === "identifier") {
      name = this.next().text;
    }

    const members: Declaration[] = [];
    let hadBody = false;
    if (this.tryConsume("l_brace")) {
      hadBody = true;
      members.push(...this.parseClassMembers());
      this.expect("r_brace", "union close");
    }

    const union: StructDecl = {
      kind: "struct",
      name,
      bases: [],
      members,
      isUnion: true,
      span: this.makeSpan(start),
    };

    // Combined form: `union Data {...} data;` — the declarator after the body is a member variable of this
    if (hadBody && this.declaratorFollows()) {
      const declType: TypeSpec = { kind: "inline_struct", struct: union, span: start };
      while (this.peek().kind === "star" || this.peek().kind === "amp") this.next();
      const first = this.expect("identifier", "union declarator")?.text ?? "";
      const vars = this.parseDeclaratorList(declType, first, false, false);
      for (const varValue of vars) this.pending.push(varValue);
    } else {
      this.tryConsume("semicolon");
    }

    return union;
  }

  private parseClassOrTemplate(): StructDecl | ClassTemplateDecl {
    // "class" keyword — could be a plain class or a template
    return this.parseStruct(); // In QPI subset, class ≡ struct
  }

  private parseTemplateDeclaration(): Declaration {
    this.next(); // template
    this.expect("l_angle", "template params");
    const params = this.parseTemplateParams();
    this.consumeAngleClose();

    const tok = this.peek();

    if (tok.kind === "kw_struct" || tok.kind === "kw_class") {
      const struct = this.parseStruct();
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
    return this.parseFunctionTemplate(params);
  }

  private parseTemplateParams(): TemplateParam[] {
    const params: TemplateParam[] = [];

    while (!this.eof() && this.peek().kind !== "r_angle") {
      const tok = this.peek();

      if (tok.kind === "kw_typename" || tok.kind === "kw_class") {
        this.next();
        const nameTok = this.expect("identifier", "template param name");
        if (!nameTok) break;
        const name = nameTok.text;

        // Default: typename T = DefaultType
        let def: TypeSpec | undefined;
        if (this.tryConsume("eq")) {
          def = this.parseTypeSpec();
        }

        params.push({ kind: "type", name, default: def });
      } else if (isTypeKeyword(tok.kind) || tok.kind === "identifier") {
        // Non-type parameter: uint64 L
        const type = this.parseTypeSpec();
        const nameTok = this.expect("identifier", "non-type param name");
        if (!nameTok) break;
        const name = nameTok.text;

        if (this.tryConsume("eq")) {
          // The default value runs up to the closing `>` of the template list — don't let a top-level
          this.gtDisabled++;
          const defVal = this.parseExpression();
          this.gtDisabled--;
          params.push({ kind: "non_type_default", name, type, default: defVal });
        } else {
          params.push({ kind: "non_type", name, type });
        }
      } else {
        break;
      }

      if (!this.tryConsume("comma")) {
        break;
      }
    }

    return params;
  }

  private parseFunctionTemplate(params: TemplateParam[]): FunctionTemplateDecl {
    // Storage-class / qualifier specifiers before the return type (static constexpr inline ...).
    let isConstexpr = false;
    while (true) {
      if (this.tryConsumeKw("static")) {
        continue;
      }
      if (this.tryConsumeKw("inline")) {
        continue;
      }
      if (this.tryConsumeKw("constexpr")) {
        isConstexpr = true;
        continue;
      }
      if (this.tryConsumeKw("friend")) {
        continue;
      }
      break;
    }

    const retType = this.parseTypeSpec();
    const nameTok = this.parseMaybeQualifiedName();
    if (!nameTok) {
      return {
        kind: "function_template",
        name: "",
        params,
        returnType: retType,
        isConstexpr,
        span: this.peek().span,
      };
    }

    this.expect("l_paren", "function params");
    const functionParameters = this.parseFunctionParams();
    this.expect("r_paren", "function params close");
    this.tryConsumeKw("const");
    this.tryConsumeKw("noexcept");

    let body: Statement | undefined;
    if (this.peek().kind === "l_brace") {
      body = this.parseFunctionBody();
    } else {
      this.expect("semicolon", "function declaration");
    }

    return {
      kind: "function_template",
      name: nameTok,
      params,
      functionParameters,
      returnType: retType,
      body,
      isConstexpr,
      span: this.makeSpan(retType.span ?? this.peek().span),
    };
  }

  private parseEnum(): EnumDecl {
    const start = this.next().span; // enum
    let isClass = false;

    // enum class Foo : uint8
    if (this.tryConsume("kw_class")) {
      isClass = true;
    }

    let name: string | undefined;
    if (this.peek().kind === "identifier") {
      name = this.next().text;
    }

    let underlyingType: TypeSpec | undefined;
    if (this.tryConsume("colon")) {
      underlyingType = this.parseTypeSpec();
    }

    const members: EnumeratorDecl[] = [];
    if (this.tryConsume("l_brace")) {
      members.push(...this.parseEnumeratorList());
      this.expect("r_brace", "enum close");
    }

    this.tryConsume("semicolon");

    return {
      kind: "enum",
      name,
      underlyingType,
      isClass,
      members,
      span: this.makeSpan(start),
    };
  }

  private parseEnumeratorList(): EnumeratorDecl[] {
    const members: EnumeratorDecl[] = [];

    while (!this.eof() && this.peek().kind !== "r_brace") {
      const nameTok = this.expect("identifier", "enumerator name");
      if (!nameTok) break;

      let value: Expression | undefined;
      if (this.tryConsume("eq")) {
        value = this.parseExpression();
      }

      members.push({ name: nameTok.text, value, span: nameTok.span });

      if (!this.tryConsume("comma")) {
        break;
      }
    }

    return members;
  }

  private parseTypedef(): TypedefDeclNode {
    const start = this.next().span; // typedef
    let type = this.parseTypeSpec();

    // Handle function pointer typedefs: typedef RetType (*Name)(Params);
    if (this.peek().kind === "l_paren" && this.peek(1).kind === "star") {
      this.next(); // (
      this.next(); // *
      const nameTok = this.expect("identifier", "typedef function pointer name");
      this.expect("r_paren", "typedef function pointer");

      // Skip parameter list
      if (this.peek().kind === "l_paren") {
        this.skipBalanced("l_paren", "r_paren");
      }

      this.expect("semicolon", "typedef");
      // Return a simplified typedef — the exact signature doesn't matter for our subset
      return {
        kind: "typedef_decl",
        name: nameTok?.text ?? "fn_ptr",
        type: { kind: "pointer", pointee: { kind: "void" } },
        span: this.makeSpan(start),
      };
    }

    const nameTok = this.expect("identifier", "typedef name");
    this.expect("semicolon", "typedef");
    return { kind: "typedef_decl", name: nameTok?.text ?? "", type, span: this.makeSpan(start) };
  }

  private parseUsing(): Declaration {
    this.next(); // using

    // using namespace QPI;
    if (this.tryConsumeKw("namespace")) {
      const nameTok = this.expect("identifier", "namespace name");
      this.expect("semicolon", "using namespace");
      return {
        kind: "typedef_decl",
        name: `using namespace ${nameTok?.text ?? ""}`,
        type: { kind: "void" },
        span: this.peek().span,
      };
    }

    // using Alias = Type;
    const name = this.parseQualifiedName();
    if (this.tryConsume("eq")) {
      const type = this.parseTypeSpec();
      this.expect("semicolon", "using alias");
      return {
        kind: "typedef_decl",
        name,
        type,
        span: this.peek().span,
      };
    }

    // using Base::member;
    this.expect("semicolon", "using decl");
    return {
      kind: "typedef_decl",
      name,
      type: { kind: "void" },
      span: this.peek().span,
    };
  }

  private parseStaticAssertDecl(): StaticAssertDecl {
    const start = this.next().span; // static_assert
    this.expect("l_paren", "static_assert");
    const condition = this.parseExpression();

    let message: Expression | undefined;
    if (this.tryConsume("comma")) {
      message = this.parsePrimaryExpression();
    }

    this.expect("r_paren", "static_assert");
    this.expect("semicolon", "static_assert");

    return { kind: "static_assert_decl", condition, message, span: this.makeSpan(start) };
  }

  private parseExternBlock(): ExternBlockDecl | FunctionDecl {
    const start = this.next().span; // extern

    // extern "C" { ... }
    if (this.peek().kind === "string_literal") {
      const linkage = this.next().text.replace(/"/g, "");

      if (this.tryConsume("l_brace")) {
        const body = this.parseDeclarationList();
        this.expect("r_brace", "extern block");
        return { kind: "extern_block", linkage, body, span: this.makeSpan(start) };
      }

      // extern "C" function declaration
      const func = this.parseFunctionAfterReturnType({ kind: "name", name: "void" }, true);
      return func;
    }

    // extern function
    const func = this.parseFunctionAfterReturnType({ kind: "name", name: "void" }, true);
    return func;
  }

  private parseFriend(): FriendDecl {
    const start = this.next().span; // friend
    const declaration = this.parseDeclaration();

    if (!declaration) {
      return {
        kind: "friend",
        declaration: {
          kind: "function",
          name: "",
          returnType: { kind: "void" },
          params: [],
          isConstexpr: false,
          isStatic: false,
          isInline: false,
          isExternC: false,
          isVirtual: false,
          isOverride: false,
          isDeleted: false,
          isDefault: false,
          span: start,
        },
        span: start,
      };
    }

    return {
      kind: "friend",
      declaration: declaration as FunctionDecl | StructDecl | ClassTemplateDecl,
      span: this.makeSpan(start),
    };
  }

  private parseAccessSpec(): EmptyDecl {
    this.next(); // public/protected/private
    this.expect("colon", "access specifier");
    return { kind: "empty" };
  }

  // ---- Functions and variables ----

  private parseFunctionOrVariable(): Declaration {
    let isConstexpr = false;
    let isStatic = false;
    let isInline = false;
    let isVirtual = false;
    let isExtern = false;

    // Consume modifiers
    while (!this.eof()) {
      if (this.tryConsumeKw("constexpr")) {
        isConstexpr = true;
      } else if (this.tryConsumeKw("static")) {
        isStatic = true;
      } else if (this.tryConsumeKw("inline")) {
        isInline = true;
      } else if (this.tryConsumeKw("virtual")) {
        isVirtual = true;
      } else if (this.tryConsumeKw("extern")) {
        isExtern = true;
      } else {
        break;
      }
    }

    return this.parseAfterModifiers(isConstexpr, isStatic, isInline, isVirtual, isExtern);
  }

  private parseFunctionOrVariablePeekType(): Declaration {
    return this.parseAfterModifiers(false, false, false, false, false);
  }

  private parseIdentifierDeclaration(): Declaration {
    // Identifier at top level — peek ahead
    const tok = this.peek();
    const nextTok = this.peek(1);

    // Identifier followed by "::" → qualified name (function/variable)
    if (nextTok.kind === "d_colon") {
      return this.parseAfterModifiers(false, false, false, false, false);
    }

    // Identifier followed by "(" → function definition
    if (nextTok.kind === "l_paren") {
      return this.parseAfterModifiers(false, false, false, false, false);
    }

    // Identifier followed by ";" → variable declaration Identifier followed by "=" → variable with init
    if (nextTok.kind === "semicolon" || nextTok.kind === "eq") {
      return this.parseAfterModifiers(false, false, false, false, false);
    }

    // Assume variable declaration
    return this.parseAfterModifiers(false, false, false, false, false);
  }

  private parseAfterModifiers(
    isConstexpr: boolean,
    isStatic: boolean,
    isInline: boolean,
    isVirtual: boolean,
    isExtern: boolean,
  ): Declaration {
    // Parse return type (or variable type)
    const type = this.parseTypeSpec();

    // Check for function call syntax: Type(...) or Type::name(
    const name = this.parseMaybeQualifiedName();

    if (!name) {
      // Constructor / destructor: `ClassName(...) {...}` or `~ClassName() {...}` — no return type. Parse
      if (this.peek().kind === "l_paren" && type.kind === "name") {
        return this.parseFunctionRest(
          type.name,
          { kind: "void" },
          isConstexpr,
          isStatic,
          isInline,
          isVirtual,
          isExtern,
        );
      }
      // Just a type with no name — semicolon
      this.expect("semicolon", "declaration");
      return { kind: "empty" };
    }

    // `name(...)` is either a function declaration or a variable with constructor-style direct-init (Type name(expr, ...);). In this subset
    if (this.peek().kind === "l_paren") {
      if (this.looksLikeDirectInit()) {
        return this.parseDirectInitVar(name, type, isConstexpr, isStatic);
      }
      return this.parseFunctionRest(
        name,
        type,
        isConstexpr,
        isStatic,
        isInline,
        isVirtual,
        isExtern,
      );
    }

    // Variable: name; or name = init;
    return this.parseVariableRest(name, type, isConstexpr, isStatic);
  }

  // After a `name`, peek past `(` to decide function-declaration vs constructor-style direct-init: a function parameter list opens with
  private looksLikeDirectInit(): boolean {
    const after = this.peek(1).kind;
    return (
      after === "kw_sizeof" ||
      after === "int_literal" ||
      after === "float_literal" ||
      after === "string_literal" ||
      after === "char_literal" ||
      after === "kw_true" ||
      after === "kw_false" ||
      after === "kw_nullptr" ||
      after === "minus" ||
      // A `{` after `(` is a braced-init constructor argument (`AssetPossessionIterator iter({NULL_ID, name})`) a parameter list can't open with
      after === "bang" ||
      after === "tilde" ||
      after === "l_brace"
    );
  }

  private parseDirectInitVar(
    name: string,
    type: TypeSpec,
    isConstexpr: boolean,
    isStatic: boolean,
  ): VariableDecl {
    const start = this.peek().span;
    this.expect("l_paren", "ctor args");
    const callArguments: Expression[] = [];
    if (this.peek().kind !== "r_paren") {
      callArguments.push(this.parseExpression());
      while (this.tryConsume("comma")) {
        callArguments.push(this.parseExpression());
      }
    }
    this.expect("r_paren", "ctor args close");
    this.expect("semicolon", "direct-init declaration");
    return {
      kind: "variable",
      name,
      type,
      initializer: { kind: "construct", type, callArguments, span: start },
      isConstexpr,
      isStatic,
      isExtern: false,
      isMember: false,
      access: "public",
      span: this.makeSpan(start),
    };
  }

  private parseFunctionAfterReturnType(retType: TypeSpec, isExternC: boolean): FunctionDecl {
    const name = this.parseMaybeQualifiedName() ?? "";
    const isConstexpr = false;
    return this.parseFunctionRest(name, retType, isConstexpr, false, false, false, isExternC);
  }

  private parseFunctionRest(
    name: string,
    retType: TypeSpec,
    isConstexpr: boolean,
    isStatic: boolean,
    isInline: boolean,
    isVirtual: boolean,
    isExternC: boolean,
  ): FunctionDecl {
    const start = this.peek(-1)?.span || this.peek().span;

    // Function parameters
    this.expect("l_paren", "function params");
    const params = this.parseFunctionParams();
    this.expect("r_paren", "function params close");

    // Optional const qualifier
    this.tryConsumeKw("const");

    // Optional override/final/noexcept
    const isOverride = !!this.tryConsumeKw("override");
    this.tryConsumeKw("final");
    this.tryConsumeKw("noexcept");

    let body: Statement | undefined;
    let isDeleted = false;
    let isDefault = false;

    if (this.tryConsume("eq")) {
      if (this.tryConsumeKw("delete")) {
        isDeleted = true;
      } else if (this.tryConsumeKw("default")) {
        isDefault = true;
      }
      this.expect("semicolon", "function = delete/default");
    } else if (this.peek().kind === "l_brace") {
      body = this.parseFunctionBody();
    } else {
      this.expect("semicolon", "function declaration");
    }

    return {
      kind: "function",
      name,
      returnType: retType,
      params,
      body,
      isConstexpr,
      isStatic,
      isInline,
      isExternC,
      isVirtual,
      isOverride,
      isDeleted,
      isDefault,
      span: this.makeSpan(start),
    };
  }

  private parseVariableRest(
    name: string,
    type: TypeSpec,
    isConstexpr: boolean,
    isStatic: boolean,
  ): Declaration {
    const vars = this.parseDeclaratorList(type, name, isConstexpr, isStatic);
    // First declarator is returned; the rest are queued for the enclosing member/decl loop.
    for (let varIndex = 1; varIndex < vars.length; varIndex++) this.pending.push(vars[varIndex]);
    return vars[0] ?? { kind: "empty" };
  }

  // Parse one or more declarators sharing a base type: `name[dim]...`, `name = init`, `, name2, ...`, terminated by
  private parseDeclaratorList(
    baseType: TypeSpec,
    firstName: string,
    isConstexpr: boolean,
    isStatic: boolean,
  ): VariableDecl[] {
    const out: VariableDecl[] = [];
    let name = firstName;

    while (true) {
      const start = this.peek().span;
      let type = baseType;

      // Array dimensions: name[E][E2]... — innermost dimension binds tightest, so collect then nest.
      const dims: Expression[] = [];
      while (this.peek().kind === "l_bracket") {
        this.next(); // [
        if (this.peek().kind === "r_bracket") {
          dims.push({ kind: "int_literal", value: "0", span: this.peek().span });
        } else {
          dims.push(this.parseExpression());
        }
        this.expect("r_bracket", "array dimension");
      }
      for (let index = dims.length - 1; index >= 0; index--) {
        type = { kind: "array", element: type, size: dims[index], span: start };
      }

      let initializer: Expression | undefined;
      if (this.tryConsume("eq")) {
        initializer = this.parseExpression();
      } else if (this.peek().kind === "l_brace") {
        // Direct-list initialization is executable semantics, not layout trivia. Preserve the
        const list = this.parseExpression();
        initializer =
          type.kind === "array" || list.kind !== "initializer_list"
            ? list
            : { kind: "construct", type, callArguments: list.expressions, span: list.span };
      }

      out.push({
        kind: "variable",
        name,
        type,
        initializer,
        isConstexpr,
        isStatic,
        isExtern: false,
        isMember: false,
        access: "public",
        span: this.makeSpan(start),
      });

      if (this.tryConsume("comma")) {
        // next declarator: optional * / & then a name
        while (this.peek().kind === "star" || this.peek().kind === "amp") this.next();
        const token = this.peek();
        if (token.kind === "identifier") {
          name = this.next().text;
          continue;
        }
      }
      break;
    }

    this.expect("semicolon", "variable");
    return out;
  }

  private parseFunctionParams(): ParamDecl[] {
    const params: ParamDecl[] = [];

    if (this.peek().kind === "r_paren") {
      return params;
    }

    if (this.peek().kind === "kw_void" && this.peek(1).kind === "r_paren") {
      this.next(); // void
      return params;
    }

    while (!this.eof() && this.peek().kind !== "r_paren") {
      let type = this.parseTypeSpec();
      let name = "";

      // Function-pointer parameter: `void (*callback)(Args...)` or the unnamed `void (*)(Args...)`
      // used by core's oracle wrappers. The pointee signature is not called by generated Wasm, but the
      // parameter remains an address in the parsed ABI and still counts for overload resolution.
      if (this.peek().kind === "l_paren" && this.peek(1).kind === "star") {
        this.next();
        this.next();
        if (this.peek().kind === "identifier") name = this.next().text;
        this.expect("r_paren", "function-pointer declarator");
        this.expect("l_paren", "function-pointer parameters");
        let depth = 1;
        while (!this.eof() && depth > 0) {
          const token = this.next();
          if (token.kind === "l_paren") depth++;
          else if (token.kind === "r_paren") depth--;
        }
        type = { kind: "pointer", pointee: type, span: type.span };
      }

      if (!name && this.peek().kind === "identifier") {
        name = this.next().text;
      }

      let defaultVal: Expression | undefined;
      if (this.tryConsume("eq")) {
        defaultVal = this.parseExpression();
      }

      params.push({ name, type, defaultValue: defaultVal, span: this.peek().span });

      if (!this.tryConsume("comma")) {
        break;
      }
    }

    return params;
  }

  // ---- Type parsing ----

  private parseTypeSpec(): TypeSpec {
    let type = this.parseBaseType();

    // Trailing modifiers: *, &, const
    while (!this.eof()) {
      if (this.tryConsume("star")) {
        type = { kind: "pointer", pointee: type, span: type.span };
      } else if (
        this.peek().kind === "amp" &&
        this.peek(1).kind !== "amp" &&
        this.peek(1).kind !== "eq"
      ) {
        // & (but not && or &=)
        this.next();
        type = { kind: "reference", referentType: type, span: type.span };
      } else if (this.tryConsumeKw("const")) {
        type = { kind: "const", valueType: type, span: type.span };
      } else {
        break;
      }
    }

    return type;
  }

  private parseBaseType(): TypeSpec {
    const tok = this.peek();

    // const prefix (e.g., "const Type&")
    if (tok.kind === "kw_const") {
      this.next(); // consume const
      const inner = this.parseBaseType();
      return { kind: "const", valueType: inner, span: tok.span };
    }

    // auto — type inferred from the initializer (in qpi.h bodies these are integer counters / pointers)
    if (tok.kind === "kw_auto") {
      this.next();
      return { kind: "name", name: "auto", span: tok.span };
    }

    // `typename` is a parse-time disambiguator (typename Sel<v>::type) — drop it and parse the type that follows; any trailing
    if (tok.kind === "kw_typename") {
      this.next();
      return this.parseBaseType();
    }

    // Built-in type keywords
    if (isTypeKeyword(tok.kind)) {
      return this.parseBuiltinType();
    }

    // struct / enum / class / union prefix
    if (
      tok.kind === "kw_struct" ||
      tok.kind === "kw_enum" ||
      tok.kind === "kw_class" ||
      tok.kind === "kw_union"
    ) {
      this.next();
      const name = this.next().text;
      return { kind: "name", name, span: tok.span };
    }

    // unsigned / signed prefixes
    if (tok.kind === "kw_unsigned" || tok.kind === "kw_signed" || tok.kind === "kw_long") {
      return this.parseBuiltinType();
    }

    // Name or qualified name. In a type position, `Sel<args>::member` is a dependent type — stop the
    const name = this.parseQualifiedName(true);
    if (!name) {
      this.diagnostics.push({
        severity: "error",
        message: `Expected type but got ${tok.kind}`,
        span: tok.span,
      });
      this.next();
      return { kind: "name", name: "int", span: tok.span };
    }

    // Check for template arguments: Name<...>
    if (this.peek().kind === "l_angle") {
      this.next(); // <
      const callArguments: TypeSpec[] = [];

      while (!this.eof() && this.peek().kind !== "r_angle") {
        const kind = this.peek().kind;
        // Non-type arg that is a value expression (literal, paren, sizeof, `-N`, `~N`) — parse at shift precedence so
        if (
          kind === "int_literal" ||
          kind === "l_paren" ||
          kind === "kw_sizeof" ||
          kind === "char_literal" ||
          kind === "minus" ||
          kind === "tilde" ||
          kind === "kw_true" ||
          kind === "kw_false" ||
          this.templateArgIsExpr()
        ) {
          callArguments.push({ kind: "expr_value", expression: this.parseShift(), span: this.peek().span });
        } else if (
          kind === "d_colon" ||
          kind === "identifier" ||
          isTypeKeyword(kind) ||
          kind === "kw_const" ||
          kind === "kw_struct" ||
          kind === "kw_unsigned" ||
          kind === "kw_signed"
        ) {
          callArguments.push(this.parseTypeSpec());
        } else {
          const name = this.parseMaybeQualifiedName() || this.next().text;
          callArguments.push({ kind: "name", name, span: this.peek().span });
        }
        if (!this.tryConsume("comma")) {
          break;
        }
      }

      this.consumeAngleClose();
      const inst: TypeSpec = { kind: "template_instance", name, callArguments, span: tok.span };
      // Dependent member type: `Selector<args>::type` — the nested type of a template instance.
      if (this.peek().kind === "d_colon" && this.peek(1).kind === "identifier") {
        this.next(); // ::
        const member = this.next().text;
        return { kind: "dependent_member", base: inst, member, span: tok.span };
      }
      return inst;
    }

    return { kind: "name", name, span: tok.span };
  }

  // A template argument that begins with a (qualified) identifier followed by an arithmetic operator and another operand is
  private templateArgIsExpr(): boolean {
    if (this.peek().kind !== "identifier") return false;
    let index = 1;
    while (this.peek(index).kind === "d_colon" && this.peek(index + 1).kind === "identifier") index += 2;
    const operator = this.peek(index).kind;
    if (
      operator !== "star" &&
      operator !== "plus" &&
      operator !== "slash" &&
      operator !== "percent" &&
      operator !== "l_shift" &&
      operator !== "r_shift"
    )
      return false;
    const after = this.peek(index + 1).kind;
    return after === "identifier" || after === "int_literal" || after === "l_paren";
  }

  private parseBuiltinType(): TypeSpec {
    // Handle signed/unsigned + char/short/int/long/long long
    const parts: string[] = [];

    while (!this.eof() && isTypeKeyword(this.peek().kind)) {
      parts.push(this.next().text);
    }

    const name = parts.join(" ");
    return { kind: "name", name, span: this.peek().span };
  }

  private parseAccessAndType(): TypeSpec {
    // public Type / protected Type / private Type
    this.tryConsumeKw("public");
    this.tryConsumeKw("protected");
    this.tryConsumeKw("private");
    this.tryConsumeKw("virtual"); // virtual inheritance — ignore in QPI subset
    return this.parseTypeSpec();
  }

  // ---- Expressions ----

  private parseExpression(): Expression {
    return this.parseAssignment();
  }

  private parseAssignment(): Expression {
    const left = this.parseTernary();

    const tok = this.peek();
    const assignOps: Record<string, AssignOp> = {
      eq: "=",
      plus_eq: "+=",
      minus_eq: "-=",
      star_eq: "*=",
      slash_eq: "/=",
      percent_eq: "%=",
      l_shift_eq: "<<=",
      r_shift_eq: ">>=",
      amp_eq: "&=",
      pipe_eq: "|=",
      caret_eq: "^=",
    };

    const operator = assignOps[tok.kind];
    if (operator) {
      this.next();
      const right = this.parseAssignment();
      return { kind: "assign", operator, left, right, span: left.span };
    }

    return left;
  }

  private parseTernary(): Expression {
    const condition = this.parseLogicalOr();

    if (this.tryConsume("question")) {
      const then = this.parseExpression();
      this.expect("colon", "ternary");
      const else_ = this.parseExpression();
      return { kind: "ternary", condition, then, else_, span: condition.span };
    }

    return condition;
  }

  private parseLogicalOr(): Expression {
    let left = this.parseLogicalAnd();

    while (this.tryConsume("pipe_pipe")) {
      const right = this.parseLogicalAnd();
      left = { kind: "binary_op", operator: "||", left, right, span: left.span };
    }

    return left;
  }

  private parseLogicalAnd(): Expression {
    let left = this.parseBitwiseOr();

    while (this.tryConsume("amp_amp")) {
      const right = this.parseBitwiseOr();
      left = { kind: "binary_op", operator: "&&", left, right, span: left.span };
    }

    return left;
  }

  private parseBitwiseOr(): Expression {
    let left = this.parseBitwiseXor();

    while (this.tryConsume("pipe")) {
      const right = this.parseBitwiseXor();
      left = { kind: "binary_op", operator: "|", left, right, span: left.span };
    }

    return left;
  }

  private parseBitwiseXor(): Expression {
    let left = this.parseBitwiseAnd();

    while (this.tryConsume("caret")) {
      const right = this.parseBitwiseAnd();
      left = { kind: "binary_op", operator: "^", left, right, span: left.span };
    }

    return left;
  }

  private parseBitwiseAnd(): Expression {
    let left = this.parseEquality();

    while (this.tryConsume("amp")) {
      const right = this.parseEquality();
      left = { kind: "binary_op", operator: "&", left, right, span: left.span };
    }

    return left;
  }

  private parseEquality(): Expression {
    let left = this.parseComparison();

    while (!this.eof()) {
      const tok = this.peek();
      if (tok.kind === "eq_eq") {
        this.next();
        left = {
          kind: "binary_op",
          operator: "==",
          left,
          right: this.parseComparison(),
          span: left.span,
        };
      } else if (tok.kind === "not_eq") {
        this.next();
        left = {
          kind: "binary_op",
          operator: "!=",
          left,
          right: this.parseComparison(),
          span: left.span,
        };
      } else {
        break;
      }
    }

    return left;
  }

  private parseComparison(): Expression {
    let left = this.parseShift();

    while (!this.eof()) {
      const tok = this.peek();
      // `<` / `>` lex as l_angle / r_angle (shared with template brackets). At this precedence level
      const ops: Record<string, BinaryOp> = {
        l_angle: "<",
        r_angle: ">",
        lt_eq: "<=",
        gt_eq: ">=",
      };
      // Inside a template arg/param list a top-level `>` / `>=` closes the list, not a comparison.
      if (this.gtDisabled > 0 && (tok.kind === "r_angle" || tok.kind === "gt_eq")) {
        break;
      }
      const operator = ops[tok.kind];
      if (operator) {
        this.next();
        left = { kind: "binary_op", operator, left, right: this.parseShift(), span: left.span };
      } else if (tok.kind === "spaceship") {
        // <=> — treat as comparison
        this.next();
        left = { kind: "binary_op", operator: "<", left, right: this.parseShift(), span: left.span };
      } else {
        break;
      }
    }

    return left;
  }

  private parseShift(): Expression {
    let left = this.parseAdditive();

    while (!this.eof()) {
      if (this.gtDisabled > 0 && this.peek().kind === "r_shift") {
        break; // `>>` closes two nested template lists here, not a shift operator
      }
      if (this.tryConsume("l_shift")) {
        left = { kind: "binary_op", operator: "<<", left, right: this.parseAdditive(), span: left.span };
      } else if (this.tryConsume("r_shift")) {
        left = { kind: "binary_op", operator: ">>", left, right: this.parseAdditive(), span: left.span };
      } else {
        break;
      }
    }

    return left;
  }

  private parseAdditive(): Expression {
    let left = this.parseMultiplicative();

    while (!this.eof()) {
      if (this.tryConsume("plus")) {
        left = {
          kind: "binary_op",
          operator: "+",
          left,
          right: this.parseMultiplicative(),
          span: left.span,
        };
      } else if (this.tryConsume("minus")) {
        left = {
          kind: "binary_op",
          operator: "-",
          left,
          right: this.parseMultiplicative(),
          span: left.span,
        };
      } else {
        break;
      }
    }

    return left;
  }

  private parseMultiplicative(): Expression {
    let left = this.parseUnary();

    while (!this.eof()) {
      if (this.tryConsume("star")) {
        left = { kind: "binary_op", operator: "*", left, right: this.parseUnary(), span: left.span };
      } else if (this.tryConsume("slash")) {
        left = { kind: "binary_op", operator: "/", left, right: this.parseUnary(), span: left.span };
      } else if (this.tryConsume("percent")) {
        left = { kind: "binary_op", operator: "%", left, right: this.parseUnary(), span: left.span };
      } else {
        break;
      }
    }

    return left;
  }

  private parseUnary(): Expression {
    const tok = this.peek();

    // new/delete expressions: contracts have no heap. Report once with the real reason, then
    if ((tok.kind === "identifier" && tok.text === "new") || tok.kind === "kw_delete") {
      this.diagnostics.push({
        severity: "error",
        message: `dynamic memory allocation ('${tok.text}') is not allowed in a contract`,
        span: tok.span,
      });
      while (!this.eof() && this.peek().kind !== "semicolon" && this.peek().kind !== "r_brace") {
        this.next();
      }
      return { kind: "int_literal", value: "0", span: tok.span };
    }

    // Prefix operators
    if (
      tok.kind === "bang" ||
      tok.kind === "tilde" ||
      tok.kind === "minus" ||
      tok.kind === "plus" ||
      tok.kind === "star" ||
      tok.kind === "amp"
    ) {
      const opMap: Record<string, UnaryOp> = {
        bang: "!",
        tilde: "~",
        minus: "-",
        plus: "+",
        star: "*",
        amp: "&",
      };
      const operator = opMap[tok.kind];
      if (operator) {
        this.next();
        const argument = this.parseUnary();
        return { kind: "unary_op", operator, argument, span: tok.span };
      }
    }

    // Prefix ++ / --
    if (tok.kind === "plus_plus" || tok.kind === "minus_minus") {
      const operator = tok.kind === "plus_plus" ? ("++" as const) : ("--" as const);
      this.next();
      const argument = this.parseUnary();
      return { kind: "prefix_op", operator, argument, span: tok.span };
    }

    // sizeof
    if (tok.kind === "kw_sizeof") {
      return this.parseSizeof();
    }

    // Cast: (type)expr
    if (tok.kind === "l_paren" && this.isTypeCast()) {
      return this.parseCast();
    }

    return this.parsePostfix();
  }

  private parsePostfix(): Expression {
    let expression = this.parsePrimaryExpression();

    while (!this.eof()) {
      const tok = this.peek();

      // Brace-init / aggregate construction: TypeName{ a, b, c } (e.g. Logger{ idx, code, 0 }). Only an
      if (
        tok.kind === "l_brace" &&
        (expression.kind === "identifier" || expression.kind === "qualified_name")
      ) {
        const name = expression.kind === "identifier" ? expression.name : `${expression.namespace}::${expression.name}`;
        this.next(); // {
        const callArguments: Expression[] = [];
        while (!this.eof() && this.peek().kind !== "r_brace") {
          callArguments.push(this.parseBraceArg());
          if (!this.tryConsume("comma")) break;
        }
        this.expect("r_brace", "brace init");
        expression = { kind: "construct", type: { kind: "name", name }, callArguments, span: expression.span };
        continue;
      }

      // .member or ->member
      if (tok.kind === "dot" || tok.kind === "arrow") {
        const arrow = tok.kind === "arrow";
        this.next();
        const memberTok = this.expect("identifier", "member access");
        if (memberTok) {
          expression = {
            kind: "member_access",
            object: expression,
            member: memberTok.text,
            arrow,
            span: expression.span,
          };
        }
        continue;
      }

      // [index] (internal/QPI framework use)
      if (tok.kind === "l_bracket") {
        this.next();
        const index = this.parseExpression();
        this.expect("r_bracket", "subscript");
        expression = { kind: "subscript", object: expression, index, span: expression.span };
        continue;
      }

      // Function call: expr(args)
      if (tok.kind === "l_paren") {
        this.next();
        const callArguments = this.parseArgList();
        this.expect("r_paren", "call args");
        expression = { kind: "call", callee: expression, callArguments, span: expression.span };
        continue;
      }

      // Template call: expr<T>(args) — only when the lookahead genuinely matches `< types > (`.
      if (tok.kind === "l_angle" && this.looksLikeTemplateArgs()) {
        this.next();
        const templateArguments: TypeSpec[] = [];
        while (!this.eof() && this.peek().kind !== "r_angle") {
          const argStart = this.peek().span;
          const kind = this.peek().kind;
          // Function-template arguments may be non-type values (`irootK64<2>` and
          // `irootNewtonStep<k>`), just like class-template arguments. Preserve the
          if (
            kind === "int_literal" ||
            kind === "l_paren" ||
            kind === "kw_sizeof" ||
            kind === "char_literal" ||
            kind === "minus" ||
            kind === "tilde" ||
            kind === "kw_true" ||
            kind === "kw_false" ||
            this.templateArgIsExpr()
          ) {
            templateArguments.push({ kind: "expr_value", expression: this.parseShift(), span: argStart });
          } else {
            templateArguments.push(this.parseTypeSpec());
          }
          if (!this.tryConsume("comma")) break;
        }
        this.consumeAngleClose();

        this.expect("l_paren", "template call args");
        const callArguments = this.parseArgList();
        this.expect("r_paren", "template call args close");

        expression = { kind: "template_call", callee: expression, templateArguments, callArguments, span: expression.span };
        continue;
      }

      // Postfix ++ / --
      if (tok.kind === "plus_plus" || tok.kind === "minus_minus") {
        const operator = tok.kind === "plus_plus" ? ("++" as const) : ("--" as const);
        this.next();
        expression = { kind: "postfix_op", operator, argument: expression, span: expression.span };
        continue;
      }

      break;
    }

    return expression;
  }

  // Disambiguate `<` as template-args vs comparison: scan from the `<` for a matching `>` that is immediately followed
  private looksLikeTemplateArgs(): boolean {
    const save = (this.lex as any).index;
    this.next(); // consume `<`
    let depth = 1;
    let ok = true;
    let guard = 0;
    while (!this.eof() && depth > 0 && guard++ < 200) {
      const kind = this.peek().kind;
      if (kind === "l_angle") {
        depth++;
        this.next();
        continue;
      }
      if (kind === "r_angle") {
        depth--;
        this.next();
        continue;
      }
      if (kind === "r_shift") {
        depth -= 2;
        this.next();
        continue;
      }
      // Tokens that can't appear inside a template-argument list → it's a comparison.
      if (
        kind === "semicolon" ||
        kind === "l_brace" ||
        kind === "r_brace" ||
        kind === "eq" ||
        kind === "plus" ||
        kind === "minus" ||
        kind === "slash" ||
        kind === "percent" ||
        kind === "question" ||
        kind === "amp_amp" ||
        kind === "pipe_pipe" ||
        kind === "eq_eq" ||
        kind === "not_eq" ||
        kind === "l_paren" ||
        kind === "r_paren"
      ) {
        ok = false;
        break;
      }
      this.next();
    }
    const followedByParen = ok && depth <= 0 && this.peek().kind === "l_paren";
    (this.lex as any).index = save;
    return followedByParen;
  }

  // A single brace-init element: a nested `{ ... }` becomes an initializer_list, otherwise an expression.
  private parseBraceArg(): Expression {
    if (this.peek().kind === "l_brace") {
      const start = this.next().span; // {
      const expressions: Expression[] = [];
      while (!this.eof() && this.peek().kind !== "r_brace") {
        expressions.push(this.parseBraceArg());
        if (!this.tryConsume("comma")) break;
      }
      this.expect("r_brace", "initializer list");
      return { kind: "initializer_list", expressions, span: start };
    }
    return this.parseExpression();
  }

  private parsePrimaryExpression(): Expression {
    const tok = this.peek();

    // Literals
    if (tok.kind === "int_literal") {
      this.next();
      // Split the u/l suffix off the digits — literal typing (width/signedness) reads it.
      const member = tok.text.match(/^(.+?)([uUlL]+)$/);
      if (member) {
        return { kind: "int_literal", value: member[1], suffix: member[2], span: tok.span };
      }
      return { kind: "int_literal", value: tok.text, span: tok.span };
    }

    if (tok.kind === "float_literal") {
      this.next();
      return { kind: "float_literal", value: tok.text, span: tok.span };
    }

    if (tok.kind === "string_literal") {
      this.next();
      // Adjacent string literals concatenate (C++ rule): static_assert(c, #fn "_locals too large").
      let value = tok.text.replace(/"/g, "");
      while (this.peek().kind === "string_literal") {
        value += this.next().text.replace(/"/g, "");
      }
      return { kind: "string_literal", value, span: tok.span };
    }

    if (tok.kind === "char_literal") {
      this.next();
      return { kind: "char_literal", value: this.parseCharValue(tok.text), span: tok.span };
    }

    if (tok.kind === "kw_true") {
      this.next();
      return { kind: "bool_literal", value: true, span: tok.span };
    }

    if (tok.kind === "kw_false") {
      this.next();
      return { kind: "bool_literal", value: false, span: tok.span };
    }

    if (tok.kind === "kw_nullptr") {
      this.next();
      return { kind: "nullptr_literal", span: tok.span };
    }

    // this
    if (tok.kind === "kw_this") {
      this.next();
      return { kind: "this", span: tok.span };
    }

    // Parenthesized expression
    if (tok.kind === "l_paren") {
      this.next();
      const savedGt = this.gtDisabled;
      this.gtDisabled = 0; // a `>` inside parens is a comparison again, even within a template list
      const expression = this.parseExpression();
      this.gtDisabled = savedGt;
      this.expect("r_paren", "paren expr");
      return { kind: "paren", expression, span: tok.span };
    }

    // Brace initializer: {a, b, c}
    if (tok.kind === "l_brace") {
      this.next();
      const savedGt = this.gtDisabled;
      this.gtDisabled = 0;
      const expressions: Expression[] = [];
      while (!this.eof() && this.peek().kind !== "r_brace") {
        expressions.push(this.parseExpression());
        if (!this.tryConsume("comma")) break;
      }
      this.gtDisabled = savedGt;
      this.expect("r_brace", "initializer list");
      return { kind: "initializer_list", expressions, span: tok.span };
    }

    // Identifier or qualified name
    const name = this.parseQualifiedName();
    if (name) {
      return { kind: "identifier", name, span: tok.span };
    }

    // Error recovery
    this.diagnostics.push({
      severity: "error",
      message: `Expected expression but got ${tok.kind} (${tok.text})`,
      span: tok.span,
    });
    this.next();
    return { kind: "int_literal", value: "0", span: tok.span };
  }

  private parseQualifiedName(stopAtAngle = false): string {
    const parts: string[] = [];

    while (!this.eof()) {
      const tok = this.peek();
      if (stopAtAngle && tok.kind === "identifier" && this.peek(1).kind === "l_angle") {
        // Type position: `Sel<args>::type` is a dependent type — stop here and let the caller capture the template instance
        parts.push(this.next().text);
        break;
      }
      if (tok.kind === "kw_operator") {
        // operator overload name: consume `operator` + the operator symbol token(s).
        this.next();
        const opTok = this.peek();
        if (opTok.kind === "l_paren" && this.peek(1).kind === "r_paren") {
          this.next();
          this.next();
          parts.push("operator()");
        } else if (opTok.kind === "l_bracket" && this.peek(1).kind === "r_bracket") {
          this.next();
          this.next();
          parts.push("operator[]");
        } else if (
          opTok.kind === "identifier" ||
          isTypeKeyword(opTok.kind) ||
          opTok.kind === "kw_bool"
        ) {
          // conversion operator: operator bool() / operator T()
          parts.push("operator " + this.next().text);
        } else {
          parts.push("operator" + this.next().text);
        }
      } else if (tok.kind === "identifier") {
        parts.push(this.next().text);
        // ClassTemplate<args>::method — out-of-class definition. Drop the qualifier's template args
        if (this.peek().kind === "l_angle") {
          const save = (this.lex as any).index;
          if (this.skipAngleArgs() && this.peek().kind === "d_colon") {
            // committed — fall through to the d_colon handler below
          } else {
            (this.lex as any).index = save;
          }
        }
      } else if (tok.kind === "tilde" && this.peek(1).kind === "identifier") {
        // ~ClassName (destructor name)
        this.next();
        parts.push("~" + this.next().text);
      } else {
        break;
      }

      if (this.peek().kind === "d_colon") {
        this.next(); // ::
        parts.push("::");
        continue;
      }

      break;
    }

    if (parts.length === 0) return "";
    return parts.join("");
  }

  private parseMaybeQualifiedName(): string {
    return this.parseQualifiedName();
  }

  // Parse a comma-operator sequence (`i++, flags >>= 2`) into one expression. Used where a comma joins
  private parseCommaSequence(): Expression {
    const first = this.parseExpression();
    if (this.peek().kind !== "comma") return first;
    const expressions = [first];
    while (this.peek().kind === "comma") {
      this.next();
      expressions.push(this.parseExpression());
    }
    return { kind: "sequence", expressions, span: first.span };
  }

  // A local variable declaration at statement start is `Type var`/`Type* var`, not a keyword usage.
  private looksLikeLocalDecl(): boolean {
    const t0 = this.peek().kind;
    if (t0 === "kw_const" || t0 === "kw_auto") return true;
    if (t0 !== "identifier") return false;
    // Skip a qualified type name: identifier (:: identifier)* — e.g. QPI::uint64 name.
    let index = 1;
    while (this.peek(index).kind === "d_colon" && this.peek(index + 1).kind === "identifier") index += 2;
    // Skip template arguments `<...>` so `ProposalWithAllVoteData<D, N>& p` is recognized as a decl, not read as a `<`
    if (this.peek(index).kind === "l_angle") {
      let depth = 0;
      let templateEndIndex = index;
      for (; !this.eof(); templateEndIndex++) {
        const kind = this.peek(templateEndIndex).kind;
        if (kind === "l_angle") depth++;
        else if (kind === "r_angle") {
          if (--depth === 0) {
            templateEndIndex++;
            break;
          }
        } else if (kind === "r_shift") {
          depth -= 2;
          if (depth <= 0) {
            templateEndIndex++;
            break;
          }
        } else if (kind === "semicolon" || kind === "l_brace" || kind === "r_brace" || kind === "r_paren")
          return false;
      }
      if (depth > 0) return false;
      index = templateEndIndex;
    }
    const t1 = this.peek(index).kind;
    if (t1 === "identifier") return true;
    if ((t1 === "star" || t1 === "amp") && this.peek(index + 1).kind === "identifier") return true;
    return false;
  }

  // Consume a balanced <...> template-argument group (handling nested <> and >>). Returns true if it
  private skipAngleArgs(): boolean {
    if (this.peek().kind !== "l_angle") return false;
    this.next(); // <
    let depth = 1,
      guard = 0;
    while (!this.eof() && depth > 0 && guard++ < 500) {
      const kind = this.peek().kind;
      if (kind === "l_angle") {
        depth++;
        this.next();
        continue;
      }
      if (kind === "r_angle") {
        depth--;
        this.next();
        continue;
      }
      if (kind === "r_shift") {
        depth -= 2;
        this.next();
        continue;
      }
      if (kind === "semicolon" || kind === "l_brace") return false;
      this.next();
    }
    return depth <= 0;
  }

  // Decide whether `( ... )` begins a C-style cast vs a parenthesized expression. Only a *pure type*
  private isTypeCast(): boolean {
    const save = (this.lex as any).index;
    this.next(); // (

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

    while (!this.eof()) {
      const token = this.peek();
      // In this subset, C-style casts have no parenthesized nested expressions.
      if (token.kind === "l_paren") {
        depth++;
        sawNestedParen = true;
        this.next();
        continue;
      }
      if (token.kind === "r_paren") {
        if (depth === 0) {
          this.next();
          break;
        }
        depth--;
        this.next();
        continue;
      }
      saw = true;
      const ok =
        isTypeKeyword(token.kind) ||
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
      if (token.kind === "l_angle" && depth === 0) sawAngle = true;
      if ((token.kind === "r_angle" || token.kind === "r_shift") && angleDepth === 0) pureType = false;
      if (token.kind === "l_angle") angleDepth++;
      if (token.kind === "r_angle") angleDepth = Math.max(0, angleDepth - 1);
      if (token.kind === "r_shift") angleDepth = Math.max(0, angleDepth - 2);
      // In type-id context, `*`/`&` act as declarator suffixes inside template-free area.
      if ((token.kind === "star" || token.kind === "amp") && angleDepth === 0) sawPtrRef = true;
      if (
        sawPtrRef &&
        angleDepth === 0 &&
        (token.kind === "identifier" || token.kind === "d_colon" || isTypeKeyword(token.kind))
      ) {
        pureType = false;
      }
      if (isTypeKeyword(token.kind) || token.kind === "identifier") sawTypeToken = true;
      if (!ok) {
        pureType = false;
      }
      tokenCount++;
      loneIdent = tokenCount === 1 && token.kind === "identifier" ? token.text : null;
      this.next();
    }

    // After the `)`, a cast must be followed by an operand (so `(id) + 5` is NOT a cast).
    const after = this.peek();
    const operandFollows =
      after.kind === "identifier" ||
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

    (this.lex as any).index = save;

    // `(name) & x` / `(name) * x` / `(name) + x` / `(name) - x`: C++ resolves this
    if (
      loneIdent &&
      !SCALAR_CAST_NAMES.has(loneIdent) &&
      (after.kind === "amp" ||
        after.kind === "star" ||
        after.kind === "plus" ||
        after.kind === "minus")
    ) {
      return false;
    }

    // A bare identifier in parens (`(L * 2 ...)` has operators → not pure) is a cast only
    return saw && pureType && sawTypeToken && operandFollows && !sawNestedParen && !sawAngle;
  }

  private parseCast(): Expression {
    this.next(); // (
    const type = this.parseTypeSpec();
    this.expect("r_paren", "cast");
    const expression = this.parseUnary();
    return { kind: "c_cast", type, expression, span: expression.span };
  }

  private parseSizeof(): Expression {
    const start = this.next().span; // sizeof

    if (this.tryConsume("l_paren")) {
      // sizeof(T) or sizeof(expr) Check if it's a type
      const tok = this.peek();
      if (
        isTypeKeyword(tok.kind) ||
        tok.kind === "kw_unsigned" ||
        tok.kind === "kw_signed" ||
        tok.kind === "kw_struct" ||
        tok.kind === "kw_enum" ||
        tok.kind === "kw_const" ||
        tok.kind === "kw_typename"
      ) {
        const type = this.parseTypeSpec();
        this.expect("r_paren", "sizeof type");
        return { kind: "sizeof_type", type, span: this.makeSpan(start) };
      }

      const expression = this.parseExpression();
      this.expect("r_paren", "sizeof expr");
      return { kind: "sizeof_expr", expression, span: this.makeSpan(start) };
    }

    // sizeof expr (without parens)
    const expression = this.parseUnary();
    return { kind: "sizeof_expr", expression, span: this.makeSpan(start) };
  }

  private parseArgList(): Expression[] {
    const callArguments: Expression[] = [];

    if (this.peek().kind === "r_paren") {
      return callArguments;
    }

    while (!this.eof()) {
      callArguments.push(this.parseExpression());
      if (!this.tryConsume("comma")) {
        break;
      }
    }

    return callArguments;
  }

  // ---- Statements ----

  private parseStatement(): Statement {
    const tok = this.peek();

    // Compound
    if (tok.kind === "l_brace") {
      this.next();
      return this.parseCompoundStatement();
    }

    // Control flow
    if (tok.kind === "kw_if") {
      return this.parseIf();
    }
    if (tok.kind === "kw_for") {
      return this.parseFor();
    }
    if (tok.kind === "kw_while") {
      return this.parseWhile();
    }
    if (tok.kind === "kw_do") {
      return this.parseDoWhile();
    }
    if (tok.kind === "kw_switch") {
      return this.parseSwitch();
    }
    if (tok.kind === "kw_case") {
      return this.parseCase();
    }
    if (tok.kind === "kw_default") {
      return this.parseDefault();
    }
    if (tok.kind === "kw_break") {
      this.next();
      this.expect("semicolon", "break");
      return { kind: "break", span: tok.span };
    }
    if (tok.kind === "kw_continue") {
      this.next();
      this.expect("semicolon", "continue");
      return { kind: "continue", span: tok.span };
    }
    if (tok.kind === "kw_return") {
      return this.parseReturn();
    }
    if (tok.kind === "kw_goto") {
      this.next();
      const labelTok = this.expect("identifier", "goto label");
      this.expect("semicolon", "goto");
      return { kind: "goto", label: labelTok?.text ?? "", span: tok.span };
    }

    // Label: identifier :
    if (tok.kind === "identifier" && this.peek(1).kind === "colon") {
      this.next();
      this.next(); // :
      return { kind: "label", name: tok.text, span: tok.span };
    }

    // static_assert
    if (tok.kind === "kw_static_assert") {
      const sa = this.parseStaticAssertDecl();
      return { kind: "static_assert", condition: sa.condition, message: sa.message, span: sa.span };
    }

    // Declaration (type keyword or modifier)
    if (
      isTypeKeyword(tok.kind) ||
      tok.kind === "kw_constexpr" ||
      tok.kind === "kw_static" ||
      tok.kind === "kw_inline" ||
      tok.kind === "kw_typedef" ||
      tok.kind === "kw_using" ||
      tok.kind === "kw_enum" ||
      tok.kind === "kw_struct" ||
      tok.kind === "kw_class" ||
      tok.kind === "kw_union" ||
      tok.kind === "kw_namespace" ||
      tok.kind === "kw_template" ||
      tok.kind === "kw_extern" ||
      tok.kind === "kw_unsigned" ||
      tok.kind === "kw_signed" ||
      tok.kind === "kw_long" ||
      this.looksLikeLocalDecl()
    ) {
      const declaration = this.parseDeclaration();
      if (declaration) {
        // Multi-declarator statement (`sint64 a = 0, b = 0;`): parseVariableRest queues the extra declarators on `pending`, which only
        if (this.pending.length) {
          const statements: Statement[] = [{ kind: "declaration", declaration, span: this.peek().span }];
          while (this.pending.length) {
            const declaration = this.pending.shift()!;
            statements.push({ kind: "declaration", declaration: declaration, span: (declaration as any).span ?? this.peek().span });
          }
          return {
            kind: "compound",
            body: statements,
            span: this.peek().span,
            synthetic: true,
          } as Statement;
        }
        return { kind: "declaration", declaration, span: this.peek().span };
      }
    }

    // Expression statement
    if (tok.kind === "semicolon") {
      this.next();
      return { kind: "empty", span: tok.span };
    }

    const expression = this.parseExpression();

    // Label after expression: expr : (unlikely but possible for case-like constructs)
    if (this.peek().kind === "colon" && expression.kind === "identifier") {
      this.next(); // :
      return { kind: "label", name: (expression as any).name, span: expression.span };
    }

    this.expect("semicolon", "expression statement");
    return { kind: "expression", expression, span: expression.span };
  }

  private parseCompoundStatement(): Statement {
    const start = this.peek(-1)?.span || this.peek().span;
    const body: Statement[] = [];

    while (!this.eof() && this.peek().kind !== "r_brace") {
      const statement = this.parseStatement();
      if (statement) {
        body.push(statement);
      }
    }

    this.expect("r_brace", "compound close");

    return { kind: "compound", body, span: this.makeSpan(start) };
  }

  private parseIf(): Statement {
    const start = this.next().span; // if
    this.expect("l_paren", "if cond");
    const condition = this.parseExpression();
    this.expect("r_paren", "if cond close");

    const thenStmt = this.parseStatement();
    let elseStmt: Statement | undefined;

    if (this.tryConsumeKw("else")) {
      elseStmt = this.parseStatement();
    }

    return { kind: "if", condition, then: thenStmt, else_: elseStmt, span: this.makeSpan(start) };
  }

  private parseFor(): Statement {
    const start = this.next().span; // for
    this.expect("l_paren", "for");

    let initializer: Statement | undefined;
    let condition: Expression | undefined;
    let update: Expression | undefined;

    // for (;;)
    if (this.peek().kind !== "semicolon") {
      // Could be a declaration (`for (sint64 i = 0; ...)`) or an expression init.
      if (isTypeKeyword(this.peek().kind) || this.looksLikeLocalDecl()) {
        const declaration = this.parseDeclaration();
        if (declaration) {
          initializer = { kind: "declaration", declaration, span: declaration.span ?? this.peek().span };
        }
      } else {
        // the init clause may be a comma sequence of assignments: for (a = x, b = 0; ...).
        const expression = this.parseCommaSequence();
        initializer = { kind: "expression", expression, span: expression.span };
      }
    }
    // parseDeclaration may or may not consume the trailing ';'; consume it here if still present.
    if (this.peek().kind === "semicolon") this.next();

    if (this.peek().kind !== "semicolon") {
      condition = this.parseExpression();
    }
    this.expect("semicolon", "for cond");

    if (this.peek().kind !== "r_paren") {
      update = this.parseCommaSequence();
    }
    this.expect("r_paren", "for close");

    const body = this.parseStatement();

    return { kind: "for", initializer, condition, update, body, span: this.makeSpan(start) };
  }

  private parseWhile(): Statement {
    const start = this.next().span; // while
    this.expect("l_paren", "while cond");
    const condition = this.parseExpression();
    this.expect("r_paren", "while cond close");
    const body = this.parseStatement();
    return { kind: "while", condition, body, span: this.makeSpan(start) };
  }

  private parseDoWhile(): Statement {
    const start = this.next().span; // do
    const body = this.parseStatement();
    this.expect("kw_while", "do-while while");
    this.expect("l_paren", "do-while cond");
    const condition = this.parseExpression();
    this.expect("r_paren", "do-while cond close");
    this.expect("semicolon", "do-while");
    return { kind: "do_while", body, condition, span: this.makeSpan(start) };
  }

  private parseSwitch(): Statement {
    const start = this.next().span; // switch
    this.expect("l_paren", "switch cond");
    const condition = this.parseExpression();
    this.expect("r_paren", "switch cond close");
    const body = this.parseStatement();
    return { kind: "switch", condition, body, span: this.makeSpan(start) };
  }

  private parseCase(): Statement {
    const start = this.next().span; // case
    const value = this.parseExpression();
    this.expect("colon", "case");
    return { kind: "case", value, span: this.makeSpan(start) };
  }

  private parseDefault(): Statement {
    const start = this.next().span; // default
    this.expect("colon", "default");
    return { kind: "default", span: this.makeSpan(start) };
  }

  private parseReturn(): Statement {
    const start = this.next().span; // return

    let value: Expression | undefined;
    if (this.peek().kind !== "semicolon") {
      value = this.parseExpression();
    }

    this.expect("semicolon", "return");
    return { kind: "return", value, span: this.makeSpan(start) };
  }

  // ---- Preprocessor line (leftover #-directive in preprocessed source) ----

  private parsePreprocessorLine(): Declaration {
    // Skip # line directive remnants
    this.next();
    while (!this.eof() && this.peek().kind !== "eof" && this.peek().text !== "\n") {
      this.next();
    }
    return { kind: "empty" };
  }

  // ---- Helpers ----

  // Assumes the current token is the opening delimiter; consumes through the matching close (inclusive). Safe no-op if the
  private skipBalanced(open: TokenKind, close: TokenKind): void {
    if (this.peek().kind !== open) return;
    this.next(); // consume the opener
    let depth = 1;
    while (!this.eof() && depth > 0) {
      const kind = this.peek().kind;
      if (kind === open) depth++;
      else if (kind === close) depth--;
      this.next();
    }
  }

  private parseDeclarationList(): Declaration[] {
    const declarations: Declaration[] = [];

    while (!this.eof() && this.peek().kind !== "r_brace") {
      const before = (this.lex as any).index;
      const errsBefore = this.diagnostics.length;
      const declaration = this.parseDeclaration();
      if (declaration && declaration.kind !== "empty") declarations.push(declaration);
      while (this.pending.length) declarations.push(this.pending.shift()!);
      this.recover(before, errsBefore);
    }

    return declarations;
  }

  private parseClassMembers(): Declaration[] {
    const members: Declaration[] = [];

    while (!this.eof() && this.peek().kind !== "r_brace") {
      const tok = this.peek();
      if (tok.kind === "kw_public" || tok.kind === "kw_protected" || tok.kind === "kw_private") {
        this.next();
        this.expect("colon", "access spec");
        continue;
      }

      if (tok.kind === "kw_friend") {
        const field = this.parseFriend();
        members.push(field);
        continue;
      }

      const before = (this.lex as any).index;
      const errsBefore = this.diagnostics.length;
      const declaration = this.parseDeclaration();
      if (declaration && declaration.kind !== "empty") members.push(declaration);
      while (this.pending.length) members.push(this.pending.shift()!);
      this.recover(before, errsBefore);
    }

    return members;
  }

  // Panic recovery for declaration failures.
  private recover(beforeIndex: number, errsBefore: number): void {
    const idx = (this.lex as any).index;
    const noProgress = idx === beforeIndex;
    const newError = this.diagnostics.length > errsBefore;
    if (!noProgress && !newError) return;

    // A declaration that consumed its full balanced body ends on `}` or `;`. Its inner errors are already
    if (!noProgress && (this._last?.kind === "r_brace" || this._last?.kind === "semicolon")) {
      return;
    }

    if (noProgress) {
      this.next(); // force progress
    }

    let depth = 0;
    while (!this.eof()) {
      const kind = this.peek().kind;
      if (kind === "l_brace") {
        depth++;
        this.next();
        continue;
      }
      if (kind === "r_brace") {
        if (depth === 0) return; // class body's own close — let the caller handle it
        depth--;
        this.next();
        if (depth === 0) return; // finished a member's brace body (e.g. a constructor) — member boundary
        continue;
      }
      if (kind === "semicolon" && depth === 0) {
        this.next();
        return;
      }
      this.next();
    }
  }

  private parseCharValue(text: string): number {
    // Parse C++ character literal value
    const inner = text.replace(/^'|'$/g, "");
    if (inner.startsWith("\\")) {
      switch (inner[1]) {
        case "n":
          return 10;
        case "t":
          return 9;
        case "r":
          return 13;
        case "0":
          return 0;
        case "\\":
          return 92;
        case "'":
          return 39;
        default:
          return inner.charCodeAt(1);
      }
    }
    return inner.charCodeAt(0);
  }

  private _last: Token | null = null;

  private makeSpan(start: Span): Span {
    const last = this._last?.span ?? this.peek().span;
    return { start: start.start, end: last.end, line: start.line, column: start.column };
  }

  // --- IDL extraction ---- Extract contract IDL from parsed AST (input/output types per registered entry)
  extractIdl(
    translationUnit: TranslationUnit,
  ): Record<string, { inputType: number; kind: number; inSize: number; outSize: number }> {
    const idl: Record<
      string,
      { inputType: number; kind: number; inSize: number; outSize: number }
    > = {};
    // This is driven by the REGISTER_USER_FUNCTION/PROCEDURE calls in __registerUserFunctionsAndProcedures.
    for (const declaration of translationUnit.declarations) {
      this.extractIdlFromNode(declaration, idl);
    }
    return idl;
  }

  private extractIdlFromNode(node: Declaration, idl: Record<string, any>): void {
    if (node.kind === "function") {
      const func = node as FunctionDecl;
      if (func.body) {
        this.extractIdlFromStmt(func.body, idl);
      }
    } else if (node.kind === "struct" || node.kind === "class_template") {
      const struct = node as StructDecl | ClassTemplateDecl;
      for (const member of struct.members) {
        this.extractIdlFromNode(member, idl);
      }
    } else if (node.kind === "namespace") {
      for (const bodyItem of (node as NamespaceDecl).body) {
        this.extractIdlFromNode(bodyItem, idl);
      }
    }
  }

  private extractIdlFromStmt(statement: Statement, idl: Record<string, any>): void {
    if (statement.kind === "compound") {
      for (const bodyItem of (statement as any).body) {
        this.extractIdlFromStmt(bodyItem, idl);
      }
    } else if (statement.kind === "expression") {
      const expression = statement as any;
      // Look for: qpi.__registerUserFunction(fn, inputType, sizeof(input), sizeof(output), sizeof(locals))
      if (expression.expression?.kind === "call") {
        this.checkRegistrationCall(expression.expression, idl);
      }
    }
  }

  private checkRegistrationCall(call: any, idl: Record<string, any>): void {
    if (
      call.callee?.kind === "member_access" &&
      (call.callee.member === "__registerUserFunction" ||
        call.callee.member === "__registerUserProcedure")
    ) {
      const kind = call.callee.member === "__registerUserFunction" ? 0 : 1;
      // sizeof(Foo_input) parses as sizeof_type when Foo_input is a known type keyword, but as sizeof_expr when it is a
      const isSizeof = (argument: any) => argument?.kind === "sizeof_type" || argument?.kind === "sizeof_expr";
      if (
        call.callArguments.length >= 5 &&
        call.callArguments[1]?.kind === "int_literal" &&
        isSizeof(call.callArguments[2]) &&
        isSizeof(call.callArguments[3])
      ) {
        const inputType = parseInt(call.callArguments[1].value);
        const fnName =
          call.callArguments[0]?.kind === "identifier"
            ? call.callArguments[0].name
            : call.callArguments[0]?.kind === "c_cast"
              ? call.callArguments[0].expression?.name
              : "";
        // inSize/outSize from sizeof — need sema to evaluate
        if (fnName && inputType >= 1 && inputType <= 65535) {
          idl[fnName] = { inputType, kind, inSize: 0, outSize: 0 };
        }
      }
    }
  }
}
