import type { Diagnostic as ParserDiagnostic } from "../parser";

export const USER_BOUNDARY = "__QINIT_USER_BOUNDARY__";

export function sourceWithoutLeadingBom(source: string): string {
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineIndexAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid;
  }
  return lo;
}

function lineText(source: string, starts: number[], index: number): string {
  const start = starts[index] ?? source.length;
  const next = starts[index + 1] ?? source.length;
  const end = next > start && source.charCodeAt(next - 1) === 10 ? next - 1 : next;
  return source.slice(start, end);
}

function mapGeneratedColumn(original: string, generated: string, column: number): number {
  const generatedColumn = Math.max(0, Math.min(column, generated.length));
  let prefix = 0;
  while (
    prefix < original.length &&
    prefix < generated.length &&
    original[prefix] === generated[prefix]
  )
    prefix++;

  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < generated.length - prefix &&
    original[original.length - 1 - suffix] === generated[generated.length - 1 - suffix]
  )
    suffix++;

  if (generatedColumn <= prefix) return generatedColumn;
  const generatedMiddleEnd = generated.length - suffix;
  const originalMiddleEnd = original.length - suffix;
  if (generatedColumn >= generatedMiddleEnd) {
    return Math.max(
      prefix,
      Math.min(original.length, originalMiddleEnd + generatedColumn - generatedMiddleEnd),
    );
  }
  return prefix;
}

export function makeUserDiagnosticRemapper(
  originalSource: string,
  generatedSource: string,
  boundaryLine: number,
): (diagnostic: ParserDiagnostic) => ParserDiagnostic {
  const originalStarts = lineStarts(originalSource);
  const generatedStarts = lineStarts(generatedSource);

  const mapOffset = (generatedOffset: number): { offset: number; line: number; col: number } => {
    const safeGeneratedOffset = Math.max(0, Math.min(generatedOffset, generatedSource.length));
    const generatedLineIndex = lineIndexAt(generatedStarts, safeGeneratedOffset);
    const userLineIndex = generatedLineIndex - boundaryLine;
    if (userLineIndex < 0) return { offset: 0, line: 1, col: 1 };
    if (userLineIndex >= originalStarts.length) {
      const lastLine = originalStarts.length - 1;
      return {
        offset: originalSource.length,
        line: lastLine + 1,
        col: originalSource.length - originalStarts[lastLine] + 1,
      };
    }

    const generatedLine = lineText(generatedSource, generatedStarts, generatedLineIndex);
    const originalLine = lineText(originalSource, originalStarts, userLineIndex);
    const generatedColumn = safeGeneratedOffset - generatedStarts[generatedLineIndex];
    const originalColumn = mapGeneratedColumn(originalLine, generatedLine, generatedColumn);
    return {
      offset: Math.min(originalSource.length, originalStarts[userLineIndex] + originalColumn),
      line: userLineIndex + 1,
      col: originalColumn + 1,
    };
  };

  return (diagnostic: ParserDiagnostic): ParserDiagnostic => {
    if (diagnostic.span.line <= 0) return diagnostic;
    const hasOffsets = diagnostic.span.start !== 0 || diagnostic.span.end !== 0;
    const generatedLineIndex = Math.max(
      0,
      Math.min(diagnostic.span.line - 1, generatedStarts.length - 1),
    );
    const lineOnlyOffset =
      generatedStarts[generatedLineIndex] + Math.max(0, diagnostic.span.col - 1);
    const start = mapOffset(hasOffsets ? diagnostic.span.start : lineOnlyOffset);
    const end = mapOffset(hasOffsets ? diagnostic.span.end : lineOnlyOffset);
    return {
      ...diagnostic,
      span: {
        start: start.offset,
        end: Math.max(start.offset, end.offset),
        line: start.line,
        col: start.col,
      },
    };
  };
}

export function scanUnterminatedSource(source: string): ParserDiagnostic[] {
  const diagnostics: ParserDiagnostic[] = [];
  const starts = lineStarts(source);
  const directives: Array<{ name: string; start: number; end: number }> = [];
  const conditionalStack: Array<{ name: string; start: number; end: number }> = [];
  let state: "normal" | "line_comment" | "block_comment" | "string" | "char" = "normal";
  let blockCommentStart = -1;
  let escaped = false;
  let lineHasOnlyWhitespace = true;

  const addDiagnostic = (message: string, start: number, end: number) => {
    if (diagnostics.length >= 128) return;
    const safeStart = Math.max(0, Math.min(start, source.length));
    const safeEnd = Math.max(safeStart, Math.min(end, source.length));
    const lineIndex = lineIndexAt(starts, safeStart);
    diagnostics.push({
      severity: "error",
      message,
      span: {
        start: safeStart,
        end: safeEnd,
        line: lineIndex + 1,
        col: safeStart - starts[lineIndex] + 1,
      },
    });
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "line_comment") {
      if (ch === "\n") {
        state = "normal";
        lineHasOnlyWhitespace = true;
      }
      continue;
    }
    if (state === "block_comment") {
      if (ch === "*" && next === "/") {
        state = "normal";
        i++;
      } else if (ch === "\n") lineHasOnlyWhitespace = true;
      continue;
    }
    if (state === "string" || state === "char") {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if ((state === "string" && ch === '"') || (state === "char" && ch === "'"))
        state = "normal";
      else if (ch === "\n") {
        state = "normal";
        lineHasOnlyWhitespace = true;
      }
      continue;
    }
    if (ch === "\n") {
      lineHasOnlyWhitespace = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\f" || ch === "\v") continue;
    if (ch === "/" && next === "/") {
      state = "line_comment";
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "block_comment";
      blockCommentStart = i;
      i++;
      continue;
    }
    if (ch === '"') {
      state = "string";
      escaped = false;
      lineHasOnlyWhitespace = false;
      continue;
    }
    if (ch === "'") {
      state = "char";
      escaped = false;
      lineHasOnlyWhitespace = false;
      continue;
    }
    if (ch === "#" && lineHasOnlyWhitespace) {
      const lineEnd = source.indexOf("\n", i);
      const match = /^#[ \t]*([A-Za-z_][A-Za-z0-9_]*)/.exec(
        source.slice(i, lineEnd < 0 ? source.length : lineEnd),
      );
      if (match) directives.push({ name: match[1], start: i, end: i + match[0].length });
    }
    lineHasOnlyWhitespace = false;
  }

  if (state === "block_comment")
    addDiagnostic(
      "unterminated block comment",
      blockCommentStart,
      Math.min(source.length, blockCommentStart + 2),
    );
  for (const directive of directives) {
    if (directive.name === "if" || directive.name === "ifdef" || directive.name === "ifndef") {
      conditionalStack.push(directive);
    } else if (directive.name === "endif") {
      if (conditionalStack.length === 0)
        addDiagnostic("unmatched #endif", directive.start, directive.end);
      else conditionalStack.pop();
    } else if (
      (directive.name === "else" || directive.name === "elif") &&
      conditionalStack.length === 0
    ) {
      addDiagnostic(`unmatched #${directive.name}`, directive.start, directive.end);
    }
  }
  for (const directive of conditionalStack)
    addDiagnostic(`unterminated #${directive.name} directive`, directive.start, directive.end);
  return diagnostics.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
}
