import type { Span } from "../../ast";

// C++ lexer for the QPI subset. Produces a token stream consumed by the parser.
export type TokenKind = 
// Keywords
"kw_asm" | "kw_auto" | "kw_bool" | "kw_break" | "kw_case" | "kw_char" | "kw_class" | "kw_const" | "kw_constexpr" | "kw_continue" | "kw_default" | "kw_delete" | "kw_do" | "kw_double" | "kw_else" | "kw_enum" | "kw_extern" | "kw_false" | "kw_float" | "kw_for" | "kw_friend" | "kw_goto" | "kw_if" | "kw_inline" | "kw_int" | "kw_long" | "kw_namespace" | "kw_noexcept" | "kw_nullptr" | "kw_operator" | "kw_override" | "kw_private" | "kw_protected" | "kw_public" | "kw_return" | "kw_short" | "kw_signed" | "kw_sizeof" | "kw_static" | "kw_static_assert" | "kw_struct" | "kw_switch" | "kw_template" | "kw_this" | "kw_true" | "kw_typedef" | "kw_typename" | "kw_union" | "kw_unsigned" | "kw_using" | "kw_virtual" | "kw_void" | "kw_volatile" | "kw_while"
// Compound type keywords (multi-word)
 | "kw_signed_char" | "kw_unsigned_char" | "kw_signed_short" | "kw_unsigned_short" | "kw_signed_int" | "kw_unsigned_int" | "kw_signed_long_long" | "kw_unsigned_long_long" | "kw_long_long"
// Literals
 | "int_literal" | "float_literal" | "char_literal" | "string_literal"
// Identifiers
 | "identifier"
// Operators and punctuators
 | "l_brace" | "r_brace" // { }
 | "l_paren" | "r_paren" // ( )
 | "l_bracket" | "r_bracket" // [ ]
 | "l_angle" | "r_angle" // < > (also template angle brackets)
 | "semicolon" // ;
 | "colon" | "d_colon" // : ::
 | "comma" // ,
 | "dot" | "dot_star" // . .*
 | "arrow" | "arrow_star" // -> ->*
 | "ellipsis" // ...
 | "hash" | "d_hash" // # ##
// Assignment
 | "eq" // =
 | "plus_eq" | "minus_eq" | "star_eq" | "slash_eq" | "percent_eq" | "l_shift_eq" | "r_shift_eq" | "amp_eq" | "pipe_eq" | "caret_eq"
// Arithmetic
 | "plus" | "minus" | "star" | "slash" | "percent"
// Increment/decrement
 | "plus_plus" | "minus_minus"
// Comparison
 | "eq_eq" | "not_eq" | "lt" | "gt" | "lt_eq" | "gt_eq" | "spaceship" // <=>
// Logical
 | "amp_amp" | "pipe_pipe" | "bang"
// Bitwise
 | "amp" | "pipe" | "caret" | "tilde"
// Shift
 | "l_shift" | "r_shift"
// Other
 | "question" // ?
 | "eof";

export interface Token {
    kind: TokenKind;
    text: string; // raw source text
    span: Span;
}
