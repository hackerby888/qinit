import type { Span } from "../ast";
import { QpiContextKind, TokenKind } from "../enums";
import { Lexer, type Token } from "../lexer";
import { Preprocessor } from "../preprocess";
import type { MacroDef } from "../frontend/preprocessor/preprocessor-context";

const CALL_KINDS = new Map<string, QpiContextKind>([
  ["CALL_OTHER_CONTRACT_FUNCTION", QpiContextKind.FUNCTION],
  ["CALL_OTHER_CONTRACT_FUNCTION_E", QpiContextKind.FUNCTION],
  ["INVOKE_OTHER_CONTRACT_PROCEDURE", QpiContextKind.PROCEDURE],
  ["INVOKE_OTHER_CONTRACT_PROCEDURE_E", QpiContextKind.PROCEDURE],
]);

export interface SourceContractCall {
  kind: QpiContextKind;
  callee: string;
  entry: string;
  span: Span;
}

export function collectSourceContractCalls(
  source: string,
  contractName: string,
  contractSlot: number,
  macros: Map<string, MacroDef>,
): SourceContractCall[] {
  const activeSource = activeSourceWithStableOffsets(
    source,
    contractName,
    contractSlot,
    macros,
  );
  const tokens = new Lexer(activeSource).tokenize();
  const calls: SourceContractCall[] = [];

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const macro = tokens[tokenIndex];
    const kind = CALL_KINDS.get(macro.text);

    if (kind === undefined || tokens[tokenIndex + 1]?.kind !== TokenKind.L_PAREN) {
      continue;
    }

    const invocation = readInvocation(tokens, tokenIndex + 1);

    if (!invocation) {
      continue;
    }

    const callee = firstIdentifier(invocation.arguments[0]);
    const entry = firstIdentifier(invocation.arguments[1]);

    if (!callee || !entry) {
      continue;
    }

    calls.push({
      kind,
      callee,
      entry,
      span: {
        ...macro.span,
        end: invocation.close.span.end,
      },
    });
    tokenIndex = invocation.closeIndex;
  }

  return calls;
}

function activeSourceWithStableOffsets(
  source: string,
  contractName: string,
  contractSlot: number,
  macros: Map<string, MacroDef>,
): string {
  const preprocessed = new Preprocessor().preprocess({
    source,
    qpiHeader: "",
    contractName,
    contractIndex: contractSlot,
    seedMacros: macros,
    expandMacros: false,
    preserveSourceOffsets: true,
  });

  return preprocessed.slice(1);
}

function readInvocation(
  tokens: Token[],
  openIndex: number,
): {
  arguments: Token[][];
  close: Token;
  closeIndex: number;
} | undefined {
  const arguments_: Token[][] = [[]];
  let depth = 0;

  for (let tokenIndex = openIndex; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex];

    if (token.kind === TokenKind.L_PAREN) {
      depth++;

      if (depth > 1) {
        arguments_[arguments_.length - 1].push(token);
      }
      continue;
    }

    if (token.kind === TokenKind.R_PAREN) {
      depth--;

      if (depth === 0) {
        return {
          arguments: arguments_,
          close: token,
          closeIndex: tokenIndex,
        };
      }

      arguments_[arguments_.length - 1].push(token);
      continue;
    }

    if (depth === 1 && token.kind === TokenKind.COMMA) {
      arguments_.push([]);
      continue;
    }

    if (depth > 0) {
      arguments_[arguments_.length - 1].push(token);
    }
  }

  return undefined;
}

function firstIdentifier(tokens: Token[] | undefined): string | undefined {
  return tokens?.find((token) => token.kind === TokenKind.IDENTIFIER)?.text;
}
