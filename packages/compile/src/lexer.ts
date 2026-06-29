// C++ lexer for the QPI subset. Produces a token stream consumed by the parser.
// Handles: keywords, identifiers, integer/char/string literals, operators, comments.
// Does NOT handle preprocessor directives — those are resolved by preprocess.ts first.

export type TokenKind =
  // Keywords
  | "kw_asm" | "kw_auto" | "kw_bool" | "kw_break" | "kw_case" | "kw_char" | "kw_class"
  | "kw_const" | "kw_constexpr" | "kw_continue" | "kw_default" | "kw_delete" | "kw_do"
  | "kw_double" | "kw_else" | "kw_enum" | "kw_extern" | "kw_false" | "kw_float" | "kw_for"
  | "kw_friend" | "kw_goto" | "kw_if" | "kw_inline" | "kw_int" | "kw_long" | "kw_namespace"
  | "kw_noexcept" | "kw_nullptr" | "kw_operator" | "kw_override" | "kw_private"
  | "kw_protected" | "kw_public" | "kw_return" | "kw_short" | "kw_signed" | "kw_sizeof"
  | "kw_static" | "kw_static_assert" | "kw_struct" | "kw_switch" | "kw_template"
  | "kw_this" | "kw_true" | "kw_typedef" | "kw_typename" | "kw_union" | "kw_unsigned"
  | "kw_using" | "kw_virtual" | "kw_void" | "kw_volatile" | "kw_while"
  // Compound type keywords (multi-word)
  | "kw_signed_char" | "kw_unsigned_char"
  | "kw_signed_short" | "kw_unsigned_short"
  | "kw_signed_int" | "kw_unsigned_int"
  | "kw_signed_long_long" | "kw_unsigned_long_long"
  | "kw_long_long"
  // Literals
  | "int_literal" | "float_literal" | "char_literal" | "string_literal"
  // Identifiers
  | "identifier"
  // Operators and punctuators
  | "l_brace" | "r_brace"        // { }
  | "l_paren" | "r_paren"        // ( )
  | "l_bracket" | "r_bracket"    // [ ]
  | "l_angle" | "r_angle"        // < > (also template angle brackets)
  | "semicolon"                   // ;
  | "colon" | "d_colon"          // : ::
  | "comma"                       // ,
  | "dot" | "dot_star"           // . .*
  | "arrow" | "arrow_star"       // -> ->*
  | "ellipsis"                    // ...
  | "hash" | "d_hash"            // # ##
  // Assignment
  | "eq"                          // =
  | "plus_eq" | "minus_eq" | "star_eq" | "slash_eq" | "percent_eq"
  | "l_shift_eq" | "r_shift_eq" | "amp_eq" | "pipe_eq" | "caret_eq"
  // Arithmetic
  | "plus" | "minus" | "star" | "slash" | "percent"
  // Increment/decrement
  | "plus_plus" | "minus_minus"
  // Comparison
  | "eq_eq" | "not_eq" | "lt" | "gt" | "lt_eq" | "gt_eq"
  | "spaceship"                   // <=>
  // Logical
  | "amp_amp" | "pipe_pipe" | "bang"
  // Bitwise
  | "amp" | "pipe" | "caret" | "tilde"
  // Shift
  | "l_shift" | "r_shift"
  // Other
  | "question"                    // ?
  | "eof";

export interface Token {
  kind: TokenKind;
  text: string;                  // raw source text
  span: Span;
}

// Re-use Span from ast.ts
import type { Span } from "./ast";

// ---- Keyword map ----

const KEYWORDS: Record<string, TokenKind> = {
  "asm": "kw_asm",
  "auto": "kw_auto",
  "bool": "kw_bool",
  "break": "kw_break",
  "case": "kw_case",
  "char": "kw_char",
  "class": "kw_class",
  "const": "kw_const",
  "constexpr": "kw_constexpr",
  "continue": "kw_continue",
  "default": "kw_default",
  "delete": "kw_delete",
  "do": "kw_do",
  "double": "kw_double",
  "else": "kw_else",
  "enum": "kw_enum",
  "extern": "kw_extern",
  "false": "kw_false",
  "float": "kw_float",
  "for": "kw_for",
  "friend": "kw_friend",
  "goto": "kw_goto",
  "if": "kw_if",
  "inline": "kw_inline",
  "int": "kw_int",
  "long": "kw_long",
  "namespace": "kw_namespace",
  "noexcept": "kw_noexcept",
  "nullptr": "kw_nullptr",
  "operator": "kw_operator",
  "override": "kw_override",
  "private": "kw_private",
  "protected": "kw_protected",
  "public": "kw_public",
  "return": "kw_return",
  "short": "kw_short",
  "signed": "kw_signed",
  "sizeof": "kw_sizeof",
  "static": "kw_static",
  "static_assert": "kw_static_assert",
  "struct": "kw_struct",
  "switch": "kw_switch",
  "template": "kw_template",
  "this": "kw_this",
  "true": "kw_true",
  "typedef": "kw_typedef",
  "typename": "kw_typename",
  "union": "kw_union",
  "unsigned": "kw_unsigned",
  "using": "kw_using",
  "virtual": "kw_virtual",
  "void": "kw_void",
  "volatile": "kw_volatile",
  "while": "kw_while",
};

// Multi-word type keywords formed by consecutive single keywords
const TYPE_COMPOUNDS: [TokenKind[], TokenKind][] = [
  [["kw_signed", "kw_char"], "kw_signed_char"],
  [["kw_unsigned", "kw_char"], "kw_unsigned_char"],
  [["kw_signed", "kw_short"], "kw_signed_short"],
  [["kw_unsigned", "kw_short"], "kw_unsigned_short"],
  [["kw_signed", "kw_int"], "kw_signed_int"],
  [["kw_unsigned", "kw_int"], "kw_unsigned_int"],
  [["kw_signed", "kw_long", "kw_long"], "kw_signed_long_long"],
  [["kw_unsigned", "kw_long", "kw_long"], "kw_unsigned_long_long"],
  [["kw_long", "kw_long"], "kw_long_long"],
];

export function isTypeKeyword(kind: TokenKind): boolean {
  return kind === "kw_void" || kind === "kw_bool" || kind === "kw_char"
    || kind === "kw_short" || kind === "kw_int" || kind === "kw_long"
    || kind === "kw_signed" || kind === "kw_unsigned"
    || kind === "kw_signed_char" || kind === "kw_unsigned_char"
    || kind === "kw_signed_short" || kind === "kw_unsigned_short"
    || kind === "kw_signed_int" || kind === "kw_unsigned_int"
    || kind === "kw_signed_long_long" || kind === "kw_unsigned_long_long"
    || kind === "kw_long_long"
    || kind === "kw_double" || kind === "kw_float";
}

// ---- Lexer ----

export class Lexer {
  private src: string;
  private pos: number = 0;
  private line: number = 1;
  private col: number = 1;
  private tokens: Token[] = [];
  private index: number = 0;

  constructor(src: string) {
    this.src = src;
  }

  // Tokenize the entire source and return an array. Also collapses multi-word type keywords.
  tokenize(): Token[] {
    this.tokens = [];

    while (!this.eof()) {
      const tok = this.nextToken();
      if (tok) {
        this.tokens.push(tok);
      }
    }

    this.tokens.push({ kind: "eof", text: "", span: this.span() });
    this.collapseTypeKeywords();
    return this.tokens;
  }

  // Get the token stream (for parser)
  getTokens(): Token[] {
    return this.tokens;
  }

  // Reset for streaming parse
  reset(): void {
    this.index = 0;
  }

  // Streaming interface
  peek(offset: number = 0): Token {
    const i = this.index + offset;
    if (i >= this.tokens.length) {
      return this.tokens[this.tokens.length - 1]; // eof
    }
    return this.tokens[i];
  }

  next(): Token {
    const tok = this.peek();
    this.index++;
    return tok;
  }

  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  private span(): Span {
    return { start: this.pos, end: this.pos, line: this.line, col: this.col };
  }

  private makeSpan(start: number, startLine: number, startCol: number): Span {
    return { start, end: this.pos, line: startLine, col: startCol };
  }

  private peekChar(offset: number = 0): string {
    const i = this.pos + offset;
    if (i >= this.src.length) {
      return "\0";
    }
    return this.src[i];
  }

  private advance(): string {
    const ch = this.src[this.pos];
    this.pos++;
    if (ch === "\n") {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return ch;
  }

  private nextToken(): Token | null {
    // Skip whitespace and comments
    while (!this.eof()) {
      const ch = this.peekChar();
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        this.advance();
        continue;
      }
      if (ch === "/") {
        const next = this.peekChar(1);
        if (next === "/") {
          this.skipLineComment();
          continue;
        }
        if (next === "*") {
          this.skipBlockComment();
          continue;
        }
      }
      break;
    }

    if (this.eof()) {
      return null;
    }

    const start = this.pos;
    const startLine = this.line;
    const startCol = this.col;
    const ch = this.peekChar();

    // Identifiers and keywords
    if (this.isIdStart(ch)) {
      return this.lexIdOrKeyword(start, startLine, startCol);
    }

    // Numbers
    if (ch >= "0" && ch <= "9") {
      return this.lexNumber(start, startLine, startCol);
    }

    // Character literal
    if (ch === "'") {
      return this.lexCharLiteral(start, startLine, startCol);
    }

    // String literal
    if (ch === "\"") {
      return this.lexStringLiteral(start, startLine, startCol);
    }

    // Operators and punctuators
    return this.lexOperator(start, startLine, startCol);
  }

  private isIdStart(ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
  }

  private isIdContinue(ch: string): boolean {
    return this.isIdStart(ch) || (ch >= "0" && ch <= "9");
  }

  private lexIdOrKeyword(start: number, startLine: number, startCol: number): Token {
    let text = "";
    while (!this.eof() && this.isIdContinue(this.peekChar())) {
      text += this.advance();
    }

    const kw = KEYWORDS[text];
    const kind: TokenKind = kw ?? "identifier";

    return { kind, text, span: this.makeSpan(start, startLine, startCol) };
  }

  private lexNumber(start: number, startLine: number, startCol: number): Token {
    let text = "";
    let isFloat = false;

    // Check for hex (0x / 0X) or binary (0b / 0B)
    if (this.peekChar() === "0") {
      text += this.advance();
      const next = this.peekChar().toLowerCase();
      if (next === "x") {
        text += this.advance();
        while (!this.eof() && this.isHexDigit(this.peekChar())) {
          text += this.advance();
        }
        return { kind: "int_literal", text, span: this.makeSpan(start, startLine, startCol) };
      }
      if (next === "b") {
        text += this.advance();
        while (!this.eof() && (this.peekChar() === "0" || this.peekChar() === "1")) {
          text += this.advance();
        }
        return { kind: "int_literal", text, span: this.makeSpan(start, startLine, startCol) };
      }
    }

    // Decimal number (might be float)
    while (!this.eof()) {
      const ch = this.peekChar();
      if (ch >= "0" && ch <= "9") {
        text += this.advance();
      } else if (ch === "." && this.peekChar(1) >= "0" && this.peekChar(1) <= "9") {
        isFloat = true;
        text += this.advance(); // .
      } else {
        break;
      }
    }

    // Integer suffix: u, l, ll, ul, ull, lu, llu
    if (!isFloat && !this.eof()) {
      const suf = this.peekSuffix();
      if (suf) {
        text += suf;
      }
    }

    if (isFloat) {
      return { kind: "float_literal", text, span: this.makeSpan(start, startLine, startCol) };
    }

    return { kind: "int_literal", text, span: this.makeSpan(start, startLine, startCol) };
  }

  private peekSuffix(): string {
    const rest = this.src.slice(this.pos, this.pos + 4).toLowerCase();
    // ull, llu
    if (rest.startsWith("ull")) { return this.advanceN(3); }
    if (rest.startsWith("llu")) { return this.advanceN(3); }
    // ul, lu, ll
    if (rest.startsWith("ul")) { return this.advanceN(2); }
    if (rest.startsWith("lu")) { return this.advanceN(2); }
    if (rest.startsWith("ll")) { return this.advanceN(2); }
    // u, l
    if (rest[0] === "u" || rest[0] === "l") { return this.advanceN(1); }
    return "";
  }

  private advanceN(n: number): string {
    let text = "";
    for (let i = 0; i < n && !this.eof(); i++) {
      text += this.advance();
    }
    return text;
  }

  private isHexDigit(ch: string): boolean {
    return (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
  }

  private lexCharLiteral(start: number, startLine: number, startCol: number): Token {
    let text = "";
    text += this.advance(); // opening '

    while (!this.eof()) {
      const ch = this.peekChar();
      if (ch === "\\") {
        text += this.advance(); // backslash
        if (!this.eof()) {
          text += this.advance(); // escaped char
        }
      } else if (ch === "'") {
        text += this.advance(); // closing '
        break;
      } else if (ch === "\n") {
        break; // unterminated
      } else {
        text += this.advance();
      }
    }

    return { kind: "char_literal", text, span: this.makeSpan(start, startLine, startCol) };
  }

  private lexStringLiteral(start: number, startLine: number, startCol: number): Token {
    let text = "";
    text += this.advance(); // opening "

    while (!this.eof()) {
      const ch = this.peekChar();
      if (ch === "\\") {
        text += this.advance();
        if (!this.eof()) {
          text += this.advance();
        }
      } else if (ch === "\"") {
        text += this.advance();
        break;
      } else if (ch === "\n") {
        break; // unterminated
      } else {
        text += this.advance();
      }
    }

    return { kind: "string_literal", text, span: this.makeSpan(start, startLine, startCol) };
  }

  private lexOperator(start: number, startLine: number, startCol: number): Token {
    const ch = this.advance();
    const next = this.peekChar();

    const mk = (kind: TokenKind): Token => ({ kind, text: ch, span: this.makeSpan(start, startLine, startCol) });
    const mk2 = (kind: TokenKind, ch2: string): Token => {
      this.advance();
      return { kind, text: ch + ch2, span: this.makeSpan(start, startLine, startCol) };
    };
    const mk3 = (kind: TokenKind, ch2: string, ch3: string): Token => {
      this.advance();
      this.advance();
      return { kind, text: ch + ch2 + ch3, span: this.makeSpan(start, startLine, startCol) };
    };

    switch (ch) {
      case "{": return mk("l_brace");
      case "}": return mk("r_brace");
      case "(": return mk("l_paren");
      case ")": return mk("r_paren");
      case "[": return mk("l_bracket");
      case "]": return mk("r_bracket");
      case ";": return mk("semicolon");
      case ":": return next === ":" ? mk2("d_colon", ":") : mk("colon");
      case ",": return mk("comma");
      case "?": return mk("question");
      case "~": return mk("tilde");

      case ".":
        if (next === "*") {
          return mk2("dot_star", "*");
        }
        if (next === "." && this.peekChar(2) === ".") {
          return mk3("ellipsis", ".", ".");
        }
        return mk("dot");

      case "+":
        if (next === "=") { return mk2("plus_eq", "="); }
        if (next === "+") { return mk2("plus_plus", "+"); }
        return mk("plus");

      case "-":
        if (next === "=") { return mk2("minus_eq", "="); }
        if (next === "-") { return mk2("minus_minus", "-"); }
        if (next === ">") {
          const after = this.peekChar(1);
          if (after === "*") { return mk3("arrow_star", ">", "*"); }
          return mk2("arrow", ">");
        }
        return mk("minus");

      case "*":
        if (next === "=") { return mk2("star_eq", "="); }
        return mk("star");

      case "/":
        if (next === "=") { return mk2("slash_eq", "="); }
        return mk("slash");

      case "%":
        if (next === "=") { return mk2("percent_eq", "="); }
        return mk("percent");

      case "=":
        if (next === "=") { return mk2("eq_eq", "="); }
        return mk("eq");

      case "!":
        if (next === "=") { return mk2("not_eq", "="); }
        return mk("bang");

      case "<":
        if (next === "=") {
          const after = this.peekChar(1);
          if (after === ">") { return mk3("spaceship", "=", ">"); }
          return mk2("lt_eq", "=");
        }
        if (next === "<") {
          const after = this.peekChar(1);
          if (after === "=") { return mk3("l_shift_eq", "<", "="); }
          return mk2("l_shift", "<");
        }
        return mk("l_angle");

      case ">":
        if (next === "=") { return mk2("gt_eq", "="); }
        if (next === ">") {
          const after = this.peekChar(1);
          if (after === "=") { return mk3("r_shift_eq", ">", "="); }
          return mk2("r_shift", ">");
        }
        return mk("r_angle");

      case "&":
        if (next === "=") { return mk2("amp_eq", "="); }
        if (next === "&") { return mk2("amp_amp", "&"); }
        return mk("amp");

      case "|":
        if (next === "=") { return mk2("pipe_eq", "="); }
        if (next === "|") { return mk2("pipe_pipe", "|"); }
        return mk("pipe");

      case "^":
        if (next === "=") { return mk2("caret_eq", "="); }
        return mk("caret");

      case "#":
        if (next === "#") { return mk2("d_hash", "#"); }
        return mk("hash");

      default:
        // Unknown character — skip it but emit as identifier for error recovery
        return { kind: "identifier", text: ch, span: this.makeSpan(start, startLine, startCol) };
    }
  }

  private skipLineComment(): void {
    while (!this.eof() && this.peekChar() !== "\n") {
      this.advance();
    }
  }

  private skipBlockComment(): void {
    this.advance(); // *
    while (!this.eof()) {
      if (this.peekChar() === "*" && this.peekChar(1) === "/") {
        this.advance(); // *
        this.advance(); // /
        return;
      }
      this.advance();
    }
  }

  // Collapse multi-word type keywords like "signed long long" → "kw_signed_long_long"
  private collapseTypeKeywords(): void {
    const result: Token[] = [];
    let i = 0;

    while (i < this.tokens.length) {
      let collapsed = false;

      for (const [seq, compound] of TYPE_COMPOUNDS) {
        let match = true;
        for (let j = 0; j < seq.length; j++) {
          if (i + j >= this.tokens.length || this.tokens[i + j].kind !== seq[j]) {
            match = false;
            break;
          }
        }

        if (match) {
          const startTok = this.tokens[i];
          const endTok = this.tokens[i + seq.length - 1];
          const text = this.tokens.slice(i, i + seq.length).map((t) => t.text).join(" ");
          result.push({
            kind: compound,
            text,
            span: { start: startTok.span.start, end: endTok.span.end, line: startTok.span.line, col: startTok.span.col },
          });
          i += seq.length;
          collapsed = true;
          break;
        }
      }

      if (!collapsed) {
        result.push(this.tokens[i]);
        i++;
      }
    }

    this.tokens = result;
    this.index = 0;
  }
}

// Parse an integer literal value (handles 0x, 0b, 0 prefixes and suffixes)
export function parseIntLiteral(text: string): bigint {
  let s = text.toLowerCase();
  let base: number;

  // Strip suffix
  s = s.replace(/(ull?|ll?u?|u|l)$/, "");

  if (s.startsWith("0x")) {
    base = 16;
    s = s.slice(2);
  } else if (s.startsWith("0b")) {
    base = 2;
    s = s.slice(2);
  } else if (s.startsWith("0") && s.length > 1 && !s.includes(".")) {
    base = 8;
    s = s.slice(1);
  } else {
    base = 10;
  }

  try {
    return BigInt(`0${s}`.replace(/^0+/, "0") || "0"); // fallback
  } catch {
    // Use manual conversion for large values
    let val = 0n;
    for (const ch of s) {
      const digit = ch >= "a" ? (ch.charCodeAt(0) - 87) : (ch.charCodeAt(0) - 48);
      if (digit >= base) {
        break;
      }
      val = val * BigInt(base) + BigInt(digit);
    }
    return val;
  }
}
