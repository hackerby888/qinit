// Recursive-descent parser for the QPI C++ subset.
// Consumes tokens from Lexer, emits AST nodes. Handles both user contract code
// and qpi.h template bodies via the unified AST.

import type { Token, TokenKind } from "./lexer";
import { Lexer, isTypeKeyword } from "./lexer";
import type {
  Span, TypeSpec, Expression, Statement, Declaration,
  StructDecl, ClassTemplateDecl, FunctionTemplateDecl, FunctionDecl,
  VariableDecl, EnumDecl, EnumeratorDecl,
  TypedefDeclNode, NamespaceDecl, StaticAssertDecl,
  ExternBlockDecl, FriendDecl, EmptyDecl,
  TemplateParam, ParamDecl, AccessSpec,
  TranslationUnit, UnaryOp, BinaryOp, AssignOp,
} from "./ast";

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  span: Span;
}

export class Parser {
  private lex: Lexer;
  private diagnostics: Diagnostic[] = [];
  // Diagnostics raised while parsing a function body in isolation. They stay visible (getDiagnostics
  // merges them) but are deliberately kept out of the structural `diagnostics` list so they never make
  // the panic-recovery in a class/namespace member loop skip a sibling declaration.
  private bodyDiagnostics: Diagnostic[] = [];
  // While > 0 (inside a template parameter/argument list), a top-level `>` / `>>` closes the list
  // rather than acting as a comparison/shift operator — C++'s GreaterThanIsOperator=false. Reset to 0
  // inside nested parens/braces so a parenthesized guard like `(a > b)` still parses.
  private gtDisabled = 0;
  // Extra declarations produced by a single parse step (e.g. `struct {...} a, b[4];` yields the
  // struct plus per-declarator variables). Drained by the member/decl-list loops.
  private pending: Declaration[] = [];

  constructor(tokens: Token[]) {
    this.lex = new Lexer("");
    // Inject pre-tokenized stream
    (this.lex as any).tokens = tokens;
    (this.lex as any).index = 0;
    // Ensure there's an eof token
    if (tokens.length === 0 || tokens[tokens.length - 1].kind !== "eof") {
      tokens.push({ kind: "eof", text: "", span: { start: 0, end: 0, line: 0, col: 0 } });
    }
  }

  parseTranslationUnit(): TranslationUnit {
    const start = this.peek().span;
    const decls: Declaration[] = [];

    while (!this.eof()) {
      const before = (this.lex as any).index;
      const errsBefore = this.diagnostics.length;
      const decl = this.parseDeclaration();
      if (decl && decl.kind !== "empty") decls.push(decl);
      while (this.pending.length) decls.push(this.pending.shift()!);
      this.recover(before, errsBefore);
    }

    const end = this.last().span;
    return {
      declarations: decls,
      span: { start: start.start, end: end.end, line: start.line, col: start.col },
    };
  }

  getDiagnostics(): Diagnostic[] {
    return [...this.diagnostics, ...this.bodyDiagnostics];
  }

  // Parse a `{ ... }` function body in isolation. qpi.h's method bodies routinely exceed our expression
  // subset (comma operator, braced-init arguments, local types); parsing them inline lets a failure run
  // the cursor past the body's closing brace and collapse the enclosing struct/namespace. Instead, slice
  // the body at balanced-brace depth, parse the slice in a sub-parser (which physically cannot read past
  // the body), then resume the outer cursor right after the matching `}`. The cursor is positioned at the
  // opening `{` on entry. Body diagnostics are recorded as informational so they don't trip recovery.
  private parseFunctionBody(): Statement {
    const toks = (this.lex as any).tokens as Token[];
    const openIdx = (this.lex as any).index;

    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < toks.length; i++) {
      const k = toks[i].kind;
      if (k === "l_brace") {
        depth++;
      } else if (k === "r_brace") {
        depth--;
        if (depth === 0) {
          closeIdx = i;
          break;
        }
      } else if (k === "eof") {
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
    for (const d of sub.diagnostics) this.bodyDiagnostics.push(d);
    for (const d of sub.bodyDiagnostics) this.bodyDiagnostics.push(d);

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
  // args we must split it: consume one `>` and leave the remainder for the outer template.
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
        // (parseTypeSpec consumes the const) rather than treating const as a storage modifier.
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
      default:
        // Skip unknown token silently — qpi.h has constructs our subset parser doesn't handle
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
    // Capture the specialization arguments so the codegen can select this definition over the primary.
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

    // Combined form: `struct Tag {...} field[N], field2;` — declarators after the body become
    // member variables whose type is this struct. Queue them so the enclosing loop picks them up.
    if (hadBody && this.declaratorFollows()) {
      const declType: TypeSpec = name
        ? { kind: "name", name, span: start }
        : { kind: "inline_struct", struct, span: start };
      while (this.peek().kind === "star" || this.peek().kind === "amp") this.next();
      const first = this.expect("identifier", "struct declarator")?.text ?? "";
      const vars = this.parseDeclaratorList(declType, first, false, false);
      for (const v of vars) this.pending.push(v);
    } else {
      this.tryConsume("semicolon");
    }

    return struct;
  }

  // True when a variable declarator (not `;`) follows a record body: an identifier, `*`, `&`, or `[`.
  private declaratorFollows(): boolean {
    const k = this.peek().kind;
    return k === "identifier" || k === "star" || k === "amp" || k === "l_bracket";
  }

  // Parse the `<...>` of a (partial) class specialization head — `struct Foo<ProposalDataYesNo, numOfVotes>`.
  // Each argument is either a non-type value expression or a type (a concrete type to match, or a template
  // parameter name acting as a wildcard).
  private parseSpecializationArgs(): TypeSpec[] {
    this.next(); // <
    const args: TypeSpec[] = [];
    while (!this.eof() && this.peek().kind !== "r_angle") {
      const k = this.peek().kind;
      if (k === "int_literal" || k === "l_paren" || k === "kw_sizeof" || k === "char_literal" ||
        k === "minus" || k === "tilde" || k === "kw_true" || k === "kw_false") {
        args.push({ kind: "expr_value", expr: this.parseShift(), span: this.peek().span });
      } else {
        args.push(this.parseTypeSpec());
      }
      if (!this.tryConsume("comma")) break;
    }
    this.consumeAngleClose();
    return args;
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
    // union type (e.g. ProposalDataV1's payload). Without it the union member is dropped and the enclosing
    // struct is sized short by the union's width.
    if (hadBody && this.declaratorFollows()) {
      const declType: TypeSpec = name
        ? { kind: "name", name, span: start }
        : { kind: "inline_struct", struct: union, span: start };
      while (this.peek().kind === "star" || this.peek().kind === "amp") this.next();
      const first = this.expect("identifier", "union declarator")?.text ?? "";
      const vars = this.parseDeclaratorList(declType, first, false, false);
      for (const v of vars) this.pending.push(v);
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
          // `>` (e.g. `proposalSlotCount = 676>`) be misread as a comparison operator.
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
      if (this.tryConsumeKw("static")) { continue; }
      if (this.tryConsumeKw("inline")) { continue; }
      if (this.tryConsumeKw("constexpr")) { isConstexpr = true; continue; }
      if (this.tryConsumeKw("friend")) { continue; }
      break;
    }

    const retType = this.parseTypeSpec();
    const nameTok = this.parseMaybeQualifiedName();
    if (!nameTok) {
      return { kind: "function_template", name: "", params, returnType: retType, isConstexpr, span: this.peek().span };
    }

    this.expect("l_paren", "function params");
    const fnParams = this.parseFunctionParams();
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
      fnParams,
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
      return { kind: "typedef_decl", name: nameTok?.text ?? "fn_ptr", type: { kind: "pointer", pointee: { kind: "void" } }, span: this.makeSpan(start) };
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

    // using Base::member;
    const name = this.parseQualifiedName();
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
    const cond = this.parseExpression();

    let message: Expression | undefined;
    if (this.tryConsume("comma")) {
      message = this.parsePrimaryExpression();
    }

    this.expect("r_paren", "static_assert");
    this.expect("semicolon", "static_assert");

    return { kind: "static_assert_decl", cond, message, span: this.makeSpan(start) };
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
    const decl = this.parseDeclaration();

    if (!decl) {
      return { kind: "friend", decl: { kind: "function", name: "", returnType: { kind: "void" }, params: [], isConstexpr: false, isStatic: false, isInline: false, isExternC: false, isVirtual: false, isOverride: false, isDeleted: false, isDefault: false, span: start }, span: start };
    }

    return { kind: "friend", decl: decl as FunctionDecl | StructDecl | ClassTemplateDecl, span: this.makeSpan(start) };
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
      if (this.tryConsumeKw("constexpr")) { isConstexpr = true; }
      else if (this.tryConsumeKw("static")) { isStatic = true; }
      else if (this.tryConsumeKw("inline")) { isInline = true; }
      else if (this.tryConsumeKw("virtual")) { isVirtual = true; }
      else if (this.tryConsumeKw("extern")) { isExtern = true; }
      else { break; }
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

    // Identifier followed by ";" → variable declaration
    // Identifier followed by "=" → variable with init
    if (nextTok.kind === "semicolon" || nextTok.kind === "eq") {
      return this.parseAfterModifiers(false, false, false, false, false);
    }

    // Assume variable declaration
    return this.parseAfterModifiers(false, false, false, false, false);
  }

  private parseAfterModifiers(
    isConstexpr: boolean, isStatic: boolean, isInline: boolean,
    isVirtual: boolean, isExtern: boolean,
  ): Declaration {
    // Parse return type (or variable type)
    const type = this.parseTypeSpec();

    // Check for function call syntax: Type(...) or Type::name(
    const name = this.parseMaybeQualifiedName();

    if (!name) {
      // Constructor / destructor: `ClassName(...) {...}` or `~ClassName() {...}` — no return type. Parse
      // as a void function named after the type so its brace body is consumed cleanly (we never compile
      // it: state is zero-initialized in wasm mode).
      if (this.peek().kind === "l_paren" && type.kind === "name") {
        return this.parseFunctionRest(type.name, { kind: "void" }, isConstexpr, isStatic, isInline, isVirtual, isExtern);
      }
      // Just a type with no name — semicolon
      this.expect("semicolon", "declaration");
      return { kind: "empty" };
    }

    // `name(...)` is either a function declaration or a variable with constructor-style direct-init
    // (Type name(expr, ...);). In this subset a function parameter list never begins with an expression
    // token, so when the first token after `(` clearly starts an expression it is a direct-init variable
    // (e.g. qpi.h's `__ScopedScratchpad scratchpad(sizeof(*this), false)`).
    if (this.peek().kind === "l_paren") {
      if (this.looksLikeDirectInit()) {
        return this.parseDirectInitVar(name, type, isConstexpr, isStatic);
      }
      return this.parseFunctionRest(name, type, isConstexpr, isStatic, isInline, isVirtual, isExtern);
    }

    // Variable: name; or name = init;
    return this.parseVariableRest(name, type, isConstexpr, isStatic);
  }

  // After a `name`, peek past `(` to decide function-declaration vs constructor-style direct-init: a
  // function parameter list opens with a type, `void`, or `)`; a direct-init opens with an expression.
  private looksLikeDirectInit(): boolean {
    const after = this.peek(1).kind;
    return (
      after === "kw_sizeof" || after === "int_literal" || after === "float_literal" ||
      after === "string_literal" || after === "char_literal" || after === "kw_true" ||
      after === "kw_false" || after === "kw_nullptr" || after === "minus" ||
      // A `{` after `(` is a braced-init constructor argument (`AssetPossessionIterator iter({NULL_ID, name})`)
      // — a parameter list can't open with `{`, so this is unambiguously a direct-init variable, not a function.
      after === "bang" || after === "tilde" || after === "l_brace"
    );
  }

  private parseDirectInitVar(name: string, type: TypeSpec, isConstexpr: boolean, isStatic: boolean): VariableDecl {
    const start = this.peek().span;
    this.expect("l_paren", "ctor args");
    const args: Expression[] = [];
    if (this.peek().kind !== "r_paren") {
      args.push(this.parseExpression());
      while (this.tryConsume("comma")) {
        args.push(this.parseExpression());
      }
    }
    this.expect("r_paren", "ctor args close");
    this.expect("semicolon", "direct-init declaration");
    return {
      kind: "variable", name, type,
      init: { kind: "construct", type, args, span: start },
      isConstexpr, isStatic, isExtern: false, isMember: false, access: "public",
      span: this.makeSpan(start),
    };
  }

  private parseFunctionAfterReturnType(retType: TypeSpec, isExternC: boolean): FunctionDecl {
    const name = this.parseMaybeQualifiedName() ?? "";
    const isConstexpr = false;
    return this.parseFunctionRest(name, retType, isConstexpr, false, false, false, isExternC);
  }

  private parseFunctionRest(
    name: string, retType: TypeSpec,
    isConstexpr: boolean, isStatic: boolean, isInline: boolean,
    isVirtual: boolean, isExternC: boolean,
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

  private parseVariableRest(name: string, type: TypeSpec, isConstexpr: boolean, isStatic: boolean): Declaration {
    const vars = this.parseDeclaratorList(type, name, isConstexpr, isStatic);
    // First declarator is returned; the rest are queued for the enclosing member/decl loop.
    for (let i = 1; i < vars.length; i++) this.pending.push(vars[i]);
    return vars[0] ?? { kind: "empty" };
  }

  // Parse one or more declarators sharing a base type: `name[dim]...`, `name = init`, `, name2, ...`,
  // terminated by `;`. Handles C array members (the key qpi.h container-layout construct).
  private parseDeclaratorList(baseType: TypeSpec, firstName: string, isConstexpr: boolean, isStatic: boolean): VariableDecl[] {
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
      for (let i = dims.length - 1; i >= 0; i--) {
        type = { kind: "array", elem: type, size: dims[i], span: start };
      }

      let init: Expression | undefined;
      if (this.tryConsume("eq")) {
        init = this.parseExpression();
      } else if (this.peek().kind === "l_brace") {
        // braced initializer — skip it for layout purposes
        this.skipBalanced("l_brace", "r_brace");
      }

      out.push({
        kind: "variable", name, type, init,
        isConstexpr, isStatic, isExtern: false, isMember: false, access: "public",
        span: this.makeSpan(start),
      });

      if (this.tryConsume("comma")) {
        // next declarator: optional * / & then a name
        while (this.peek().kind === "star" || this.peek().kind === "amp") this.next();
        const n = this.peek();
        if (n.kind === "identifier") { name = this.next().text; continue; }
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
      const type = this.parseTypeSpec();
      let name = "";

      if (this.peek().kind === "identifier") {
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
      } else if (this.peek().kind === "amp" && this.peek(1).kind !== "amp" && this.peek(1).kind !== "eq") {
        // & (but not && or &=)
        this.next();
        type = { kind: "reference", refereed: type, span: type.span };
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

    // `typename` is a parse-time disambiguator (typename Sel<v>::type) — drop it and parse the type that
    // follows; any trailing `::member` is captured below as a dependent-member type.
    if (tok.kind === "kw_typename") {
      this.next();
      return this.parseBaseType();
    }

    // Built-in type keywords
    if (isTypeKeyword(tok.kind)) {
      return this.parseBuiltinType();
    }

    // struct / enum / class / union prefix
    if (tok.kind === "kw_struct" || tok.kind === "kw_enum" || tok.kind === "kw_class" || tok.kind === "kw_union") {
      this.next();
      const name = this.next().text;
      return { kind: "name", name, span: tok.span };
    }

    // unsigned / signed prefixes
    if (tok.kind === "kw_unsigned" || tok.kind === "kw_signed" || tok.kind === "kw_long") {
      return this.parseBuiltinType();
    }

    // Name or qualified name. In a type position, `Sel<args>::member` is a dependent type — stop the
    // qualified name at the `<` so the template instance and its `::member` are captured below.
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
      const args: TypeSpec[] = [];

      while (!this.eof() && this.peek().kind !== "r_angle") {
        const k = this.peek().kind;
        // Non-type arg that is a value expression (literal, paren, sizeof, `-N`, `~N`) — parse at
        // shift precedence so arithmetic like `64*1024*1024` is captured but `>` stays the closer.
        if (k === "int_literal" || k === "l_paren" || k === "kw_sizeof" || k === "char_literal" ||
          k === "minus" || k === "tilde" || k === "kw_true" || k === "kw_false" || this.templateArgIsExpr()) {
          args.push({ kind: "expr_value", expr: this.parseShift(), span: this.peek().span });
        } else if (k === "d_colon" || k === "identifier" || isTypeKeyword(k) || k === "kw_const" ||
          k === "kw_struct" || k === "kw_unsigned" || k === "kw_signed") {
          args.push(this.parseTypeSpec());
        } else {
          const name = this.parseMaybeQualifiedName() || this.next().text;
          args.push({ kind: "name", name, span: this.peek().span });
        }
        if (!this.tryConsume("comma")) {
          break;
        }
      }

      this.consumeAngleClose();
      const inst: TypeSpec = { kind: "template_instance", name, args, span: tok.span };
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

  // A template argument that begins with a (qualified) identifier followed by an arithmetic operator and
  // another operand is a NON-TYPE value expression (e.g. Collection<T, QSWAP_MAX_POOL * QSWAP_MAX_USERS>),
  // not a pointer type — so it is parsed as an expression rather than `Type *`.
  private templateArgIsExpr(): boolean {
    if (this.peek().kind !== "identifier") return false;
    let i = 1;
    while (this.peek(i).kind === "d_colon" && this.peek(i + 1).kind === "identifier") i += 2;
    const op = this.peek(i).kind;
    if (op !== "star" && op !== "plus" && op !== "slash" && op !== "percent" && op !== "l_shift" && op !== "r_shift") return false;
    const after = this.peek(i + 1).kind;
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
      "eq": "=", "plus_eq": "+=", "minus_eq": "-=", "star_eq": "*=",
      "slash_eq": "/=", "percent_eq": "%=", "l_shift_eq": "<<=",
      "r_shift_eq": ">>=", "amp_eq": "&=", "pipe_eq": "|=", "caret_eq": "^=",
    };

    const op = assignOps[tok.kind];
    if (op) {
      this.next();
      const right = this.parseAssignment();
      return { kind: "assign", op, left, right, span: left.span };
    }

    return left;
  }

  private parseTernary(): Expression {
    const cond = this.parseLogicalOr();

    if (this.tryConsume("question")) {
      const then = this.parseExpression();
      this.expect("colon", "ternary");
      const else_ = this.parseExpression();
      return { kind: "ternary", cond, then, else_, span: cond.span };
    }

    return cond;
  }

  private parseLogicalOr(): Expression {
    let left = this.parseLogicalAnd();

    while (this.tryConsume("pipe_pipe")) {
      const right = this.parseLogicalAnd();
      left = { kind: "binary_op", op: "||", left, right, span: left.span };
    }

    return left;
  }

  private parseLogicalAnd(): Expression {
    let left = this.parseBitwiseOr();

    while (this.tryConsume("amp_amp")) {
      const right = this.parseBitwiseOr();
      left = { kind: "binary_op", op: "&&", left, right, span: left.span };
    }

    return left;
  }

  private parseBitwiseOr(): Expression {
    let left = this.parseBitwiseXor();

    while (this.tryConsume("pipe")) {
      const right = this.parseBitwiseXor();
      left = { kind: "binary_op", op: "|", left, right, span: left.span };
    }

    return left;
  }

  private parseBitwiseXor(): Expression {
    let left = this.parseBitwiseAnd();

    while (this.tryConsume("caret")) {
      const right = this.parseBitwiseAnd();
      left = { kind: "binary_op", op: "^", left, right, span: left.span };
    }

    return left;
  }

  private parseBitwiseAnd(): Expression {
    let left = this.parseEquality();

    while (this.tryConsume("amp")) {
      const right = this.parseEquality();
      left = { kind: "binary_op", op: "&", left, right, span: left.span };
    }

    return left;
  }

  private parseEquality(): Expression {
    let left = this.parseComparison();

    while (!this.eof()) {
      const tok = this.peek();
      if (tok.kind === "eq_eq") {
        this.next();
        left = { kind: "binary_op", op: "==", left, right: this.parseComparison(), span: left.span };
      } else if (tok.kind === "not_eq") {
        this.next();
        left = { kind: "binary_op", op: "!=", left, right: this.parseComparison(), span: left.span };
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
      // they are comparison operators (parsePostfix already declined any template-call interpretation).
      const ops: Record<string, BinaryOp> = {
        "l_angle": "<", "r_angle": ">", "lt_eq": "<=", "gt_eq": ">=",
      };
      // Inside a template arg/param list a top-level `>` / `>=` closes the list, not a comparison.
      if (this.gtDisabled > 0 && (tok.kind === "r_angle" || tok.kind === "gt_eq")) {
        break;
      }
      const op = ops[tok.kind];
      if (op) {
        this.next();
        left = { kind: "binary_op", op, left, right: this.parseShift(), span: left.span };
      } else if (tok.kind === "spaceship") {
        // <=> — treat as comparison
        this.next();
        left = { kind: "binary_op", op: "<", left, right: this.parseShift(), span: left.span };
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
        left = { kind: "binary_op", op: "<<", left, right: this.parseAdditive(), span: left.span };
      } else if (this.tryConsume("r_shift")) {
        left = { kind: "binary_op", op: ">>", left, right: this.parseAdditive(), span: left.span };
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
        left = { kind: "binary_op", op: "+", left, right: this.parseMultiplicative(), span: left.span };
      } else if (this.tryConsume("minus")) {
        left = { kind: "binary_op", op: "-", left, right: this.parseMultiplicative(), span: left.span };
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
        left = { kind: "binary_op", op: "*", left, right: this.parseUnary(), span: left.span };
      } else if (this.tryConsume("slash")) {
        left = { kind: "binary_op", op: "/", left, right: this.parseUnary(), span: left.span };
      } else if (this.tryConsume("percent")) {
        left = { kind: "binary_op", op: "%", left, right: this.parseUnary(), span: left.span };
      } else {
        break;
      }
    }

    return left;
  }

  private parseUnary(): Expression {
    const tok = this.peek();

    // Prefix operators
    if (tok.kind === "bang" || tok.kind === "tilde" || tok.kind === "minus" || tok.kind === "plus" || tok.kind === "star" || tok.kind === "amp") {
      const opMap: Record<string, UnaryOp> = {
        "bang": "!", "tilde": "~", "minus": "-", "plus": "+", "star": "*", "amp": "&",
      };
      const op = opMap[tok.kind];
      if (op) {
        this.next();
        const arg = this.parseUnary();
        return { kind: "unary_op", op, arg, span: tok.span };
      }
    }

    // Prefix ++ / --
    if (tok.kind === "plus_plus" || tok.kind === "minus_minus") {
      const op = tok.kind === "plus_plus" ? "++" as const : "--" as const;
      this.next();
      const arg = this.parseUnary();
      return { kind: "prefix_op", op, arg, span: tok.span };
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
    let expr = this.parsePrimaryExpression();

    while (!this.eof()) {
      const tok = this.peek();

      // Brace-init / aggregate construction: TypeName{ a, b, c } (e.g. Logger{ idx, code, 0 }). Only an
      // identifier/qualified-name operand can be a type here; a compound block after a condition is parsed
      // in parseStatement, so `{` in expression position is always construction.
      if (tok.kind === "l_brace" && (expr.kind === "identifier" || expr.kind === "qualified_name")) {
        const name = expr.kind === "identifier" ? expr.name : `${expr.namespace}::${expr.name}`;
        this.next(); // {
        const args: Expression[] = [];
        while (!this.eof() && this.peek().kind !== "r_brace") {
          args.push(this.parseBraceArg());
          if (!this.tryConsume("comma")) break;
        }
        this.expect("r_brace", "brace init");
        expr = { kind: "construct", type: { kind: "name", name }, args, span: expr.span };
        continue;
      }

      // .member or ->member
      if (tok.kind === "dot" || tok.kind === "arrow") {
        const arrow = tok.kind === "arrow";
        this.next();
        const memberTok = this.expect("identifier", "member access");
        if (memberTok) {
          expr = { kind: "member_access", object: expr, member: memberTok.text, arrow, span: expr.span };
        }
        continue;
      }

      // [index] (internal/QPI framework use)
      if (tok.kind === "l_bracket") {
        this.next();
        const index = this.parseExpression();
        this.expect("r_bracket", "subscript");
        expr = { kind: "subscript", object: expr, index, span: expr.span };
        continue;
      }

      // Function call: expr(args)
      if (tok.kind === "l_paren") {
        this.next();
        const args = this.parseArgList();
        this.expect("r_paren", "call args");
        expr = { kind: "call", callee: expr, args, span: expr.span };
        continue;
      }

      // Template call: expr<T>(args) — only when the lookahead genuinely matches `< types > (`.
      // Otherwise `<` is a comparison operator (handled higher up), so break out.
      if (tok.kind === "l_angle" && this.looksLikeTemplateArgs()) {
        this.next();
        const templateArgs: TypeSpec[] = [];
        while (!this.eof() && this.peek().kind !== "r_angle") {
          templateArgs.push(this.parseTypeSpec());
          if (!this.tryConsume("comma")) break;
        }
        this.consumeAngleClose();

        this.expect("l_paren", "template call args");
        const args = this.parseArgList();
        this.expect("r_paren", "template call args close");

        expr = { kind: "template_call", callee: expr, templateArgs, args, span: expr.span };
        continue;
      }

      // Postfix ++ / --
      if (tok.kind === "plus_plus" || tok.kind === "minus_minus") {
        const op = tok.kind === "plus_plus" ? "++" as const : "--" as const;
        this.next();
        expr = { kind: "postfix_op", op, arg: expr, span: expr.span };
        continue;
      }

      break;
    }

    return expr;
  }

  // Disambiguate `<` as template-args vs comparison: scan from the `<` for a matching `>` that is
  // immediately followed by `(`, allowing only type-ish tokens inside. Anything else → comparison.
  private looksLikeTemplateArgs(): boolean {
    const save = (this.lex as any).index;
    this.next(); // consume `<`
    let depth = 1;
    let ok = true;
    let guard = 0;
    while (!this.eof() && depth > 0 && guard++ < 200) {
      const k = this.peek().kind;
      if (k === "l_angle") { depth++; this.next(); continue; }
      if (k === "r_angle") { depth--; this.next(); continue; }
      if (k === "r_shift") { depth -= 2; this.next(); continue; }
      // Tokens that can't appear inside a template-argument list → it's a comparison.
      if (k === "semicolon" || k === "l_brace" || k === "r_brace" || k === "eq" ||
        k === "plus" || k === "minus" || k === "slash" || k === "percent" || k === "question" ||
        k === "amp_amp" || k === "pipe_pipe" || k === "eq_eq" || k === "not_eq" ||
        k === "l_paren" || k === "r_paren") {
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
      const exprs: Expression[] = [];
      while (!this.eof() && this.peek().kind !== "r_brace") {
        exprs.push(this.parseBraceArg());
        if (!this.tryConsume("comma")) break;
      }
      this.expect("r_brace", "initializer list");
      return { kind: "initializer_list", exprs, span: start };
    }
    return this.parseExpression();
  }

  private parsePrimaryExpression(): Expression {
    const tok = this.peek();

    // Literals
    if (tok.kind === "int_literal") {
      this.next();
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
      const expr = this.parseExpression();
      this.gtDisabled = savedGt;
      this.expect("r_paren", "paren expr");
      return { kind: "paren", expr, span: tok.span };
    }

    // Brace initializer: {a, b, c}
    if (tok.kind === "l_brace") {
      this.next();
      const savedGt = this.gtDisabled;
      this.gtDisabled = 0;
      const exprs: Expression[] = [];
      while (!this.eof() && this.peek().kind !== "r_brace") {
        exprs.push(this.parseExpression());
        if (!this.tryConsume("comma")) break;
      }
      this.gtDisabled = savedGt;
      this.expect("r_brace", "initializer list");
      return { kind: "initializer_list", exprs, span: tok.span };
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
        // Type position: `Sel<args>::type` is a dependent type — stop here and let the caller capture the
        // template instance and its `::member`, instead of dropping the args like an out-of-class method name.
        parts.push(this.next().text);
        break;
      }
      if (tok.kind === "kw_operator") {
        // operator overload name: consume `operator` + the operator symbol token(s).
        this.next();
        const opTok = this.peek();
        if (opTok.kind === "l_paren" && this.peek(1).kind === "r_paren") {
          this.next(); this.next(); parts.push("operator()");
        } else if (opTok.kind === "l_bracket" && this.peek(1).kind === "r_bracket") {
          this.next(); this.next(); parts.push("operator[]");
        } else if (opTok.kind === "identifier" || isTypeKeyword(opTok.kind) || opTok.kind === "kw_bool") {
          // conversion operator: operator bool() / operator T()
          parts.push("operator " + this.next().text);
        } else {
          parts.push("operator" + this.next().text);
        }
      } else if (tok.kind === "identifier") {
        parts.push(this.next().text);
        // ClassTemplate<args>::method — out-of-class definition. Drop the qualifier's template args
        // (the binding is recovered from the template<> header), keep the qualified name.
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
  // side-effecting expressions (for-update). A single expression returns as-is.
  private parseCommaSequence(): Expression {
    const first = this.parseExpression();
    if (this.peek().kind !== "comma") return first;
    const exprs = [first];
    while (this.peek().kind === "comma") {
      this.next();
      exprs.push(this.parseExpression());
    }
    return { kind: "sequence", exprs, span: first.span };
  }

  // A local variable declaration at statement start (a typedef'd type name, not a keyword): `Type var`,
  // `Type* var`, `Type& var`, or a `const`/`auto` lead. `identifier identifier` is never a valid
  // expression statement in C++, so this is unambiguous. (Contract bodies have no stack locals, but
  // qpi.h's template method bodies — which we compile — do.)
  private looksLikeLocalDecl(): boolean {
    const t0 = this.peek().kind;
    if (t0 === "kw_const" || t0 === "kw_auto") return true;
    if (t0 !== "identifier") return false;
    // Skip a qualified type name: identifier (:: identifier)* — e.g. QPI::uint64 name.
    let i = 1;
    while (this.peek(i).kind === "d_colon" && this.peek(i + 1).kind === "identifier") i += 2;
    // Skip template arguments `<...>` so `ProposalWithAllVoteData<D, N>& p` is recognized as a decl, not
    // read as a `<` comparison. Bail (not a declaration) if the angles don't close before the statement ends.
    if (this.peek(i).kind === "l_angle") {
      let depth = 0;
      let j = i;
      for (; !this.eof(); j++) {
        const k = this.peek(j).kind;
        if (k === "l_angle") depth++;
        else if (k === "r_angle") { if (--depth === 0) { j++; break; } }
        else if (k === "r_shift") { depth -= 2; if (depth <= 0) { j++; break; } }
        else if (k === "semicolon" || k === "l_brace" || k === "r_brace" || k === "r_paren") return false;
      }
      if (depth > 0) return false;
      i = j;
    }
    const t1 = this.peek(i).kind;
    if (t1 === "identifier") return true;
    if ((t1 === "star" || t1 === "amp") && this.peek(i + 1).kind === "identifier") return true;
    return false;
  }

  // Consume a balanced <...> template-argument group (handling nested <> and >>). Returns true if it
  // closed cleanly. Caller saves/restores the position for speculative use.
  private skipAngleArgs(): boolean {
    if (this.peek().kind !== "l_angle") return false;
    this.next(); // <
    let depth = 1, guard = 0;
    while (!this.eof() && depth > 0 && guard++ < 500) {
      const k = this.peek().kind;
      if (k === "l_angle") { depth++; this.next(); continue; }
      if (k === "r_angle") { depth--; this.next(); continue; }
      if (k === "r_shift") { depth -= 2; this.next(); continue; }
      if (k === "semicolon" || k === "l_brace") return false;
      this.next();
    }
    return depth <= 0;
  }

  // Decide whether `( ... )` begins a C-style cast vs a parenthesized expression. Only a *pure type*
  // inside the parens counts — `(uint64*)x`, `(id)x`. Anything containing an operator or a value
  // literal (e.g. `(L * 2 + 63)`) is an expression, NOT a cast.
  private isTypeCast(): boolean {
    const save = (this.lex as any).index;
    this.next(); // (

    let pureType = true;
    let sawTypeToken = false;
    let depth = 0;
    let saw = false;
    let sawNestedParen = false;

    while (!this.eof()) {
      const t = this.peek();
      // A C-style cast type-id in this subset never contains parentheses (no function-pointer / decltype
      // types), so a nested `(` means this is a parenthesized EXPRESSION, not a cast. Without this,
      // `((uint64)_55) * 26` reads as a cast — the inner `(uint64)` looks type-ish and the trailing `*`
      // satisfies operandFollows — which then swallows the surrounding call-argument commas.
      if (t.kind === "l_paren") { depth++; sawNestedParen = true; this.next(); continue; }
      if (t.kind === "r_paren") {
        if (depth === 0) { this.next(); break; }
        depth--; this.next(); continue;
      }
      saw = true;
      const ok = isTypeKeyword(t.kind) || t.kind === "kw_unsigned" || t.kind === "kw_signed" ||
        t.kind === "kw_const" || t.kind === "kw_struct" || t.kind === "kw_enum" || t.kind === "kw_class" ||
        t.kind === "star" || t.kind === "amp" || t.kind === "d_colon" ||
        t.kind === "l_angle" || t.kind === "r_angle" || t.kind === "r_shift" || t.kind === "comma" ||
        t.kind === "identifier";
      if (isTypeKeyword(t.kind) || (t.kind === "identifier")) sawTypeToken = true;
      if (!ok) { pureType = false; }
      this.next();
    }

    // After the `)`, a cast must be followed by an operand (so `(id) + 5` is NOT a cast).
    const after = this.peek();
    const operandFollows = after.kind === "identifier" || after.kind === "int_literal" ||
      after.kind === "l_paren" || after.kind === "bang" || after.kind === "tilde" ||
      after.kind === "minus" || after.kind === "plus" || after.kind === "amp" || after.kind === "star" ||
      after.kind === "kw_true" || after.kind === "kw_false" || after.kind === "char_literal" ||
      after.kind === "string_literal" || after.kind === "kw_this" || after.kind === "kw_sizeof";

    (this.lex as any).index = save;

    // A bare identifier in parens (`(L * 2 ...)` has operators → not pure) is a cast only when it's a
    // pure type AND an operand follows. Reject if a stray int literal appears outside template angles.
    return saw && pureType && sawTypeToken && operandFollows && !sawNestedParen;
  }

  private parseCast(): Expression {
    this.next(); // (
    const type = this.parseTypeSpec();
    this.expect("r_paren", "cast");
    const expr = this.parseUnary();
    return { kind: "c_cast", type, expr, span: expr.span };
  }

  private parseSizeof(): Expression {
    const start = this.next().span; // sizeof

    if (this.tryConsume("l_paren")) {
      // sizeof(T) or sizeof(expr)
      // Check if it's a type
      const tok = this.peek();
      if (isTypeKeyword(tok.kind) || tok.kind === "kw_unsigned" || tok.kind === "kw_signed" ||
        tok.kind === "kw_struct" || tok.kind === "kw_enum" || tok.kind === "kw_const") {
        const type = this.parseTypeSpec();
        this.expect("r_paren", "sizeof type");
        return { kind: "sizeof_type", type, span: this.makeSpan(start) };
      }

      const expr = this.parseExpression();
      this.expect("r_paren", "sizeof expr");
      return { kind: "sizeof_expr", expr, span: this.makeSpan(start) };
    }

    // sizeof expr (without parens)
    const expr = this.parseUnary();
    return { kind: "sizeof_expr", expr, span: this.makeSpan(start) };
  }

  private parseArgList(): Expression[] {
    const args: Expression[] = [];

    if (this.peek().kind === "r_paren") {
      return args;
    }

    while (!this.eof()) {
      args.push(this.parseExpression());
      if (!this.tryConsume("comma")) {
        break;
      }
    }

    return args;
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
    if (tok.kind === "kw_if") { return this.parseIf(); }
    if (tok.kind === "kw_for") { return this.parseFor(); }
    if (tok.kind === "kw_while") { return this.parseWhile(); }
    if (tok.kind === "kw_do") { return this.parseDoWhile(); }
    if (tok.kind === "kw_switch") { return this.parseSwitch(); }
    if (tok.kind === "kw_case") { return this.parseCase(); }
    if (tok.kind === "kw_default") { return this.parseDefault(); }
    if (tok.kind === "kw_break") { this.next(); this.expect("semicolon", "break"); return { kind: "break", span: tok.span }; }
    if (tok.kind === "kw_continue") { this.next(); this.expect("semicolon", "continue"); return { kind: "continue", span: tok.span }; }
    if (tok.kind === "kw_return") { return this.parseReturn(); }
    if (tok.kind === "kw_goto") { this.next(); const labelTok = this.expect("identifier", "goto label"); this.expect("semicolon", "goto"); return { kind: "goto", label: labelTok?.text ?? "", span: tok.span }; }

    // Label: identifier :
    if (tok.kind === "identifier" && this.peek(1).kind === "colon") {
      this.next();
      this.next(); // :
      return { kind: "label", name: tok.text, span: tok.span };
    }

    // static_assert
    if (tok.kind === "kw_static_assert") {
      const sa = this.parseStaticAssertDecl();
      return { kind: "static_assert", cond: sa.cond, message: sa.message, span: sa.span };
    }

    // Declaration (type keyword or modifier)
    if (isTypeKeyword(tok.kind) || tok.kind === "kw_constexpr" || tok.kind === "kw_static" ||
      tok.kind === "kw_inline" || tok.kind === "kw_typedef" || tok.kind === "kw_using" ||
      tok.kind === "kw_enum" || tok.kind === "kw_struct" || tok.kind === "kw_class" ||
      tok.kind === "kw_union" || tok.kind === "kw_namespace" || tok.kind === "kw_template" ||
      tok.kind === "kw_extern" || tok.kind === "kw_unsigned" || tok.kind === "kw_signed" ||
      tok.kind === "kw_long" || this.looksLikeLocalDecl()) {
      const decl = this.parseDeclaration();
      if (decl) {
        // Multi-declarator statement (`sint64 a = 0, b = 0;`): parseVariableRest queues the extra
        // declarators on `pending`, which only the member/decl-list loops drain — inside a function
        // body drain them here into a compound so no declarator is lost.
        if (this.pending.length) {
          const stmts: Statement[] = [{ kind: "declaration", decl, span: this.peek().span }];
          while (this.pending.length) {
            const d = this.pending.shift()!;
            stmts.push({ kind: "declaration", decl: d, span: (d as any).span ?? this.peek().span });
          }
          return { kind: "compound", body: stmts, span: this.peek().span };
        }
        return { kind: "declaration", decl, span: this.peek().span };
      }
    }

    // Expression statement
    if (tok.kind === "semicolon") {
      this.next();
      return { kind: "empty", span: tok.span };
    }

    const expr = this.parseExpression();

    // Label after expression: expr : (unlikely but possible for case-like constructs)
    if (this.peek().kind === "colon" && (expr.kind === "identifier")) {
      this.next(); // :
      return { kind: "label", name: (expr as any).name, span: expr.span };
    }

    this.expect("semicolon", "expression statement");
    return { kind: "expression", expr, span: expr.span };
  }

  private parseCompoundStatement(): Statement {
    const start = this.peek(-1)?.span || this.peek().span;
    const body: Statement[] = [];

    while (!this.eof() && this.peek().kind !== "r_brace") {
      const stmt = this.parseStatement();
      if (stmt) {
        body.push(stmt);
      }
    }

    this.expect("r_brace", "compound close");

    return { kind: "compound", body, span: this.makeSpan(start) };
  }

  private parseIf(): Statement {
    const start = this.next().span; // if
    this.expect("l_paren", "if cond");
    const cond = this.parseExpression();
    this.expect("r_paren", "if cond close");

    const thenStmt = this.parseStatement();
    let elseStmt: Statement | undefined;

    if (this.tryConsumeKw("else")) {
      elseStmt = this.parseStatement();
    }

    return { kind: "if", cond, then: thenStmt, else_: elseStmt, span: this.makeSpan(start) };
  }

  private parseFor(): Statement {
    const start = this.next().span; // for
    this.expect("l_paren", "for");

    let init: Statement | undefined;
    let cond: Expression | undefined;
    let update: Expression | undefined;

    // for (;;)
    if (this.peek().kind !== "semicolon") {
      // Could be a declaration (`for (sint64 i = 0; ...)`) or an expression init.
      if (isTypeKeyword(this.peek().kind) || this.looksLikeLocalDecl()) {
        const decl = this.parseDeclaration();
        if (decl) {
          init = { kind: "declaration", decl, span: decl.span ?? this.peek().span };
        }
      } else {
        // the init clause may be a comma sequence of assignments: for (a = x, b = 0; ...).
        const expr = this.parseCommaSequence();
        init = { kind: "expression", expr, span: expr.span };
      }
    }
    // parseDeclaration may or may not consume the trailing ';'; consume it here if still present.
    if (this.peek().kind === "semicolon") this.next();

    if (this.peek().kind !== "semicolon") {
      cond = this.parseExpression();
    }
    this.expect("semicolon", "for cond");

    if (this.peek().kind !== "r_paren") {
      update = this.parseCommaSequence();
    }
    this.expect("r_paren", "for close");

    const body = this.parseStatement();

    return { kind: "for", init, cond, update, body, span: this.makeSpan(start) };
  }

  private parseWhile(): Statement {
    const start = this.next().span; // while
    this.expect("l_paren", "while cond");
    const cond = this.parseExpression();
    this.expect("r_paren", "while cond close");
    const body = this.parseStatement();
    return { kind: "while", cond, body, span: this.makeSpan(start) };
  }

  private parseDoWhile(): Statement {
    const start = this.next().span; // do
    const body = this.parseStatement();
    this.expect("kw_while", "do-while while");
    this.expect("l_paren", "do-while cond");
    const cond = this.parseExpression();
    this.expect("r_paren", "do-while cond close");
    this.expect("semicolon", "do-while");
    return { kind: "do_while", body, cond, span: this.makeSpan(start) };
  }

  private parseSwitch(): Statement {
    const start = this.next().span; // switch
    this.expect("l_paren", "switch cond");
    const cond = this.parseExpression();
    this.expect("r_paren", "switch cond close");
    const body = this.parseStatement();
    return { kind: "switch", cond, body, span: this.makeSpan(start) };
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
    while (!this.eof() && this.peek().kind !== "eof" &&
      this.peek().text !== "\n") {
      this.next();
    }
    return { kind: "empty" };
  }

  // ---- Helpers ----

  // Assumes the current token is the opening delimiter; consumes through the matching close
  // (inclusive). Safe no-op if the current token is not `open`.
  private skipBalanced(open: TokenKind, close: TokenKind): void {
    if (this.peek().kind !== open) return;
    this.next(); // consume the opener
    let depth = 1;
    while (!this.eof() && depth > 0) {
      const k = this.peek().kind;
      if (k === open) depth++;
      else if (k === close) depth--;
      this.next();
    }
  }

  private parseDeclarationList(): Declaration[] {
    const decls: Declaration[] = [];

    while (!this.eof() && this.peek().kind !== "r_brace") {
      const before = (this.lex as any).index;
      const errsBefore = this.diagnostics.length;
      const decl = this.parseDeclaration();
      if (decl && decl.kind !== "empty") decls.push(decl);
      while (this.pending.length) decls.push(this.pending.shift()!);
      this.recover(before, errsBefore);
    }

    return decls;
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
        const f = this.parseFriend();
        members.push(f);
        continue;
      }

      const before = (this.lex as any).index;
      const errsBefore = this.diagnostics.length;
      const decl = this.parseDeclaration();
      if (decl && decl.kind !== "empty") members.push(decl);
      while (this.pending.length) members.push(this.pending.shift()!);
      this.recover(before, errsBefore);
    }

    return members;
  }

  // Panic recovery: if a declaration made no progress, or emitted a new error, skip to the next
  // `;` or balanced `}` at the current brace depth so one bad member never eats the whole body.
  private recover(beforeIndex: number, errsBefore: number): void {
    const idx = (this.lex as any).index;
    const noProgress = idx === beforeIndex;
    const newError = this.diagnostics.length > errsBefore;
    if (!noProgress && !newError) return;

    // A declaration that consumed its full balanced body ends on `}` or `;`. Its inner errors are already
    // contained within that body, so the cursor is at a clean sibling boundary — skipping forward here
    // would wrongly discard the following declaration (e.g. a sibling `namespace QPI { ... }` whose
    // definitions we need). Only the no-progress / stranded-cursor cases need panic-skipping.
    if (!noProgress && (this._last?.kind === "r_brace" || this._last?.kind === "semicolon")) {
      return;
    }

    if (noProgress) {
      this.next(); // force progress
    }

    let depth = 0;
    while (!this.eof()) {
      const k = this.peek().kind;
      if (k === "l_brace") { depth++; this.next(); continue; }
      if (k === "r_brace") {
        if (depth === 0) return; // class body's own close — let the caller handle it
        depth--; this.next();
        if (depth === 0) return; // finished a member's brace body (e.g. a constructor) — member boundary
        continue;
      }
      if (k === "semicolon" && depth === 0) { this.next(); return; }
      this.next();
    }
  }

  private parseCharValue(text: string): number {
    // Parse C++ character literal value
    const inner = text.replace(/^'|'$/g, "");
    if (inner.startsWith("\\")) {
      switch (inner[1]) {
        case "n": return 10;
        case "t": return 9;
        case "r": return 13;
        case "0": return 0;
        case "\\": return 92;
        case "'": return 39;
        default: return inner.charCodeAt(1);
      }
    }
    return inner.charCodeAt(0);
  }

  private _last: Token | null = null;

  private makeSpan(start: Span): Span {
    const last = this._last?.span ?? this.peek().span;
    return { start: start.start, end: last.end, line: start.line, col: start.col };
  }

  // ---- IDL extraction ----
  // Extract contract IDL from parsed AST (input/output types per registered entry)
  extractIdl(tu: TranslationUnit): Record<string, { inputType: number; kind: number; inSize: number; outSize: number }> {
    const idl: Record<string, { inputType: number; kind: number; inSize: number; outSize: number }> = {};
    // This is driven by the REGISTER_USER_FUNCTION/PROCEDURE calls in __registerUserFunctionsAndProcedures.
    // Parsed AST contains these as function calls with literal arguments — extract them.
    for (const decl of tu.declarations) {
      this.extractIdlFromNode(decl, idl);
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
      for (const m of struct.members) {
        this.extractIdlFromNode(m, idl);
      }
    } else if (node.kind === "namespace") {
      for (const d of (node as NamespaceDecl).body) {
        this.extractIdlFromNode(d, idl);
      }
    }
  }

  private extractIdlFromStmt(stmt: Statement, idl: Record<string, any>): void {
    if (stmt.kind === "compound") {
      for (const s of (stmt as any).body) {
        this.extractIdlFromStmt(s, idl);
      }
    } else if (stmt.kind === "expression") {
      const expr = stmt as any;
      // Look for: qpi.__registerUserFunction(fn, inputType, sizeof(input), sizeof(output), sizeof(locals))
      if (expr.expr?.kind === "call") {
        this.checkRegistrationCall(expr.expr, idl);
      }
    }
  }

  private checkRegistrationCall(call: any, idl: Record<string, any>): void {
    if (call.callee?.kind === "member_access" &&
      (call.callee.member === "__registerUserFunction" || call.callee.member === "__registerUserProcedure")) {
      const kind = call.callee.member === "__registerUserFunction" ? 0 : 1;
      // sizeof(Foo_input) parses as sizeof_type when Foo_input is a known type keyword, but as sizeof_expr
      // when it is a bare struct name (the common case) — accept either.
      const isSizeof = (a: any) => a?.kind === "sizeof_type" || a?.kind === "sizeof_expr";
      if (call.args.length >= 5 &&
        call.args[1]?.kind === "int_literal" &&
        isSizeof(call.args[2]) &&
        isSizeof(call.args[3])) {
        const inputType = parseInt(call.args[1].value);
        const fnName = call.args[0]?.kind === "identifier" ? call.args[0].name :
          call.args[0]?.kind === "c_cast" ? call.args[0].expr?.name : "";
        // inSize/outSize from sizeof — need sema to evaluate
        if (fnName && inputType >= 1 && inputType <= 65535) {
          idl[fnName] = { inputType, kind, inSize: 0, outSize: 0 };
        }
      }
    }
  }
}
