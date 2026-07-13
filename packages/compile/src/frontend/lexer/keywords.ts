import type { TokenKind } from "./tokens";

// ---- Keyword map ----
export const KEYWORDS: Record<string, TokenKind> = {
    asm: "kw_asm",
    auto: "kw_auto",
    bool: "kw_bool",
    break: "kw_break",
    case: "kw_case",
    char: "kw_char",
    class: "kw_class",
    const: "kw_const",
    constexpr: "kw_constexpr",
    continue: "kw_continue",
    default: "kw_default",
    delete: "kw_delete",
    do: "kw_do",
    double: "kw_double",
    else: "kw_else",
    enum: "kw_enum",
    extern: "kw_extern",
    false: "kw_false",
    float: "kw_float",
    for: "kw_for",
    friend: "kw_friend",
    goto: "kw_goto",
    if: "kw_if",
    inline: "kw_inline",
    int: "kw_int",
    long: "kw_long",
    namespace: "kw_namespace",
    noexcept: "kw_noexcept",
    nullptr: "kw_nullptr",
    operator: "kw_operator",
    override: "kw_override",
    private: "kw_private",
    protected: "kw_protected",
    public: "kw_public",
    return: "kw_return",
    short: "kw_short",
    signed: "kw_signed",
    sizeof: "kw_sizeof",
    static: "kw_static",
    static_assert: "kw_static_assert",
    struct: "kw_struct",
    switch: "kw_switch",
    template: "kw_template",
    this: "kw_this",
    true: "kw_true",
    typedef: "kw_typedef",
    typename: "kw_typename",
    union: "kw_union",
    unsigned: "kw_unsigned",
    using: "kw_using",
    virtual: "kw_virtual",
    void: "kw_void",
    volatile: "kw_volatile",
    while: "kw_while",
};

// Multi-word type keywords formed by consecutive single keywords
export const TYPE_COMPOUNDS: [
    TokenKind[],
    TokenKind
][] = [
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
    return (kind === "kw_void" ||
        kind === "kw_bool" ||
        kind === "kw_char" ||
        kind === "kw_short" ||
        kind === "kw_int" ||
        kind === "kw_long" ||
        kind === "kw_signed" ||
        kind === "kw_unsigned" ||
        kind === "kw_signed_char" ||
        kind === "kw_unsigned_char" ||
        kind === "kw_signed_short" ||
        kind === "kw_unsigned_short" ||
        kind === "kw_signed_int" ||
        kind === "kw_unsigned_int" ||
        kind === "kw_signed_long_long" ||
        kind === "kw_unsigned_long_long" ||
        kind === "kw_long_long" ||
        kind === "kw_double" ||
        kind === "kw_float");
}
