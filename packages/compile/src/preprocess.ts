// C preprocessor for QPI subset. Operates on text, not tokens.

export interface PreprocessOptions {
  source: string; // contract source
  qpiHeader: string; // preprocessed qpi.h content (all #includes resolved)
  contractName: string;
  contractIndex: number;
  calleePrelude?: string; // inter-contract callee type headers
  seedMacros?: Map<string, MacroDef>; // pre-built macro table (from qpi.h) to start from
}

export interface MacroDef {
  name: string;
  params: string[] | null; // null = object-like, [] = function-like with no params
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
  private srcLine: number[]; // line → byte offset map
  // Conditional-compilation stack. Each frame: whether this branch is emitting, and whether any
  private condStack: { active: boolean; taken: boolean; parentActive: boolean }[] = [];

  constructor() {
    this.srcLine = [];
  }

  private condActive(): boolean {
    for (const condStackItem of this.condStack) {
      if (!condStackItem.active) return false;
    }
    return true;
  }

  // The macro table after a run — used to capture qpi.h's #defines for reuse on user source.
  getDefines(): Map<string, MacroDef> {
    return new Map(this.defines);
  }

  preprocess(options: PreprocessOptions): string {
    this.defines.clear();
    this.condStack = [];

    if (options.seedMacros) {
      for (const [k, v] of options.seedMacros) this.defines.set(k, v);
    }

    // Built-in defines
    this.define("__LINE__", "__LINE__"); // special-cased during expansion
    this.define("LITE_WASM_TU_BUILD", "");
    this.define("LITEDYN_CONTRACT_TU", "");

    // Contract-specific defines
    this.define("CONTRACT_INDEX", String(options.contractIndex));
    this.define(`${options.contractName}_CONTRACT_INDEX`, String(options.contractIndex));
    this.define("CONTRACT_STATE_TYPE", options.contractName);
    this.define("CONTRACT_STATE2_TYPE", `${options.contractName}2`);

    // Assemble full input: qpi.h + callee prelude + contract source
    let fullSource = options.qpiHeader;
    if (options.calleePrelude) {
      fullSource += "\n" + options.calleePrelude + "\n";
    }
    fullSource += "\n" + options.source;

    // Build line offset map
    this.buildLineMap(fullSource);

    return this.process(fullSource);
  }

  define(name: string, body: string): void {
    // Parse function-like: NAME(args) body
    const member = name.match(/^(\w+)\(([^)]*)\)$/);
    if (member) {
      const macroName = member[1];
      const paramStr = member[2].trim();
      const params = paramStr ? paramStr.split(",").map((text) => text.trim()) : [];
      const isVarArgs = paramStr.endsWith("...");
      this.defines.set(macroName, { name: macroName, params, body, isVarArgs });
      return;
    }
    this.defines.set(name, { name, params: null, body, isVarArgs: false });
  }

  private buildLineMap(src: string): void {
    this.srcLine = [0];
    for (let srcItemIndex = 0; srcItemIndex < src.length; srcItemIndex++) {
      if (src[srcItemIndex] === "\n") {
        this.srcLine.push(srcItemIndex + 1);
      }
    }
  }

  private process(src: string): string {
    // Normalize CRLF/CR → LF so backslash line-continuations (`\` + CRLF) in multi-line macro definitions join correctly — core-lite
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
        const condition =
          this.condStack.length > 0 && !this.condStack[this.condStack.length - 1].taken
            ? this.evalIfCondition()
            : (this.skipToNewline(), false);
        this.applyElif(condition);
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

  private pushCond(condition: boolean): void {
    const parentActive = this.condActive();
    this.condStack.push({
      active: parentActive && condition,
      taken: parentActive && condition,
      parentActive,
    });
  }

  private applyElif(condition: boolean): void {
    const condStackItem = this.condStack[this.condStack.length - 1];
    if (!condStackItem) return;
    if (condStackItem.taken) {
      condStackItem.active = false;
    } else {
      condStackItem.active = condStackItem.parentActive && condition;
      if (condStackItem.active) condStackItem.taken = true;
    }
  }

  private applyElse(): void {
    const condStackItem = this.condStack[this.condStack.length - 1];
    if (!condStackItem) return;
    condStackItem.active = condStackItem.parentActive && !condStackItem.taken;
    condStackItem.taken = true;
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
  private evalConstCondition(expression: string): bigint {
    // Replace defined(X) / defined X → 1/0
    let text = expression.replace(/defined\s*\(\s*(\w+)\s*\)/g, (_m, exprItemIndex) =>
      this.defines.has(exprItemIndex) ? "1" : "0",
    );
    text = text.replace(/defined\s+(\w+)/g, (_m, sItemIndex) => (this.defines.has(sItemIndex) ? "1" : "0"));
    // Expand remaining identifiers: a defined macro's body if numeric, else 0.
    text = text.replace(/\b([A-Za-z_]\w*)\b/g, (_m, id) => {
      if (id === "true") return "1";
      if (id === "false") return "0";
      const def = this.defines.get(id);
      if (def && def.params === null && /^-?\d+$/.test(def.body.trim())) return def.body.trim();
      return "0";
    });
    try {
      return this.evalArith(text);
    } catch {
      return 0n;
    }
  }

  // Tiny arithmetic/logic evaluator over a string of integers and operators.
  private evalArith(text: string): bigint {
    const toks = text.match(/\d+|&&|\|\||==|!=|<=|>=|<<|>>|[()+\-*/%<>!&|^]/g) ?? [];
    let index = 0;
    const peek = () => toks[index];
    const next = () => toks[index++];
    const parsePrimary = (): bigint => {
      const text = next();
      if (text === "(") {
        const numericValue = parseExpr(0);
        next();
        return numericValue;
      }
      if (text === "!") return parsePrimary() === 0n ? 1n : 0n;
      if (text === "-") return -parsePrimary();
      if (text === "+") return parsePrimary();
      return BigInt(text ?? "0");
    };
    const prec: Record<string, number> = {
      "||": 1,
      "&&": 2,
      "|": 3,
      "^": 4,
      "&": 5,
      "==": 6,
      "!=": 6,
      "<": 7,
      ">": 7,
      "<=": 7,
      ">=": 7,
      "<<": 8,
      ">>": 8,
      "+": 9,
      "-": 9,
      "*": 10,
      "/": 10,
      "%": 10,
    };
    const apply = (numericValue: bigint, operator: string, numericValueCandidate: bigint): bigint => {
      switch (operator) {
        case "||":
          return numericValue !== 0n || numericValueCandidate !== 0n ? 1n : 0n;
        case "&&":
          return numericValue !== 0n && numericValueCandidate !== 0n ? 1n : 0n;
        case "|":
          return numericValue | numericValueCandidate;
        case "^":
          return numericValue ^ numericValueCandidate;
        case "&":
          return numericValue & numericValueCandidate;
        case "==":
          return numericValue === numericValueCandidate ? 1n : 0n;
        case "!=":
          return numericValue !== numericValueCandidate ? 1n : 0n;
        case "<":
          return numericValue < numericValueCandidate ? 1n : 0n;
        case ">":
          return numericValue > numericValueCandidate ? 1n : 0n;
        case "<=":
          return numericValue <= numericValueCandidate ? 1n : 0n;
        case ">=":
          return numericValue >= numericValueCandidate ? 1n : 0n;
        case "<<":
          return numericValue << numericValueCandidate;
        case ">>":
          return numericValue >> numericValueCandidate;
        case "+":
          return numericValue + numericValueCandidate;
        case "-":
          return numericValue - numericValueCandidate;
        case "*":
          return numericValue * numericValueCandidate;
        case "/":
          return numericValueCandidate === 0n ? 0n : numericValue / numericValueCandidate;
        case "%":
          return numericValueCandidate === 0n ? 0n : numericValue % numericValueCandidate;
        default:
          return 0n;
      }
    };
    const parseExpr = (minPrec: number): bigint => {
      let left = parsePrimary();
      while (peek() && prec[peek()] !== undefined && prec[peek()] >= minPrec) {
        const operator = next();
        const right = parseExpr(prec[operator] + 1);
        left = apply(left, operator, right);
      }
      return left;
    };
    return toks.length ? parseExpr(0) : 0n;
  }

  private handleInclude(): void {
    this.skipWhitespace();
    const ch = this.input[this.pos];

    let filename = "";
    if (ch === '"') {
      this.pos++; // skip opening "
      while (
        this.pos < this.input.length &&
        this.input[this.pos] !== '"' &&
        this.input[this.pos] !== "\n"
      ) {
        filename += this.input[this.pos];
        this.pos++;
      }
      if (this.input[this.pos] === '"') {
        this.pos++; // skip closing "
      }
      this.skipToNewline();
    } else if (ch === "<") {
      this.pos++; // skip opening <
      while (
        this.pos < this.input.length &&
        this.input[this.pos] !== ">" &&
        this.input[this.pos] !== "\n"
      ) {
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
        params = paramStr
          .replace("...", "")
          .split(",")
          .map((text) => text.trim())
          .filter(Boolean);
        isVarArgs = true;
      } else if (paramStr.trim()) {
        params = paramStr.split(",").map((text) => text.trim());
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
    // #pragma once — no action (we track it but the caller should ensure qpi.h is included once) All
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
    const callArguments: string[] = [];
    let argument = "";
    let depth = 1;

    while (this.pos < this.input.length && depth > 0) {
      const ch = this.input[this.pos];

      if (ch === "(") {
        depth++;
        argument += ch;
        this.pos++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) {
          callArguments.push(argument.trim());
          this.pos++; // skip )
          break;
        }
        argument += ch;
        this.pos++;
      } else if (ch === "," && depth === 1) {
        callArguments.push(argument.trim());
        argument = "";
        this.pos++;
      } else if (ch === "\n") {
        this.line++;
        argument += ch;
        this.pos++;
      } else {
        argument += ch;
        this.pos++;
      }
    }

    if (this.expanding.has(name)) {
      return name; // recursion guard
    }

    return this.expandBody(def, callArguments);
  }

  private expandBody(def: MacroDef, callArguments: string[]): string {
    const macroName = def.name;
    this.expanding.add(macroName);

    let result = def.body;

    // Handle # (stringify) FIRST — operates on the original parameter name
    if (def.params && def.params.length > 0) {
      result = this.processStringify(result, callArguments, def);
    }

    // Substitute parameters BEFORE ## pasting — so p##_input with p=Inc becomes Inc##_input, then paste → Inc_input
    if (def.params) {
      for (let index = 0; index < def.params.length && index < callArguments.length; index++) {
        const param = def.params[index];
        result = this.replaceParamInBody(result, param, callArguments[index]);
      }
      if (def.isVarArgs) {
        const extraArgs = callArguments.slice(def.params.length);
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
    let index = 0;

    while (index < body.length) {
      if (body[index] === "#" && body[index + 1] === "#") {
        // Found ## — trim trailing whitespace from result and skip leading whitespace after ##
        result = result.replace(/\s+$/, "");
        index += 2;
        while (index < body.length && (body[index] === " " || body[index] === "\t")) {
          index++;
        }
        continue;
      }
      result += body[index];
      index++;
    }

    return result;
  }

  private processStringify(body: string, callArguments: string[], def: MacroDef): string {
    let result = body;
    if (def.params) {
      for (let index = 0; index < def.params.length && index < callArguments.length; index++) {
        const param = def.params[index];
        // #param but not ##param
        result = result.replace(
          new RegExp(`(?<!#)#${this.escapeRegex(param)}\\b`, "g"),
          `"${callArguments[index].replace(/"/g, '\\"')}"`,
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

  // Read a function-like macro's argument list from a STRING (not the main input stream) starting at the open
  private readArgsFromString(
    text: string,
    openIdx: number,
  ): { callArguments: string[]; end: number } | null {
    if (text[openIdx] !== "(") return null;

    const callArguments: string[] = [];
    let argument = "";
    let depth = 0;

    for (let textItemIndex = openIdx; textItemIndex < text.length; textItemIndex++) {
      const ch = text[textItemIndex];

      if (ch === "(") {
        depth++;
        if (depth === 1) continue;
        argument += ch;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) {
          callArguments.push(argument.trim());
          return { callArguments, end: textItemIndex + 1 };
        }
        argument += ch;
      } else if (ch === "," && depth === 1) {
        callArguments.push(argument.trim());
        argument = "";
      } else {
        argument += ch;
      }
    }

    return null;
  }

  private expandRecursive(text: string): string {
    // Rescan expanded text to expand nested macro references.
    let result = text;
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      let expanded = "";

      // Simple identifier scanning within the result text
      for (let resultItemIndex = 0; resultItemIndex < result.length; resultItemIndex++) {
        const ch = result[resultItemIndex];
        if (this.isIdStart(ch)) {
          const ident = this.readIdentAt(result, resultItemIndex);
          const def = this.defines.get(ident);
          if (def && def.params === null && !this.expanding.has(ident)) {
            // Object-like macro
            this.expanding.add(ident);
            expanded += this.expandBody(def, []);
            this.expanding.delete(ident);
            resultItemIndex += ident.length - 1;
            changed = true;
          } else if (def && def.params !== null && !this.expanding.has(ident)) {
            // Function-like macro — expand only if actually invoked (an open paren follows). A macro body
            let nestedIndex = resultItemIndex + ident.length;
            while (
              nestedIndex < result.length &&
              (result[nestedIndex] === " " || result[nestedIndex] === "\t" || result[nestedIndex] === "\n")
            )
              nestedIndex++;
            const parsed = result[nestedIndex] === "(" ? this.readArgsFromString(result, nestedIndex) : null;
            if (parsed) {
              this.expanding.add(ident);
              expanded += this.expandBody(def, parsed.callArguments);
              this.expanding.delete(ident);
              resultItemIndex = parsed.end - 1;
              changed = true;
            } else {
              expanded += ident;
              resultItemIndex += ident.length - 1;
            }
          } else {
            expanded += ident;
            resultItemIndex += ident.length - 1;
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
    let cursor = start;
    while (
      cursor < text.length &&
      (this.isIdStart(text[cursor]) ||
        (cursor > start && text[cursor] >= "0" && text[cursor] <= "9"))
    ) {
      ident += text[cursor];
      cursor++;
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
    const index = this.pos + offset;
    if (index >= this.input.length) {
      return "\0";
    }
    return this.input[index];
  }

  private skipWhitespace(): void {
    while (
      this.pos < this.input.length &&
      (this.input[this.pos] === " " || this.input[this.pos] === "\t")
    ) {
      this.pos++;
    }
  }

  private skipWhitespaceAndNewlines(): void {
    while (
      this.pos < this.input.length &&
      (this.input[this.pos] === " " ||
        this.input[this.pos] === "\t" ||
        this.input[this.pos] === "\n" ||
        this.input[this.pos] === "\r")
    ) {
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
    while (
      this.pos < this.input.length &&
      this.input[this.pos] !== stop &&
      this.input[this.pos] !== "\n"
    ) {
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

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

// Export a convenience function that embeds the qpi.h content
export function createQpiHeader(corePath: string): string {
  // This will be replaced at build time or the caller provides the content.
  return `// qpi.h stub — real content injected by compiler host
`;
}
