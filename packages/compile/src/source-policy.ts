import {
  BinaryOp,
  DiagnosticSeverity,
  QpiMacroKind,
  SourceAnalysisOrigin,
  TokenKind,
} from "./enums";
import type { Span } from "./ast";
import { Lexer, type Token } from "./lexer";
import type {
  SourceAnalysisDiagnostic,
  SourceFix,
} from "./analyzer";

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
  "EXPAND",
]);

const KEYWORD_RULES: Record<string, { code: string; message: string }> = {
  float: {
    code: "qpi/no-float",
    message:
      "Floating-point types (`float`/`double`) are forbidden — their arithmetic isn't deterministic.",
  },
  double: {
    code: "qpi/no-float",
    message:
      "Floating-point types (`float`/`double`) are forbidden — their arithmetic isn't deterministic.",
  },
  union: {
    code: "qpi/no-union",
    message: "`union` is forbidden in QPI (it obscures code audits).",
  },
  const_cast: {
    code: "qpi/no-const-cast",
    message: "`const_cast` is forbidden in QPI.",
  },
  QpiContext: {
    code: "qpi/no-qpicontext",
    message: "`QpiContext` may not be used directly in a contract.",
  },
};

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

interface EntryFunction {
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

interface OffsetEdit {
  start: number;
  end: number;
  newText: string;
}

interface LocalDeclaration {
  names: Token[];
  start: number;
  end: number;
  forInitializer: boolean;
}

export function analyzeQpiPolicy(source: string): SourceAnalysisDiagnostic[] {
  const tokens = new Lexer(source).tokenize();
  const entries = findEntryFunctions(tokens);
  const diagnostics = [
    ...forbiddenConstructs(source, tokens),
    ...localDiagnostics(source, tokens, entries),
    ...localsFormDiagnostics(tokens, entries),
    ...idlDiagnostics(tokens, entries),
  ];

  return diagnostics.sort(compareDiagnostics);
}

export function detectQpiContractName(source: string): string | undefined {
  const tokens = new Lexer(source).tokenize();

  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].kind !== TokenKind.KW_STRUCT && tokens[index].kind !== TokenKind.KW_CLASS) {
      continue;
    }

    const name = tokens[index + 1];
    if (name?.kind !== TokenKind.IDENTIFIER) {
      continue;
    }

    for (let cursor = index + 2; cursor < tokens.length; cursor++) {
      const token = tokens[cursor];
      if (token.kind === TokenKind.L_BRACE || token.kind === TokenKind.SEMICOLON) {
        break;
      }
      if (
        token.kind === TokenKind.IDENTIFIER &&
        token.text === "ContractBase"
      ) {
        return name.text;
      }
    }
  }

  return undefined;
}

function forbiddenConstructs(
  source: string,
  tokens: Token[],
): SourceAnalysisDiagnostic[] {
  const diagnostics: SourceAnalysisDiagnostic[] = [];
  let braceDepth = 0;
  let skipUntil = -1;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === TokenKind.EOF) {
      break;
    }
    if (token.span.start < skipUntil) {
      continue;
    }

    if (
      (token.kind === TokenKind.KW_STATIC_ASSERT || token.text === "STATIC_ASSERT") &&
      tokens[index + 1]?.kind === TokenKind.L_PAREN
    ) {
      const close = matchingToken(tokens, index + 1, TokenKind.L_PAREN, TokenKind.R_PAREN);
      if (close >= 0) {
        index = close;
        continue;
      }
    }

    if (token.kind === TokenKind.HASH) {
      const newline = source.indexOf("\n", token.span.start);
      skipUntil = newline < 0 ? source.length : newline;
      const directive = source.slice(token.span.start, skipUntil);
      if (!/^#\s*include\s*[<"][^>"]*qpi\.h[>"]/.test(directive)) {
        diagnostics.push(
          diagnostic(
            "qpi/no-preprocessor",
            "Preprocessor directives (`#`) are forbidden in QPI (remove before deploying).",
            token.span,
            DiagnosticSeverity.INFORMATION,
          ),
        );
      }
      continue;
    }

    if (token.kind === TokenKind.L_BRACE) {
      braceDepth++;
      continue;
    }
    if (token.kind === TokenKind.R_BRACE) {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    if (token.kind === TokenKind.STRING_LITERAL) {
      diagnostics.push(
        diagnostic(
          "qpi/no-string",
          'String literals (`"`) are forbidden in QPI — they can address arbitrary memory.',
          token.span,
        ),
      );
      continue;
    }
    if (token.kind === TokenKind.CHAR_LITERAL) {
      if (
        /[0-9a-fA-F]/.test(source[token.span.start - 1] ?? "") &&
        /[0-9a-fA-F]/.test(source[token.span.end] ?? "")
      ) {
        continue;
      }
      diagnostics.push(
        diagnostic(
          "qpi/no-char",
          "Character literals (`'`) are forbidden in QPI.",
          token.span,
        ),
      );
      continue;
    }
    if (token.kind === TokenKind.SLASH || token.kind === TokenKind.SLASH_EQ) {
      diagnostics.push(
        diagnostic(
          "qpi/no-division",
          "The `/` operator is forbidden (division by zero is undefined). Use `div(a, b)`.",
          token.span,
          DiagnosticSeverity.WARNING,
          divModFix(source, token, BinaryOp.DIVIDE),
        ),
      );
      continue;
    }
    if (token.kind === TokenKind.PERCENT || token.kind === TokenKind.PERCENT_EQ) {
      diagnostics.push(
        diagnostic(
          "qpi/no-modulo",
          "The `%` operator is forbidden. Use `mod(a, b)`.",
          token.span,
          DiagnosticSeverity.WARNING,
          divModFix(source, token, BinaryOp.MODULO),
        ),
      );
      continue;
    }
    if (token.kind === TokenKind.L_BRACKET || token.kind === TokenKind.R_BRACKET) {
      diagnostics.push(
        diagnostic(
          "qpi/no-brackets",
          `\`${token.text}\` is forbidden (no low-level arrays / unchecked buffers). Use \`Array<T, N>\`.`,
          token.span,
          DiagnosticSeverity.WARNING,
          arrayFix(source, token.span.start),
        ),
      );
      continue;
    }
    if (
      token.kind === TokenKind.ELLIPSIS ||
      (
        token.kind === TokenKind.DOT &&
        tokens[index + 1]?.kind === TokenKind.DOT &&
        tokens[index + 2]?.kind === TokenKind.DOT &&
        token.span.end === tokens[index + 1].span.start &&
        tokens[index + 1].span.end === tokens[index + 2].span.start
      )
    ) {
      const span =
        token.kind === TokenKind.ELLIPSIS
          ? token.span
          : {
              ...token.span,
              end: tokens[index + 2].span.end,
            };
      diagnostics.push(
        diagnostic(
          "qpi/no-varargs",
          "Variadic arguments / parameter packs (`...`) are forbidden.",
          span,
        ),
      );
      if (token.kind === TokenKind.DOT) {
        index += 2;
      }
      continue;
    }
    if (token.text.includes("__")) {
      diagnostics.push(
        diagnostic(
          "qpi/no-dunder",
          "Double underscores (`__`) are reserved for internal use and forbidden in contracts.",
          token.span,
        ),
      );
      continue;
    }

    const keyword = KEYWORD_RULES[token.text];
    if (keyword) {
      diagnostics.push(
        diagnostic(keyword.code, keyword.message, token.span),
      );
      continue;
    }

    if (braceDepth === 0 && token.kind === TokenKind.KW_TYPEDEF) {
      diagnostics.push(
        diagnostic(
          "qpi/no-global-typedef",
          "`typedef` is only allowed in local scope (inside a struct or function).",
          token.span,
        ),
      );
      continue;
    }
    if (
      braceDepth === 0 &&
      token.kind === TokenKind.KW_USING &&
      !isUsingNamespaceQpi(tokens, index)
    ) {
      diagnostics.push(
        diagnostic(
          "qpi/no-global-using",
          "`using` at global scope is forbidden, except `using namespace QPI`.",
          token.span,
        ),
      );
    }
  }

  return diagnostics;
}

function localDiagnostics(
  source: string,
  tokens: Token[],
  entries: EntryFunction[],
): SourceAnalysisDiagnostic[] {
  const diagnostics: SourceAnalysisDiagnostic[] = [];

  for (const entry of entries) {
    const declarations = findLocalDeclarations(tokens, entry);

    for (const declaration of declarations) {
      for (const name of declaration.names) {
        const edits =
          declaration.names.length === 1 && !declaration.forInitializer
            ? moveLocalToWithLocalsEdits(
                source,
                tokens,
                entry,
                declaration,
                name,
              )
            : null;
        const fixes =
          edits && edits.length > 0
            ? [
                sourceFix(
                  "Move into <fn>_locals struct (use *_WITH_LOCALS)",
                  source,
                  edits,
                ),
              ]
            : undefined;

        diagnostics.push(
          diagnostic(
            "qpi/stack-local",
            `Stack-local \`${name.text}\` is forbidden in QPI — declare it in a \`<fn>_locals\` struct (use the *_WITH_LOCALS form), or keep state in StateData via \`state.mut()\`.`,
            name.span,
            DiagnosticSeverity.WARNING,
            fixes,
          ),
        );
      }
    }
  }

  return diagnostics;
}

function localsFormDiagnostics(
  tokens: Token[],
  entries: EntryFunction[],
): SourceAnalysisDiagnostic[] {
  const diagnostics: SourceAnalysisDiagnostic[] = [];
  const localsStructs = new Set<string>();

  for (let index = 0; index + 1 < tokens.length; index++) {
    if (
      tokens[index].kind === TokenKind.KW_STRUCT &&
      tokens[index + 1].kind === TokenKind.IDENTIFIER &&
      tokens[index + 1].text.endsWith("_locals")
    ) {
      localsStructs.add(tokens[index + 1].text.slice(0, -"_locals".length));
    }
  }

  for (const entry of entries) {
    if (entry.withLocals) {
      continue;
    }

    let usesLocals = false;
    for (let index = entry.bodyOpen + 1; index < entry.bodyClose; index++) {
      if (
        tokens[index].kind === TokenKind.IDENTIFIER &&
        tokens[index].text === "locals" &&
        tokens[index + 1]?.kind === TokenKind.DOT
      ) {
        usesLocals = true;
        break;
      }
    }
    const hasStruct = localsStructs.has(entry.name);
    if (!usesLocals && !hasStruct) {
      continue;
    }

    diagnostics.push(
      diagnostic(
        "qpi/needs-with-locals",
        hasStruct
          ? `\`${entry.name}\` has a \`${entry.name}_locals\` struct, but \`${entry.plainForm}\` ignores it and re-typedefs \`${entry.name}_locals\` to empty (QPI::NoData). Use \`${entry.withForm}\` so \`locals\` is your struct.`
          : `\`${entry.name}\` uses \`locals\`, but \`${entry.plainForm}\` provides none (locals = empty QPI::NoData). Use \`${entry.withForm}\` and declare \`struct ${entry.name}_locals { … };\`.`,
        entry.macroSpan,
      ),
    );
  }

  return diagnostics;
}

function idlDiagnostics(
  tokens: Token[],
  entries: EntryFunction[],
): SourceAnalysisDiagnostic[] {
  const diagnostics: SourceAnalysisDiagnostic[] = [];
  const registrations = {
    FUNCTION: new Map<number, string>(),
    PROCEDURE: new Map<number, string>(),
  };
  const registered = new Set<string>();

  for (let index = 0; index + 5 < tokens.length; index++) {
    const match = /^REGISTER_USER_(FUNCTION|PROCEDURE)$/.exec(
      tokens[index].text,
    );
    if (
      !match ||
      tokens[index + 1].kind !== TokenKind.L_PAREN ||
      tokens[index + 2].kind !== TokenKind.IDENTIFIER ||
      tokens[index + 3].kind !== TokenKind.COMMA ||
      tokens[index + 4].kind !== TokenKind.INT_LITERAL
    ) {
      continue;
    }

    const kind = match[1] as QpiMacroKind;
    const name = tokens[index + 2].text;
    const id = Number.parseInt(tokens[index + 4].text.replaceAll("'", ""), 10);
    if (!Number.isFinite(id)) {
      continue;
    }

    registered.add(name);
    const previous = registrations[kind].get(id);
    if (previous !== undefined && previous !== name) {
      diagnostics.push(
        diagnostic(
          kind === QpiMacroKind.FUNCTION
            ? "qpi/dup-fn-index"
            : "qpi/dup-proc-index",
          `Duplicate ${kind.toLowerCase()} index ${id} — already used by \`${previous}\`. Each ${kind.toLowerCase()} needs a unique index.`,
          tokens[index + 4].span,
        ),
      );
    } else if (previous === undefined) {
      registrations[kind].set(id, name);
    }
  }

  const publicNames = new Set(
    entries
      .filter((entry) => entry.publicEntry)
      .map((entry) => entry.name),
  );
  for (const entry of entries) {
    if (entry.publicEntry && !registered.has(entry.name)) {
      const kind = entry.macro.includes("FUNCTION")
        ? QpiMacroKind.FUNCTION
        : QpiMacroKind.PROCEDURE;
      diagnostics.push(
        diagnostic(
          "qpi/unregistered",
          `\`${entry.name}\` is defined but never registered — add REGISTER_USER_${kind}(${entry.name}, <index>) so it's callable on-chain.`,
          entry.nameSpan,
        ),
      );
    }
  }

  const forbidden = new Set([
    "Collection",
    "LinkedList",
    "HashMap",
    "HashSet",
  ]);
  for (let index = 0; index + 2 < tokens.length; index++) {
    if (
      tokens[index].kind !== TokenKind.KW_STRUCT ||
      tokens[index + 1].kind !== TokenKind.IDENTIFIER
    ) {
      continue;
    }

    const match = /^(\w+)_(input|output)$/.exec(tokens[index + 1].text);
    if (!match || !publicNames.has(match[1])) {
      continue;
    }

    const open = findNext(tokens, index + 2, TokenKind.L_BRACE, TokenKind.SEMICOLON);
    if (open < 0 || tokens[open].kind !== TokenKind.L_BRACE) {
      continue;
    }
    const close = matchingToken(tokens, open, TokenKind.L_BRACE, TokenKind.R_BRACE);
    if (close < 0) {
      continue;
    }

    for (let cursor = open + 1; cursor < close; cursor++) {
      if (!forbidden.has(tokens[cursor].text)) {
        continue;
      }
      diagnostics.push(
        diagnostic(
          "qpi/public-complex-type",
          `\`${tokens[cursor].text}\` is forbidden in the public interface (\`${tokens[index + 1].text}\`) — complex types can carry inconsistent internal state across the call boundary. Use scalars, \`id\`, \`Array\`, or \`BitArray\`.`,
          tokens[cursor].span,
        ),
      );
    }
  }

  return diagnostics;
}

function findEntryFunctions(tokens: Token[]): EntryFunction[] {
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

function findLocalDeclarations(
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

function isUsingNamespaceQpi(tokens: Token[], index: number): boolean {
  return (
    tokens[index + 1]?.kind === TokenKind.KW_NAMESPACE &&
    tokens[index + 2]?.kind === TokenKind.IDENTIFIER &&
    tokens[index + 2]?.text === "QPI"
  );
}

function matchingToken(
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

function findNext(
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

function diagnostic(
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

function compareDiagnostics(
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

function arrayFix(source: string, offset: number): SourceFix[] | undefined {
  const { start, end, text } = sourceLine(source, offset);
  const replacement = arrayFixForLine(text);
  if (!replacement || replacement === text) {
    return undefined;
  }
  return [
    sourceFix(
      "Convert to Array<T, N>",
      source,
      [{ start, end, newText: replacement }],
      true,
    ),
  ];
}

function divModFix(
  source: string,
  token: Token,
  operator: BinaryOp.DIVIDE | BinaryOp.MODULO,
): SourceFix[] | undefined {
  const line = sourceLine(source, token.span.start);
  const fix = divModFixForLine(
    line.text,
    token.span.start - line.start,
    operator,
  );
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

function sourceFix(
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

function spanFromOffsets(
  source: string,
  start: number,
  end: number,
): Span {
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

function arrayFixForLine(line: string): string | null {
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

function divModFixForLine(
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

  const left = line
    .slice(0, column)
    .match(new RegExp(`(${OPERAND})\\s*$`));
  const right = line
    .slice(column + 1)
    .match(new RegExp(`^\\s*(${OPERAND})`));
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

function moveLocalToWithLocalsEdits(
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
  while (
    nameIndex <= declaration.end &&
    tokens[nameIndex].span.start !== name.span.start
  ) {
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
    equals >= 0
      ? source.slice(tokens[equals].span.end, semicolon.span.start).trim()
      : "";
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

  for (
    let index = entry.bodyOpen + 1;
    index < entry.bodyClose;
    index++
  ) {
    const token = tokens[index];
    if (
      token.kind !== TokenKind.IDENTIFIER ||
      token.text !== name.text ||
      (token.span.start >= typeStart &&
        token.span.end <= semicolon.span.end)
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
