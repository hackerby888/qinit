export enum TokenKind {
  KW_ASM = "kw_asm",
  KW_AUTO = "kw_auto",
  KW_BOOL = "kw_bool",
  KW_BREAK = "kw_break",
  KW_CASE = "kw_case",
  KW_CHAR = "kw_char",
  KW_CLASS = "kw_class",
  KW_CONST = "kw_const",
  KW_CONSTEXPR = "kw_constexpr",
  KW_CONTINUE = "kw_continue",
  KW_DEFAULT = "kw_default",
  KW_DELETE = "kw_delete",
  KW_DO = "kw_do",
  KW_DOUBLE = "kw_double",
  KW_ELSE = "kw_else",
  KW_ENUM = "kw_enum",
  KW_EXTERN = "kw_extern",
  KW_FALSE = "kw_false",
  KW_FLOAT = "kw_float",
  KW_FOR = "kw_for",
  KW_FRIEND = "kw_friend",
  KW_GOTO = "kw_goto",
  KW_IF = "kw_if",
  KW_INLINE = "kw_inline",
  KW_INT = "kw_int",
  KW_LONG = "kw_long",
  KW_NAMESPACE = "kw_namespace",
  KW_NOEXCEPT = "kw_noexcept",
  KW_NULLPTR = "kw_nullptr",
  KW_OPERATOR = "kw_operator",
  KW_OVERRIDE = "kw_override",
  KW_PRIVATE = "kw_private",
  KW_PROTECTED = "kw_protected",
  KW_PUBLIC = "kw_public",
  KW_RETURN = "kw_return",
  KW_SHORT = "kw_short",
  KW_SIGNED = "kw_signed",
  KW_SIZEOF = "kw_sizeof",
  KW_STATIC = "kw_static",
  KW_STATIC_ASSERT = "kw_static_assert",
  KW_STRUCT = "kw_struct",
  KW_SWITCH = "kw_switch",
  KW_TEMPLATE = "kw_template",
  KW_THIS = "kw_this",
  KW_TRUE = "kw_true",
  KW_TYPEDEF = "kw_typedef",
  KW_TYPENAME = "kw_typename",
  KW_UNION = "kw_union",
  KW_UNSIGNED = "kw_unsigned",
  KW_USING = "kw_using",
  KW_VIRTUAL = "kw_virtual",
  KW_VOID = "kw_void",
  KW_VOLATILE = "kw_volatile",
  KW_WHILE = "kw_while",
  KW_SIGNED_CHAR = "kw_signed_char",
  KW_UNSIGNED_CHAR = "kw_unsigned_char",
  KW_SIGNED_SHORT = "kw_signed_short",
  KW_UNSIGNED_SHORT = "kw_unsigned_short",
  KW_SIGNED_INT = "kw_signed_int",
  KW_UNSIGNED_INT = "kw_unsigned_int",
  KW_SIGNED_LONG_LONG = "kw_signed_long_long",
  KW_UNSIGNED_LONG_LONG = "kw_unsigned_long_long",
  KW_LONG_LONG = "kw_long_long",
  INT_LITERAL = "int_literal",
  FLOAT_LITERAL = "float_literal",
  CHAR_LITERAL = "char_literal",
  STRING_LITERAL = "string_literal",
  IDENTIFIER = "identifier",
  L_BRACE = "l_brace",
  R_BRACE = "r_brace",
  L_PAREN = "l_paren",
  R_PAREN = "r_paren",
  L_BRACKET = "l_bracket",
  R_BRACKET = "r_bracket",
  L_ANGLE = "l_angle",
  R_ANGLE = "r_angle",
  SEMICOLON = "semicolon",
  COLON = "colon",
  D_COLON = "d_colon",
  COMMA = "comma",
  DOT = "dot",
  DOT_STAR = "dot_star",
  ARROW = "arrow",
  ARROW_STAR = "arrow_star",
  ELLIPSIS = "ellipsis",
  HASH = "hash",
  D_HASH = "d_hash",
  EQ = "eq",
  PLUS_EQ = "plus_eq",
  MINUS_EQ = "minus_eq",
  STAR_EQ = "star_eq",
  SLASH_EQ = "slash_eq",
  PERCENT_EQ = "percent_eq",
  L_SHIFT_EQ = "l_shift_eq",
  R_SHIFT_EQ = "r_shift_eq",
  AMP_EQ = "amp_eq",
  PIPE_EQ = "pipe_eq",
  CARET_EQ = "caret_eq",
  PLUS = "plus",
  MINUS = "minus",
  STAR = "star",
  SLASH = "slash",
  PERCENT = "percent",
  PLUS_PLUS = "plus_plus",
  MINUS_MINUS = "minus_minus",
  EQ_EQ = "eq_eq",
  NOT_EQ = "not_eq",
  LT = "lt",
  GT = "gt",
  LT_EQ = "lt_eq",
  GT_EQ = "gt_eq",
  SPACESHIP = "spaceship",
  AMP_AMP = "amp_amp",
  PIPE_PIPE = "pipe_pipe",
  BANG = "bang",
  AMP = "amp",
  PIPE = "pipe",
  CARET = "caret",
  TILDE = "tilde",
  L_SHIFT = "l_shift",
  R_SHIFT = "r_shift",
  QUESTION = "question",
  EOF = "eof",
}

export enum AstKind {
  INT_LITERAL = "int_literal",
  FLOAT_LITERAL = "float_literal",
  BOOL_LITERAL = "bool_literal",
  NULLPTR_LITERAL = "nullptr_literal",
  STRING_LITERAL = "string_literal",
  CHAR_LITERAL = "char_literal",
  IDENTIFIER = "identifier",
  QUALIFIED_NAME = "qualified_name",
  UNARY_OP = "unary_op",
  PREFIX_OP = "prefix_op",
  POSTFIX_OP = "postfix_op",
  BINARY_OP = "binary_op",
  TERNARY = "ternary",
  MEMBER_ACCESS = "member_access",
  SUBSCRIPT = "subscript",
  SEQUENCE = "sequence",
  CALL = "call",
  TEMPLATE_CALL = "template_call",
  C_CAST = "c_cast",
  STATIC_CAST = "static_cast",
  REINTERPRET_CAST = "reinterpret_cast",
  SIZEOF_TYPE = "sizeof_type",
  SIZEOF_EXPR = "sizeof_expr",
  ASSIGN = "assign",
  CONSTRUCT = "construct",
  INITIALIZER_LIST = "initializer_list",
  THIS = "this",
  PAREN = "paren",
  EXPRESSION = "expression",
  COMPOUND = "compound",
  IF = "if",
  FOR = "for",
  WHILE = "while",
  DO_WHILE = "do_while",
  SWITCH = "switch",
  CASE = "case",
  DEFAULT = "default",
  BREAK = "break",
  CONTINUE = "continue",
  RETURN = "return",
  GOTO = "goto",
  LABEL = "label",
  DECLARATION = "declaration",
  STATIC_ASSERT = "static_assert",
  PRAGMA = "pragma",
  EMPTY = "empty",
  STRUCT = "struct",
  CLASS_TEMPLATE = "class_template",
  FUNCTION_TEMPLATE = "function_template",
  FUNCTION = "function",
  VARIABLE = "variable",
  ENUM = "enum",
  TYPEDEF_DECL = "typedef_decl",
  NAMESPACE = "namespace",
  STATIC_ASSERT_DECL = "static_assert_decl",
  EXTERN_BLOCK = "extern_block",
  FRIEND = "friend",
  NAME = "name",
  TEMPLATE_INSTANCE = "template_instance",
  CONST = "const",
  POINTER = "pointer",
  REFERENCE = "reference",
  ARRAY = "array",
  INLINE_STRUCT = "inline_struct",
  EXPR_VALUE = "expr_value",
  DEPENDENT_MEMBER = "dependent_member",
  VOID = "void",
  TYPEDEF = "typedef",
  TYPE = "type",
  NON_TYPE = "non_type",
  NON_TYPE_DEFAULT = "non_type_default",
}

export enum UpdateOp {
  INCREMENT = "++",
  DECREMENT = "--",
}

export enum UnaryOp {
  LOGICAL_NOT = "!",
  BITWISE_NOT = "~",
  MINUS = "-",
  PLUS = "+",
  DEREFERENCE = "*",
  ADDRESS_OF = "&",
}

export enum BinaryOp {
  ADD = "+",
  SUBTRACT = "-",
  MULTIPLY = "*",
  DIVIDE = "/",
  MODULO = "%",
  EQUAL = "==",
  NOT_EQUAL = "!=",
  LESS_THAN = "<",
  GREATER_THAN = ">",
  LESS_THAN_OR_EQUAL = "<=",
  GREATER_THAN_OR_EQUAL = ">=",
  LOGICAL_AND = "&&",
  LOGICAL_OR = "||",
  SHIFT_LEFT = "<<",
  SHIFT_RIGHT = ">>",
  BITWISE_AND = "&",
  BITWISE_OR = "|",
  BITWISE_XOR = "^",
  ASSIGN = "=",
}

export enum AssignOp {
  ASSIGN = "=",
  ADD = "+=",
  SUBTRACT = "-=",
  MULTIPLY = "*=",
  DIVIDE = "/=",
  MODULO = "%=",
  SHIFT_LEFT = "<<=",
  SHIFT_RIGHT = ">>=",
  BITWISE_AND = "&=",
  BITWISE_OR = "|=",
  BITWISE_XOR = "^=",
}

export enum AccessSpec {
  PUBLIC = "public",
  PROTECTED = "protected",
  PRIVATE = "private",
}

export enum StorageClass {
  STATIC = "static",
  INLINE = "inline",
  EXTERN = "extern",
}

export enum DiagnosticSeverity {
  ERROR = "error",
  WARNING = "warning",
  INFORMATION = "information",
}

export enum DiagnosticCategory {
  FIDELITY = "fidelity",
}

export enum SourceAnalysisOrigin {
  COMPILER = "compiler",
  QPI = "qpi",
}

export enum AnalysisPhase {
  SYNTAX = "syntax",
  SEMANTIC = "semantic",
}

export enum ContainerLayoutKind {
  HASH_MAP = "HashMap",
  ARRAY = "Array",
}

export enum ContainerEmissionMode {
  STATEMENT = "stmt",
  VALUE = "value",
  ADDRESS = "addr",
}

export enum PlatformPrimitiveKind {
  ZERO = "zero",
  LANE_PACK_64 = "lane-pack-64",
  LANE_PACK_8 = "lane-pack-8",
  MEMORY_LOAD = "memory-load",
  MEMORY_STORE = "memory-store",
  LANE_COMPARE_64 = "lane-compare-64",
  MASK_EXTRACT = "mask-extract",
  TEST_ZERO = "test-zero",
  WASM_UNARY = "wasm-unary",
  MULTIPLY_HIGH = "multiply-high",
  CHAIN_RDRAND = "chain-rdrand",
}

export enum PrimitiveOperand {
  VALUE = "value",
  ADDRESS = "address",
  OUTPUT_DESTINATION = "output-destination",
}

export enum PrimitiveResultChannel {
  VALUE = "value",
  ADDRESS = "address",
  VOID = "void",
}

export enum PlatformWasmOp {
  I64_CLZ = "i64.clz",
  I64_CTZ = "i64.ctz",
}

export enum PlatformCapability {
  CHAIN_PRNG = "chain-prng",
}

export enum QpiContextKind {
  FUNCTION = "function",
  PROCEDURE = "procedure",
}

export enum QpiMacroKind {
  FUNCTION = "FUNCTION",
  PROCEDURE = "PROCEDURE",
}

export enum WasmValueType {
  I32 = "i32",
  I64 = "i64",
  F32 = "f32",
  F64 = "f64",
}

export enum WasmExternalKind {
  FUNCTION = "function",
  TABLE = "table",
  MEMORY = "memory",
  GLOBAL = "global",
  TAG = "tag",
}

export enum WasmMemorySource {
  IMPORTED = "imported",
  DEFINED = "defined",
}

export enum WasmModuleMemoryMode {
  DEFINED = "defined",
  IMPORTED = "imported",
  EITHER = "either",
}

export enum InspectedMemoryMode {
  NONE = "none",
  DEFINED = "defined",
  IMPORTED = "imported",
  MIXED = "mixed",
}

export enum WasmLimitKind {
  MEMORY = "memory",
  TABLE = "table",
}

export enum WatNodeKind {
  CONST = "const",
  GET = "get",
  SET = "set",
  LOAD = "load",
  STORE = "store",
  OP = "op",
  CALL = "call",
  RAW = "raw",
}

export enum WatNodeType {
  I32 = "i32",
  I64 = "i64",
  VOID = "void",
}

export enum WatExpectedType {
  VALUE = "val",
}

export type WatValueType = WatNodeType.I32 | WatNodeType.I64;

export type ExpectedWatType = WatNodeType | WatExpectedType;

export enum SourceScannerState {
  NORMAL = "normal",
  LINE_COMMENT = "line_comment",
  BLOCK_COMMENT = "block_comment",
  STRING = "string",
  CHAR = "char",
}

export enum ValidationVisitState {
  VISITING = "visiting",
  DONE = "done",
}
