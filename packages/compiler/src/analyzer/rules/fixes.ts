// Diagnostic construction and the quick fixes offered with them, including the with-locals rewrite.
import { BinaryOp, DiagnosticSeverity, SourceAnalysisOrigin, TokenKind } from "../../shared/enums";
import type { Span } from "../../ast";
import type { Token } from "../../frontend/lexer";
import type { SourceAnalysisDiagnostic, SourceFix } from "../index";
import type { EntryFunction, LocalDeclaration } from "./tokens";
import { findNext } from "./tokens";

interface OffsetEdit {
    start: number;
    end: number;
    newText: string;
}

export function diagnostic(
    code: string,
    message: string,
    span: Span,
    severity: SourceAnalysisDiagnostic["severity"] = DiagnosticSeverity.WARNING,
    fixes?: SourceFix[],
): SourceAnalysisDiagnostic {
    return {
        origin: SourceAnalysisOrigin.QPI,
        code,
        severity,
        message,
        span,
        fixes,
    };
}

export function compareDiagnostics(
    left: SourceAnalysisDiagnostic,
    right: SourceAnalysisDiagnostic,
): number {
    return (
        left.span.start - right.span.start ||
        left.span.end - right.span.end ||
        left.code.localeCompare(right.code) ||
        left.message.localeCompare(right.message)
    );
}

export function arrayFix(source: string, offset: number): SourceFix[] | undefined {
    const { start, end, text } = sourceLine(source, offset);
    const replacement = arrayFixForLine(text);
    if (!replacement || replacement === text) {
        return undefined;
    }
    return [
        sourceFix("Convert to Array<T, N>", source, [{ start, end, newText: replacement }], true),
    ];
}

export function divModFix(
    source: string,
    token: Token,
    operator: BinaryOp.DIVIDE | BinaryOp.MODULO,
): SourceFix[] | undefined {
    const line = sourceLine(source, token.span.start);
    const fix = divModFixForLine(line.text, token.span.start - line.start, operator);
    if (!fix) {
        return undefined;
    }
    return [
        sourceFix(
            `Convert to ${operator === BinaryOp.DIVIDE ? "div" : "mod"}(a, b)`,
            source,
            [
                {
                    start: line.start + fix.start,
                    end: line.start + fix.end,
                    newText: fix.text,
                },
            ],
            true,
        ),
    ];
}

export function sourceFix(
    title: string,
    source: string,
    edits: OffsetEdit[],
    preferred = false,
): SourceFix {
    return {
        title,
        preferred,
        edits: edits.map((edit) => ({
            span: spanFromOffsets(source, edit.start, edit.end),
            newText: edit.newText,
        })),
    };
}

function sourceLine(
    source: string,
    offset: number,
): {
    start: number;
    end: number;
    text: string;
} {
    const start = source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
    const newline = source.indexOf("\n", offset);
    const end = newline < 0 ? source.length : newline;
    return {
        start,
        end,
        text: source.slice(start, end),
    };
}

function spanFromOffsets(source: string, start: number, end: number): Span {
    const safeStart = Math.max(0, Math.min(start, source.length));
    const safeEnd = Math.max(safeStart, Math.min(end, source.length));
    const before = source.slice(0, safeStart);
    const lastNewline = before.lastIndexOf("\n");
    return {
        start: safeStart,
        end: safeEnd,
        line: before.split("\n").length,
        column: safeStart - lastNewline,
    };
}

export function arrayFixForLine(line: string): string | null {
    const match = line.match(
        /^(\s*)([A-Za-z_][\w:<>,\s]*?)\s+([A-Za-z_]\w*)\s*\[\s*([^\]]+?)\s*\]\s*;(.*)$/,
    );
    if (!match) {
        return null;
    }
    const [, indent, type, name, size, tail] = match;
    if (/[\[\],]/.test(type)) {
        return null;
    }
    return `${indent}Array<${type.trim()}, ${size.trim()}> ${name};${tail}`;
}

const OPERAND = "[A-Za-z_]\\w*(?:\\.\\w+)*|\\d+";

export function divModFixForLine(
    line: string,
    column: number,
    operator: BinaryOp.DIVIDE | BinaryOp.MODULO,
): { start: number; end: number; text: string } | null {
    if (
        line[column] !== operator ||
        line[column + 1] === "=" ||
        line[column + 1] === operator ||
        line[column - 1] === operator
    ) {
        return null;
    }

    const left = line.slice(0, column).match(new RegExp(`(${OPERAND})\\s*$`));
    const right = line.slice(column + 1).match(new RegExp(`^\\s*(${OPERAND})`));
    if (!left || !right) {
        return null;
    }

    const start = column - left[0].length;
    const end = column + 1 + right[0].length;
    if (/[.)\]>]/.test(line[start - 1] ?? "")) {
        return null;
    }
    if (/[.(\[]/.test(line[end] ?? "")) {
        return null;
    }
    return {
        start,
        end,
        text: `${operator === BinaryOp.DIVIDE ? "div" : "mod"}(${left[1]}, ${right[1]})`,
    };
}

export function moveLocalToWithLocalsEdits(
    source: string,
    tokens: Token[],
    entry: EntryFunction,
    declaration: LocalDeclaration,
    name: Token,
): OffsetEdit[] | null {
    const semicolon = tokens[declaration.end];
    if (semicolon?.kind !== TokenKind.SEMICOLON) {
        return null;
    }

    let nameIndex = declaration.start;
    while (nameIndex <= declaration.end && tokens[nameIndex].span.start !== name.span.start) {
        nameIndex++;
    }
    if (nameIndex > declaration.end) {
        return null;
    }

    const unsafeType = new Set<TokenKind>([
        TokenKind.AMP,
        TokenKind.KW_AUTO,
        TokenKind.KW_CONST,
        TokenKind.KW_CONSTEXPR,
        TokenKind.KW_STATIC,
        TokenKind.KW_VOLATILE,
        TokenKind.STAR,
    ]);
    for (let index = declaration.start; index < nameIndex; index++) {
        if (unsafeType.has(tokens[index].kind)) {
            return null;
        }
    }

    const unsafe = new Set<TokenKind>([
        TokenKind.COMMA,
        TokenKind.L_BRACE,
        TokenKind.R_BRACE,
        TokenKind.L_BRACKET,
        TokenKind.L_PAREN,
        TokenKind.R_PAREN,
    ]);
    let equals = -1;
    for (let index = nameIndex + 1; index < declaration.end; index++) {
        if (unsafe.has(tokens[index].kind)) {
            return null;
        }
        if (tokens[index].kind === TokenKind.EQ && equals < 0) {
            equals = index;
        }
    }

    const typeStart = tokens[declaration.start].span.start;
    const type = source.slice(typeStart, name.span.start).trim();
    if (!type) {
        return null;
    }

    const initializer =
        equals >= 0 ? source.slice(tokens[equals].span.end, semicolon.span.start).trim() : "";
    const edits: OffsetEdit[] = [];

    if (!entry.withLocals) {
        const paren = source.indexOf("(", entry.macroSpan.start);
        if (paren < 0 || paren >= entry.macroSpan.end) {
            return null;
        }
        edits.push({
            start: paren,
            end: paren,
            newText: "_WITH_LOCALS",
        });
    }

    const field = `${type} ${name.text};`;
    let localsBrace: Token | undefined;
    for (let index = 0; index + 1 < tokens.length; index++) {
        if (
            tokens[index].kind !== TokenKind.KW_STRUCT ||
            tokens[index + 1].text !== `${entry.name}_locals`
        ) {
            continue;
        }
        const open = findNext(tokens, index + 2, TokenKind.L_BRACE, TokenKind.SEMICOLON);
        if (open >= 0 && tokens[open].kind === TokenKind.L_BRACE) {
            localsBrace = tokens[open];
        }
        break;
    }

    if (localsBrace) {
        edits.push({
            start: localsBrace.span.end,
            end: localsBrace.span.end,
            newText: ` ${field}`,
        });
    } else {
        const indent =
            source
                .slice(
                    source.lastIndexOf("\n", entry.macroSpan.start - 1) + 1,
                    entry.macroSpan.start,
                )
                .match(/^\s*/)?.[0] ?? "";
        edits.push({
            start: entry.macroSpan.start,
            end: entry.macroSpan.start,
            newText: `struct ${entry.name}_locals { ${field} };\n${indent}`,
        });
    }

    if (equals >= 0) {
        edits.push({
            start: typeStart,
            end: semicolon.span.end,
            newText: `locals.${name.text} = ${initializer};`,
        });
    } else {
        const lineStart = source.lastIndexOf("\n", typeStart - 1) + 1;
        const newline = source.indexOf("\n", semicolon.span.end);
        const lineEnd = newline < 0 ? source.length : newline + 1;
        const isOnlyStatement =
            source.slice(lineStart, typeStart).trim() === "" &&
            source.slice(semicolon.span.end, lineEnd).trim() === "";
        edits.push({
            start: isOnlyStatement ? lineStart : typeStart,
            end: isOnlyStatement ? lineEnd : semicolon.span.end,
            newText: "",
        });
    }

    for (let index = entry.bodyOpen + 1; index < entry.bodyClose; index++) {
        const token = tokens[index];
        if (
            token.kind !== TokenKind.IDENTIFIER ||
            token.text !== name.text ||
            (token.span.start >= typeStart && token.span.end <= semicolon.span.end)
        ) {
            continue;
        }
        const previous = tokens[index - 1]?.kind;
        if (
            previous === TokenKind.DOT ||
            previous === TokenKind.D_COLON ||
            previous === TokenKind.ARROW
        ) {
            continue;
        }
        edits.push({
            start: token.span.start,
            end: token.span.start,
            newText: "locals.",
        });
    }

    return edits;
}
