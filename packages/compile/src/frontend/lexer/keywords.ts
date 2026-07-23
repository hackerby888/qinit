import { TokenKind } from "../../enums";

// ---- Keyword map ----
export const KEYWORDS: Record<string, TokenKind> = {
    asm: TokenKind.KW_ASM,
    auto: TokenKind.KW_AUTO,
    bool: TokenKind.KW_BOOL,
    break: TokenKind.KW_BREAK,
    case: TokenKind.KW_CASE,
    char: TokenKind.KW_CHAR,
    class: TokenKind.KW_CLASS,
    const: TokenKind.KW_CONST,
    constexpr: TokenKind.KW_CONSTEXPR,
    continue: TokenKind.KW_CONTINUE,
    default: TokenKind.KW_DEFAULT,
    delete: TokenKind.KW_DELETE,
    do: TokenKind.KW_DO,
    double: TokenKind.KW_DOUBLE,
    else: TokenKind.KW_ELSE,
    enum: TokenKind.KW_ENUM,
    extern: TokenKind.KW_EXTERN,
    false: TokenKind.KW_FALSE,
    float: TokenKind.KW_FLOAT,
    for: TokenKind.KW_FOR,
    friend: TokenKind.KW_FRIEND,
    goto: TokenKind.KW_GOTO,
    if: TokenKind.KW_IF,
    inline: TokenKind.KW_INLINE,
    int: TokenKind.KW_INT,
    long: TokenKind.KW_LONG,
    namespace: TokenKind.KW_NAMESPACE,
    noexcept: TokenKind.KW_NOEXCEPT,
    nullptr: TokenKind.KW_NULLPTR,
    operator: TokenKind.KW_OPERATOR,
    override: TokenKind.KW_OVERRIDE,
    private: TokenKind.KW_PRIVATE,
    protected: TokenKind.KW_PROTECTED,
    public: TokenKind.KW_PUBLIC,
    return: TokenKind.KW_RETURN,
    short: TokenKind.KW_SHORT,
    signed: TokenKind.KW_SIGNED,
    sizeof: TokenKind.KW_SIZEOF,
    static: TokenKind.KW_STATIC,
    static_assert: TokenKind.KW_STATIC_ASSERT,
    struct: TokenKind.KW_STRUCT,
    switch: TokenKind.KW_SWITCH,
    template: TokenKind.KW_TEMPLATE,
    this: TokenKind.KW_THIS,
    true: TokenKind.KW_TRUE,
    typedef: TokenKind.KW_TYPEDEF,
    typename: TokenKind.KW_TYPENAME,
    union: TokenKind.KW_UNION,
    unsigned: TokenKind.KW_UNSIGNED,
    using: TokenKind.KW_USING,
    virtual: TokenKind.KW_VIRTUAL,
    void: TokenKind.KW_VOID,
    volatile: TokenKind.KW_VOLATILE,
    while: TokenKind.KW_WHILE,
};

// Multi-word type keywords formed by consecutive single keywords
export const TYPE_COMPOUNDS: [
    TokenKind[],
    TokenKind
][] = [
    [[TokenKind.KW_SIGNED, TokenKind.KW_CHAR], TokenKind.KW_SIGNED_CHAR],
    [[TokenKind.KW_UNSIGNED, TokenKind.KW_CHAR], TokenKind.KW_UNSIGNED_CHAR],
    [[TokenKind.KW_SIGNED, TokenKind.KW_SHORT], TokenKind.KW_SIGNED_SHORT],
    [[TokenKind.KW_UNSIGNED, TokenKind.KW_SHORT], TokenKind.KW_UNSIGNED_SHORT],
    [[TokenKind.KW_SIGNED, TokenKind.KW_INT], TokenKind.KW_SIGNED_INT],
    [[TokenKind.KW_UNSIGNED, TokenKind.KW_INT], TokenKind.KW_UNSIGNED_INT],
    [[TokenKind.KW_SIGNED, TokenKind.KW_LONG, TokenKind.KW_LONG], TokenKind.KW_SIGNED_LONG_LONG],
    [[TokenKind.KW_UNSIGNED, TokenKind.KW_LONG, TokenKind.KW_LONG], TokenKind.KW_UNSIGNED_LONG_LONG],
    [[TokenKind.KW_LONG, TokenKind.KW_LONG], TokenKind.KW_LONG_LONG],
];

export function isTypeKeyword(kind: TokenKind): boolean {
    return (kind === TokenKind.KW_VOID ||
        kind === TokenKind.KW_BOOL ||
        kind === TokenKind.KW_CHAR ||
        kind === TokenKind.KW_SHORT ||
        kind === TokenKind.KW_INT ||
        kind === TokenKind.KW_LONG ||
        kind === TokenKind.KW_SIGNED ||
        kind === TokenKind.KW_UNSIGNED ||
        kind === TokenKind.KW_SIGNED_CHAR ||
        kind === TokenKind.KW_UNSIGNED_CHAR ||
        kind === TokenKind.KW_SIGNED_SHORT ||
        kind === TokenKind.KW_UNSIGNED_SHORT ||
        kind === TokenKind.KW_SIGNED_INT ||
        kind === TokenKind.KW_UNSIGNED_INT ||
        kind === TokenKind.KW_SIGNED_LONG_LONG ||
        kind === TokenKind.KW_UNSIGNED_LONG_LONG ||
        kind === TokenKind.KW_LONG_LONG ||
        kind === TokenKind.KW_DOUBLE ||
        kind === TokenKind.KW_FLOAT);
}
