// C preprocessor for QPI subset. Operates on text, not tokens.
// Handles: #define (object-like + function-like with ## and #), #include, #pragma once,
// __LINE__, simple conditional directives (#ifdef / #ifndef / #endif / #else).

export interface PreprocessOpts {
  source: string;                     // contract source
  qpiHeader: string;                  // preprocessed qpi.h content (all #includes resolved)
  contractName: string;
  contractIndex: number;
  calleePrelude?: string;             // inter-contract callee type headers
  seedMacros?: Map<string, MacroDef>; // pre-built macro table (from qpi.h) to start from
}

export interface MacroDef {
  name: string;
  params: string[] | null;            // null = object-like, [] = function-like with no params
  body: string;
  isVarArgs: boolean;
}

export class Preprocessor {
  private defines: Map<string, MacroDef> = new Map();
  private expanding: Set<string> = new Set();
  private line: number = 1;
  private result: string = "";
  private input: string = "";
  private pos: number = 0;
  private srcLine: number[];          // line → byte offset map
  // Conditional-compilation stack. Each frame: whether this branch is emitting, and whether any
  // branch of the group has already been taken (so #elif/#else know to stay off).
  private condStack: { active: boolean; taken: boolean; parentActive: boolean }[] = [];

  constructor() {
    this.srcLine = [];
  }

  private condActive(): boolean {
    for (const f of this.condStack) {
      if (!f.active) return false;
    }
    return true;
  }

  // The macro table after a run — used to capture qpi.h's #defines for reuse on user source.
  getDefines(): Map<string, MacroDef> {
    return new Map(this.defines);
  }

  preprocess(opts: PreprocessOpts): string {
    this.defines.clear();
    this.condStack = [];

    if (opts.seedMacros) {
      for (const [k, v] of opts.seedMacros) this.defines.set(k, v);
    }

    // Built-in defines
    this.define("__LINE__", "__LINE__"); // special-cased during expansion
    this.define("LITE_WASM_TU_BUILD", "");
    this.define("LITEDYN_CONTRACT_TU", "");

    // Contract-specific defines
    this.define("CONTRACT_INDEX", String(opts.contractIndex));
    this.define(`${opts.contractName}_CONTRACT_INDEX`, String(opts.contractIndex));
    this.define("CONTRACT_STATE_TYPE", opts.contractName);
    this.define("CONTRACT_STATE2_TYPE", `${opts.contractName}2`);

    // Assemble full input: qpi.h + callee prelude + contract source
    let fullSource = opts.qpiHeader;
    if (opts.calleePrelude) {
      fullSource += "\n" + opts.calleePrelude + "\n";
    }
    fullSource += "\n" + opts.source;

    // Build line offset map
    this.buildLineMap(fullSource);

    return this.process(fullSource);
  }

  define(name: string, body: string): void {
    // Parse function-like: NAME(args) body
    const m = name.match(/^(\w+)\(([^)]*)\)$/);
    if (m) {
      const macroName = m[1];
      const paramStr = m[2].trim();
      const params = paramStr ? paramStr.split(",").map((s) => s.trim()) : [];
      const isVarArgs = paramStr.endsWith("...");
      this.defines.set(macroName, { name: macroName, params, body, isVarArgs });
      return;
    }
    this.defines.set(name, { name, params: null, body, isVarArgs: false });
  }

  private buildLineMap(src: string): void {
    this.srcLine = [0];
    for (let i = 0; i < src.length; i++) {
      if (src[i] === "\n") {
        this.srcLine.push(i + 1);
      }
    }
  }

  private process(src: string): string {
    // Normalize CRLF/CR → LF so backslash line-continuations (`\` + CRLF) in multi-line macro definitions
    // join correctly — core-lite headers ship with CRLF endings.
    this.input = src.replace(/\r\n?/g, "\n");
    this.pos = 0;
    this.line = 1;
    this.result = "";
    this.expanding.clear();

    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];

      // Line directives
      if (ch === "#") {
        this.handleDirective();
        continue;
      }

      // Whitespace — pass through but track newlines
      if (ch === "\n") {
        this.result += ch;
        this.line++;
        this.pos++;
        continue;
      }

      if (ch === " " || ch === "\t" || ch === "\r") {
        this.result += ch;
        this.pos++;
        continue;
      }

      // Comment stripping
      if (ch === "/" && this.peek(1) === "/") {
        this.skipLineComment();
        continue;
      }

      if (ch === "/" && this.peek(1) === "*") {
        this.skipBlockComment();
        continue;
      }

      // Inside an inactive conditional branch: consume text without emitting/expanding.
      if (!this.condActive()) {
        if (ch === "\n") {
          this.result += "\n";
          this.line++;
        }
        this.pos++;
        continue;
      }

      // Identifier — check for macro expansion
      if (this.isIdStart(ch)) {
        const ident = this.readIdentifier();
        const expanded = this.tryExpandMacro(ident);

        if (expanded !== null) {
          this.result += expanded;
        } else {
          this.result += ident;
        }
        continue;
      }

      // Pass through everything else
      this.result += ch;
      this.pos++;
    }

    return this.result;
  }

  private handleDirective(): void {
    const start = this.pos;
    this.pos++; // skip #

    // Skip whitespace after #
    this.skipWhitespace();

    const directive = this.readIdentifier();

    // Conditional directives are always processed (to keep the stack balanced), even when inactive.
    switch (directive) {
      case "if":
        this.pushCond(this.evalIfCondition());
        return;
      case "ifdef": {
        const name = this.readDirectiveWord();
        this.skipToNewline();
        this.pushCond(this.defines.has(name));
        return;
      }
      case "ifndef": {
        const name = this.readDirectiveWord();
        this.skipToNewline();
        this.pushCond(!this.defines.has(name));
        return;
      }
      case "elif": {
        const cond = this.condStack.length > 0 && !this.condStack[this.condStack.length - 1].taken
          ? this.evalIfCondition()
          : (this.skipToNewline(), false);
        this.applyElif(cond);
        return;
      }
      case "else":
        this.skipToNewline();
        this.applyElse();
        return;
      case "endif":
        this.skipToNewline();
        this.condStack.pop();
        return;
    }

    // Non-conditional directives only act in an active branch.
    if (!this.condActive()) {
      this.skipToNewline();
      return;
    }

    switch (directive) {
      case "include":
        this.handleInclude();
        break;
      case "define":
        this.handleDefine();
        break;
      case "undef":
        this.handleUndef();
        break;
      case "pragma":
        this.handlePragma();
        break;
      case "error":
        this.skipToNewline();
        break;
      default:
        this.skipToNewline();
        break;
    }
  }

  // ---- conditional stack ----

  private pushCond(cond: boolean): void {
    const parentActive = this.condActive();
    this.condStack.push({ active: parentActive && cond, taken: parentActive && cond, parentActive });
  }

  private applyElif(cond: boolean): void {
    const f = this.condStack[this.condStack.length - 1];
    if (!f) return;
    if (f.taken) {
      f.active = false;
    } else {
      f.active = f.parentActive && cond;
      if (f.active) f.taken = true;
    }
  }

  private applyElse(): void {
    const f = this.condStack[this.condStack.length - 1];
    if (!f) return;
    f.active = f.parentActive && !f.taken;
    f.taken = true;
  }

  private readDirectiveWord(): string {
    this.skipWhitespace();
    return this.readIdentifier();
  }

  // Read the rest of the line (the #if/#elif condition), expand defined()/macros, evaluate to bool.
  private evalIfCondition(): boolean {
    const raw = this.readToNewline();
    return this.evalConstCondition(raw) !== 0n;
  }

  // Evaluate a preprocessor constant expression: defined(X), !, &&, ||, comparisons, integer literals.
  private evalConstCondition(expr: string): bigint {
    // Replace defined(X) / defined X → 1/0
    let s = expr.replace(/defined\s*\(\s*(\w+)\s*\)/g, (_m, n) => (this.defines.has(n) ? "1" : "0"));
    s = s.replace(/defined\s+(\w+)/g, (_m, n) => (this.defines.has(n) ? "1" : "0"));
    // Expand remaining identifiers: a defined macro's body if numeric, else 0.
    s = s.replace(/\b([A-Za-z_]\w*)\b/g, (_m, id) => {
      if (id === "true") return "1";
      if (id === "false") return "0";
      const def = this.defines.get(id);
      if (def && def.params === null && /^-?\d+$/.test(def.body.trim())) return def.body.trim();
      return "0";
    });
    try {
      return this.evalArith(s);
    } catch {
      return 0n;
    }
  }

  // Tiny arithmetic/logic evaluator over a string of integers and operators.
  private evalArith(s: string): bigint {
    const toks = s.match(/\d+|&&|\|\||==|!=|<=|>=|<<|>>|[()+\-*/%<>!&|]/g) ?? [];
    let i = 0;
    const peek = () => toks[i];
    const next = () => toks[i++];
    const parsePrimary = (): bigint => {
      const t = next();
      if (t === "(") { const v = parseExpr(0); next(); return v; }
      if (t === "!") return parsePrimary() === 0n ? 1n : 0n;
      if (t === "-") return -parsePrimary();
      if (t === "+") return parsePrimary();
      return BigInt(t ?? "0");
    };
    const prec: Record<string, number> = { "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5, "==": 6, "!=": 6, "<": 7, ">": 7, "<=": 7, ">=": 7, "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10 };
    const apply = (a: bigint, op: string, b: bigint): bigint => {
      switch (op) {
        case "||": return (a !== 0n || b !== 0n) ? 1n : 0n;
        case "&&": return (a !== 0n && b !== 0n) ? 1n : 0n;
        case "|": return a | b; case "^": return a ^ b; case "&": return a & b;
        case "==": return a === b ? 1n : 0n; case "!=": return a !== b ? 1n : 0n;
        case "<": return a < b ? 1n : 0n; case ">": return a > b ? 1n : 0n;
        case "<=": return a <= b ? 1n : 0n; case ">=": return a >= b ? 1n : 0n;
        case "<<": return a << b; case ">>": return a >> b;
        case "+": return a + b; case "-": return a - b;
        case "*": return a * b; case "/": return b === 0n ? 0n : a / b; case "%": return b === 0n ? 0n : a % b;
        default: return 0n;
      }
    };
    const parseExpr = (minPrec: number): bigint => {
      let left = parsePrimary();
      while (peek() && prec[peek()] !== undefined && prec[peek()] >= minPrec) {
        const op = next();
        const right = parseExpr(prec[op] + 1);
        left = apply(left, op, right);
      }
      return left;
    };
    return toks.length ? parseExpr(0) : 0n;
  }

  private handleInclude(): void {
    this.skipWhitespace();
    const ch = this.input[this.pos];

    let filename = "";
    if (ch === "\"") {
      this.pos++; // skip opening "
      while (this.pos < this.input.length && this.input[this.pos] !== "\"" && this.input[this.pos] !== "\n") {
        filename += this.input[this.pos];
        this.pos++;
      }
      if (this.input[this.pos] === "\"") {
        this.pos++; // skip closing "
      }
      this.skipToNewline();
    } else if (ch === "<") {
      this.pos++; // skip opening <
      while (this.pos < this.input.length && this.input[this.pos] !== ">" && this.input[this.pos] !== "\n") {
        filename += this.input[this.pos];
        this.pos++;
      }
      if (this.input[this.pos] === ">") {
        this.pos++; // skip closing >
      }
      this.skipToNewline();
    } else {
      this.skipToNewline();
    }

    // #include directives in preprocessed source are no-ops (qpi.h is already embedded).
    // The directive is replaced with a newline so line numbering stays consistent.
    this.result += "\n";
  }

  private handleDefine(): void {
    this.skipWhitespace();
    const name = this.readIdentifier();

    if (!name) {
      this.skipToNewline();
      return;
    }

    // Check for function-like macro: NAME(...)
    let params: string[] | null = null;
    let isVarArgs = false;

    if (this.peek(0) === "(") {
      this.pos++; // skip (
      this.skipWhitespace();
      const paramStr = this.readUntil(")");
      this.pos++; // skip )

      if (paramStr === "...") {
        params = [];
        isVarArgs = true;
      } else if (paramStr.endsWith("...")) {
        params = paramStr.replace("...", "").split(",").map((s) => s.trim()).filter(Boolean);
        isVarArgs = true;
      } else if (paramStr.trim()) {
        params = paramStr.split(",").map((s) => s.trim());
      } else {
        params = [];
      }
    }

    this.skipWhitespace();
    const body = this.readToNewline();

    this.defines.set(name, { name, params, body, isVarArgs });
    // Directive is consumed — don't add to output
  }

  private handleUndef(): void {
    this.skipWhitespace();
    const name = this.readIdentifier();
    if (name) {
      this.defines.delete(name);
    }
    this.skipToNewline();
  }

  private handlePragma(): void {
    this.skipWhitespace();
    const pragma = this.readIdentifier();
    // #pragma once — no action (we track it but the caller should ensure qpi.h is included once)
    // All other pragmas passed through
    if (pragma === "once") {
      this.skipToNewline();
    } else {
      const rest = this.readToNewline();
      this.result += `// #pragma ${pragma} ${rest}\n`;
    }
  }

  // ---- Macro expansion ----

  private tryExpandMacro(name: string): string | null {
    // __LINE__ special case
    if (name === "__LINE__") {
      return String(this.line);
    }

    const def = this.defines.get(name);
    if (!def) {
      return null;
    }

    // Object-like macro
    if (def.params === null) {
      if (this.expanding.has(name)) {
        return name; // recursion guard
      }

      // Body might have parameter references from outer scope — no args to bind.
      // For simple constants, just return the body.
      return this.expandBody(def, []);
    }

    // Function-like macro — need to read arguments
    const savePos = this.pos;
    const saveLine = this.line;

    // Expect opening paren
    this.skipWhitespaceAndNewlines();
    if (this.peek(0) !== "(") {
      this.pos = savePos;
      this.line = saveLine;
      return null; // not invoked as function-like macro
    }
    this.pos++; // skip (

    // Read arguments
    const args: string[] = [];
    let arg = "";
    let depth = 1;

    while (this.pos < this.input.length && depth > 0) {
      const ch = this.input[this.pos];

      if (ch === "(") {
        depth++;
        arg += ch;
        this.pos++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) {
          args.push(arg.trim());
          this.pos++; // skip )
          break;
        }
        arg += ch;
        this.pos++;
      } else if (ch === "," && depth === 1) {
        args.push(arg.trim());
        arg = "";
        this.pos++;
      } else if (ch === "\n") {
        this.line++;
        arg += ch;
        this.pos++;
      } else {
        arg += ch;
        this.pos++;
      }
    }

    if (this.expanding.has(name)) {
      return name; // recursion guard
    }

    return this.expandBody(def, args);
  }

  private expandBody(def: MacroDef, args: string[]): string {
    const macroName = def.name;
    this.expanding.add(macroName);

    let result = def.body;

    // Handle # (stringify) FIRST — operates on the original parameter name
    if (def.params && def.params.length > 0) {
      result = this.processStringify(result, args, def);
    }

    // Substitute parameters BEFORE ## pasting — so p##_input with p=Inc becomes Inc##_input, then paste → Inc_input
    if (def.params) {
      for (let i = 0; i < def.params.length && i < args.length; i++) {
        const param = def.params[i];
        result = this.replaceParamInBody(result, param, args[i]);
      }
      if (def.isVarArgs) {
        const extraArgs = args.slice(def.params.length);
        result = result.replace(/__VA_ARGS__/g, extraArgs.join(", "));
      }
    }

    // Handle ## (token paste) AFTER substitution — removes ## and adjacent whitespace
    result = this.processTokenPaste(result);

    // Recursively expand macros in the result
    result = this.expandRecursive(result);

    this.expanding.delete(macroName);
    return result;
  }

  // Like replaceParam but handles the case where param appears before/after ##
  private replaceParamInBody(body: string, param: string, value: string): string {
    // Replace `param` with `value` when it's a standalone word or adjacent to ##
    const escaped = this.escapeRegex(param);
    // Allow param preceded/followed by ## or non-word chars
    let result = body;
    // Replace param that's a standalone word (with optional ## on either side)
    result = result.replace(new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "g"), value);
    // Also handle param## → value## (param before ##)
    result = result.replace(new RegExp(`(?<![\\w])${escaped}##`, "g"), value + "##");
    return result;
  }

  private processTokenPaste(body: string): string {
    // Replace `a ## b` with `ab` (remove whitespace + ##)
    let result = "";
    let i = 0;

    while (i < body.length) {
      if (body[i] === "#" && body[i + 1] === "#") {
        // Found ## — trim trailing whitespace from result and skip leading whitespace after ##
        result = result.replace(/\s+$/, "");
        i += 2;
        while (i < body.length && (body[i] === " " || body[i] === "\t")) {
          i++;
        }
        continue;
      }
      result += body[i];
      i++;
    }

    return result;
  }

  private processStringify(body: string, args: string[], def: MacroDef): string {
    let result = body;
    if (def.params) {
      for (let i = 0; i < def.params.length && i < args.length; i++) {
        const param = def.params[i];
        // #param but not ##param
        result = result.replace(
          new RegExp(`(?<!#)#${this.escapeRegex(param)}\\b`, "g"),
          `"${args[i].replace(/"/g, '\\"')}"`,
        );
      }
    }
    return result;
  }

  private replaceParam(body: string, param: string, value: string): string {
    // Replace occurrences of param that are NOT part of a larger identifier or following #/##
    const escaped = this.escapeRegex(param);
    return body.replace(new RegExp(`(?<![#\\w])${escaped}(?!\\w)`, "g"), value);
  }

  // Read a function-like macro's argument list from a STRING (not the main input stream) starting at the
  // open paren. Mirrors the depth/comma splitting in tryExpandMacro. Returns null on an unbalanced list.
  private readArgsFromString(text: string, openIdx: number): { args: string[]; end: number } | null {
    if (text[openIdx] !== "(") return null;

    const args: string[] = [];
    let arg = "";
    let depth = 0;

    for (let i = openIdx; i < text.length; i++) {
      const ch = text[i];

      if (ch === "(") {
        depth++;
        if (depth === 1) continue;
        arg += ch;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) {
          args.push(arg.trim());
          return { args, end: i + 1 };
        }
        arg += ch;
      } else if (ch === "," && depth === 1) {
        args.push(arg.trim());
        arg = "";
      } else {
        arg += ch;
      }
    }

    return null;
  }

  private expandRecursive(text: string): string {
    // Re-process the expanded text to expand any macros within it
    // This is a simplified version — full recursive expansion would need a real tokenizer.
    // For qpi.h macros, one level of expansion is usually sufficient because
    // the body of a macro typically contains identifiers that are NOT macros
    // (function names, type names). Only a few patterns (like CALL_OTHER_CONTRACT_FUNCTION_E
    // containing InterContractCallError) need a second pass.
    //
    // We run 3 passes to catch common chaining patterns.
    let result = text;
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      let expanded = "";

      // Simple identifier scanning within the result text
      for (let i = 0; i < result.length; i++) {
        const ch = result[i];
        if (this.isIdStart(ch)) {
          const ident = this.readIdentAt(result, i);
          const def = this.defines.get(ident);
          if (def && def.params === null && !this.expanding.has(ident)) {
            // Object-like macro
            this.expanding.add(ident);
            expanded += this.expandBody(def, []);
            this.expanding.delete(ident);
            i += ident.length - 1;
            changed = true;
          } else if (def && def.params !== null && !this.expanding.has(ident)) {
            // Function-like macro — expand only if actually invoked (an open paren follows). A macro body
            // can contain further function-like calls (qpi.h's IMPLEMENT_* wrappers expand to nested
            // IMPLEMENT_*/PUBLIC_* calls), so the rescan must reach them, not just object-like names.
            let j = i + ident.length;
            while (j < result.length && (result[j] === " " || result[j] === "\t" || result[j] === "\n")) j++;
            const parsed = result[j] === "(" ? this.readArgsFromString(result, j) : null;
            if (parsed) {
              this.expanding.add(ident);
              expanded += this.expandBody(def, parsed.args);
              this.expanding.delete(ident);
              i = parsed.end - 1;
              changed = true;
            } else {
              expanded += ident;
              i += ident.length - 1;
            }
          } else {
            expanded += ident;
            i += ident.length - 1;
          }
        } else {
          expanded += ch;
        }
      }

      result = expanded;
      if (!changed) {
        break;
      }
    }

    return result;
  }

  private readIdentAt(text: string, start: number): string {
    let ident = "";
    let i = start;
    while (i < text.length && (this.isIdStart(text[i]) || (i > start && text[i] >= "0" && text[i] <= "9"))) {
      ident += text[i];
      i++;
    }
    return ident;
  }

  // ---- Helpers ----

  private isIdStart(ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
  }

  private readIdentifier(): string {
    let ident = "";
    while (this.pos < this.input.length && this.isIdContinue(this.input[this.pos])) {
      ident += this.input[this.pos];
      this.pos++;
    }
    return ident;
  }

  private isIdContinue(ch: string): boolean {
    return this.isIdStart(ch) || (ch >= "0" && ch <= "9");
  }

  private peek(offset: number): string {
    const i = this.pos + offset;
    if (i >= this.input.length) {
      return "\0";
    }
    return this.input[i];
  }

  private skipWhitespace(): void {
    while (this.pos < this.input.length && (this.input[this.pos] === " " || this.input[this.pos] === "\t")) {
      this.pos++;
    }
  }

  private skipWhitespaceAndNewlines(): void {
    while (this.pos < this.input.length && (this.input[this.pos] === " " || this.input[this.pos] === "\t" || this.input[this.pos] === "\n" || this.input[this.pos] === "\r")) {
      if (this.input[this.pos] === "\n") {
        this.line++;
        this.result += "\n";
      }
      this.pos++;
    }
  }

  private readToNewline(): string {
    let text = "";
    while (this.pos < this.input.length && this.input[this.pos] !== "\n") {
      // Handle backslash-newline continuation
      if (this.input[this.pos] === "\\" && this.peek(1) === "\n") {
        this.pos += 2;
        this.line++;
        continue;
      }
      text += this.input[this.pos];
      this.pos++;
    }
    if (this.input[this.pos] === "\n") {
      this.pos++;
      this.line++;
    }
    return text.trim();
  }

  private skipToNewline(): void {
    while (this.pos < this.input.length && this.input[this.pos] !== "\n") {
      this.pos++;
    }
    if (this.input[this.pos] === "\n") {
      this.pos++;
      this.line++;
    }
  }

  private readUntil(stop: string): string {
    let text = "";
    while (this.pos < this.input.length && this.input[this.pos] !== stop && this.input[this.pos] !== "\n") {
      text += this.input[this.pos];
      this.pos++;
    }
    return text;
  }

  private skipLineComment(): void {
    while (this.pos < this.input.length && this.input[this.pos] !== "\n") {
      this.pos++;
    }
  }

  private skipBlockComment(): void {
    this.pos += 2; // skip /*
    while (this.pos < this.input.length) {
      if (this.input[this.pos] === "\n") {
        this.result += "\n";
        this.line++;
        this.pos++;
      } else if (this.input[this.pos] === "*" && this.peek(1) === "/") {
        this.pos += 2; // skip */
        return;
      } else {
        this.pos++;
      }
    }
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

// Export a convenience function that embeds the qpi.h content
export function createQpiHeader(corePath: string): string {
  // This will be replaced at build time or the caller provides the content.
  // For now, provide a minimal stub — the real qpi.h content is loaded by the compiler host.
  return `// qpi.h stub — real content injected by compiler host
`;
}
