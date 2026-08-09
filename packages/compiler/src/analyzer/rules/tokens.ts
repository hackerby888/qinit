// Token-stream scanning shared by the policy rules: entry functions, local declarations, bracket matching.
import { TokenKind } from "../../shared/enums";
import type { Span } from "../../ast";
import type { Token } from "../../frontend/lexer";

const LIFECYCLE = new Set([
  "INITIALIZE",
  "BEGIN_EPOCH",
  "END_EPOCH",
  "BEGIN_TICK",
  "END_TICK",
  "POST_INCOMING_TRANSFER",
  "PRE_ACQUIRE_SHARES",
  "POST_ACQUIRE_SHARES",
  "PRE_RELEASE_SHARES",
  "POST_RELEASE_SHARES",
  "SET_SHAREHOLDER_PROPOSAL",
  "SET_SHAREHOLDER_VOTES",
  "EXPAND",
]);

const TYPE_KINDS = new Set<TokenKind>([
  TokenKind.KW_AUTO,
  TokenKind.KW_BOOL,
  TokenKind.KW_CHAR,
  TokenKind.KW_CONST,
  TokenKind.KW_CONSTEXPR,
  TokenKind.KW_DOUBLE,
  TokenKind.KW_FLOAT,
  TokenKind.KW_INT,
  TokenKind.KW_LONG,
  TokenKind.KW_LONG_LONG,
  TokenKind.KW_SHORT,
  TokenKind.KW_SIGNED,
  TokenKind.KW_SIGNED_CHAR,
  TokenKind.KW_SIGNED_INT,
  TokenKind.KW_SIGNED_LONG_LONG,
  TokenKind.KW_SIGNED_SHORT,
  TokenKind.KW_STATIC,
  TokenKind.KW_UNSIGNED,
  TokenKind.KW_UNSIGNED_CHAR,
  TokenKind.KW_UNSIGNED_INT,
  TokenKind.KW_UNSIGNED_LONG_LONG,
  TokenKind.KW_UNSIGNED_SHORT,
  TokenKind.KW_VOLATILE,
]);

const DECLARATION_PREFIXES = new Set<TokenKind>([
  TokenKind.COLON,
  TokenKind.L_BRACE,
  TokenKind.R_BRACE,
  TokenKind.R_PAREN,
  TokenKind.SEMICOLON,
]);

export interface EntryFunction {
  name: string;
  nameSpan: Span;
  macro: string;
  withLocals: boolean;
  publicEntry: boolean;
  bodyOpen: number;
  bodyClose: number;
  macroSpan: Span;
  plainForm: string;
  withForm: string;
}

export interface LocalDeclaration {
  names: Token[];
  start: number;
  end: number;
  forInitializer: boolean;
}

export function findEntryFunctions(tokens: Token[]): EntryFunction[] {
  const entries: EntryFunction[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const macro = tokens[index].text;
    const named = /^(PUBLIC|PRIVATE)_(FUNCTION|PROCEDURE)(_WITH_LOCALS)?$/.exec(
      macro,
    );
    const lifecycle = macro.endsWith("_WITH_LOCALS")
      ? macro.slice(0, -"_WITH_LOCALS".length)
      : macro;
    const lifecycleMatch = LIFECYCLE.has(lifecycle);

    if (!named && !lifecycleMatch) {
      continue;
    }
    if (tokens[index + 1]?.kind !== TokenKind.L_PAREN) {
      continue;
    }

    const closeParen = matchingToken(
      tokens,
      index + 1,
      TokenKind.L_PAREN,
      TokenKind.R_PAREN,
    );
    if (closeParen < 0) {
      continue;
    }
    const nameToken = named ? tokens[index + 2] : tokens[index];
    if (named && nameToken?.kind !== TokenKind.IDENTIFIER) {
      continue;
    }

    const bodyOpen = findNext(
      tokens,
      closeParen + 1,
      TokenKind.L_BRACE,
      TokenKind.SEMICOLON,
    );
    if (bodyOpen < 0 || tokens[bodyOpen].kind !== TokenKind.L_BRACE) {
      continue;
    }
    const bodyClose = matchingToken(
      tokens,
      bodyOpen,
      TokenKind.L_BRACE,
      TokenKind.R_BRACE,
    );
    if (bodyClose < 0) {
      continue;
    }

    const name = named ? nameToken.text : lifecycle;
    const plainMacro = named
      ? `${named[1]}_${named[2]}`
      : lifecycle;
    entries.push({
      name,
      nameSpan: nameToken.span,
      macro,
      withLocals: named ? named[3] !== undefined : macro.endsWith("_WITH_LOCALS"),
      publicEntry: named?.[1] === "PUBLIC",
      bodyOpen,
      bodyClose,
      macroSpan: {
        ...tokens[index].span,
        end: tokens[closeParen].span.end,
      },
      plainForm: named ? `${plainMacro}(${name})` : `${lifecycle}()`,
      withForm: named
        ? `${plainMacro}_WITH_LOCALS(${name})`
        : `${lifecycle}_WITH_LOCALS()`,
    });
    index = bodyClose;
  }

  return entries;
}

export function findLocalDeclarations(
  tokens: Token[],
  entry: EntryFunction,
): LocalDeclaration[] {
  const declarations: LocalDeclaration[] = [];

  for (
    let index = entry.bodyOpen + 1;
    index < entry.bodyClose;
    index++
  ) {
    const previous = tokens[index - 1];
    const forInitializer =
      previous?.kind === TokenKind.L_PAREN &&
      tokens[index - 2]?.kind === TokenKind.KW_FOR;
    if (
      index !== entry.bodyOpen + 1 &&
      !forInitializer &&
      !DECLARATION_PREFIXES.has(previous?.kind)
    ) {
      continue;
    }

    const declaration = parseLocalDeclaration(
      tokens,
      index,
      entry.bodyClose,
      forInitializer,
    );
    if (!declaration) {
      continue;
    }

    declarations.push(declaration.value);
    index = declaration.end;
  }

  return declarations;
}

function parseLocalDeclaration(
  tokens: Token[],
  start: number,
  limit: number,
  forInitializer: boolean,
): { value: LocalDeclaration; end: number } | null {
  let cursor = start;
  while (
    tokens[cursor]?.kind === TokenKind.KW_CONST ||
    tokens[cursor]?.kind === TokenKind.KW_CONSTEXPR ||
    tokens[cursor]?.kind === TokenKind.KW_STATIC ||
    tokens[cursor]?.kind === TokenKind.KW_VOLATILE
  ) {
    cursor++;
  }

  const typeStart = tokens[cursor];
  if (
    !typeStart ||
    (typeStart.kind !== TokenKind.IDENTIFIER && !TYPE_KINDS.has(typeStart.kind))
  ) {
    return null;
  }
  cursor++;

  if (typeStart.kind === TokenKind.IDENTIFIER) {
    while (
      tokens[cursor]?.kind === TokenKind.D_COLON &&
      tokens[cursor + 1]?.kind === TokenKind.IDENTIFIER
    ) {
      cursor += 2;
    }
  }

  if (tokens[cursor]?.kind === TokenKind.L_ANGLE) {
    cursor = afterTemplateArguments(tokens, cursor);
    if (cursor < 0) {
      return null;
    }
  }
  while (
    tokens[cursor]?.kind === TokenKind.STAR ||
    tokens[cursor]?.kind === TokenKind.AMP ||
    tokens[cursor]?.kind === TokenKind.KW_CONST
  ) {
    cursor++;
  }

  const firstName = tokens[cursor];
  if (firstName?.kind !== TokenKind.IDENTIFIER) {
    return null;
  }
  const next = tokens[cursor + 1]?.kind;
  if (
    next !== TokenKind.SEMICOLON &&
    next !== TokenKind.EQ &&
    next !== TokenKind.COMMA &&
    next !== TokenKind.L_BRACKET &&
    next !== TokenKind.L_BRACE &&
    next !== TokenKind.L_PAREN
  ) {
    return null;
  }

  const names = [firstName];
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let end = cursor;

  for (cursor++; cursor < limit; cursor++) {
    const token = tokens[cursor];
    if (token.kind === TokenKind.L_PAREN) {
      parenDepth++;
    } else if (token.kind === TokenKind.R_PAREN) {
      if (parenDepth === 0 && forInitializer) {
        break;
      }
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (token.kind === TokenKind.L_BRACKET) {
      bracketDepth++;
    } else if (token.kind === TokenKind.R_BRACKET) {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (token.kind === TokenKind.L_BRACE) {
      braceDepth++;
    } else if (token.kind === TokenKind.R_BRACE) {
      if (braceDepth === 0) {
        break;
      }
      braceDepth--;
    }

    if (parenDepth || bracketDepth || braceDepth) {
      continue;
    }
    if (token.kind === TokenKind.SEMICOLON) {
      end = cursor;
      break;
    }
    if (token.kind !== TokenKind.COMMA) {
      continue;
    }

    let nameIndex = cursor + 1;
    while (
      tokens[nameIndex]?.kind === TokenKind.STAR ||
      tokens[nameIndex]?.kind === TokenKind.AMP
    ) {
      nameIndex++;
    }
    if (tokens[nameIndex]?.kind === TokenKind.IDENTIFIER) {
      names.push(tokens[nameIndex]);
    }
  }

  return {
    value: {
      names,
      start,
      end,
      forInitializer,
    },
    end,
  };
}

function afterTemplateArguments(tokens: Token[], start: number): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    const kind = tokens[index].kind;
    if (kind === TokenKind.L_ANGLE) {
      depth++;
    } else if (kind === TokenKind.R_ANGLE) {
      depth--;
    } else if (kind === TokenKind.R_SHIFT) {
      depth -= 2;
    }
    if (depth <= 0) {
      return index + 1;
    }
  }
  return -1;
}

export function isUsingNamespaceQpi(tokens: Token[], index: number): boolean {
  return (
    tokens[index + 1]?.kind === TokenKind.KW_NAMESPACE &&
    tokens[index + 2]?.kind === TokenKind.IDENTIFIER &&
    tokens[index + 2]?.text === "QPI"
  );
}

export function matchingToken(
  tokens: Token[],
  open: number,
  openKind: TokenKind,
  closeKind: TokenKind,
): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    if (tokens[index].kind === openKind) {
      depth++;
    } else if (tokens[index].kind === closeKind) {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

export function findNext(
  tokens: Token[],
  start: number,
  wanted: TokenKind,
  stop: TokenKind,
): number {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].kind === wanted || tokens[index].kind === stop) {
      return index;
    }
  }
  return -1;
}
