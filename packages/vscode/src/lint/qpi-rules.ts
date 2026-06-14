// Tier-A QPI linter: a single comment/string-aware C++ scanner over the enumerable qpi.h rules
// (qpi.h:18-39 + doc/contracts.md:592-632). ADVISORY by design — it catches the high-confidence,
// low-false-positive violations (forbidden characters + keywords) instantly, in-editor, without a
// compile. The parse-heavy rules (stack-locals, pointers/&, recursion, unprefixed globals) are left
// to Tier-B (`contractverify`) where they're authoritative; flagging them here would false-positive.
//
// Pure (no `vscode`, no Bun) → unit-tested under `bun test`, bundles cleanly into the Node host.

export type QpiSeverity = "warn" | "info";

export interface QpiFinding {
  rule: string;       // stable id, e.g. "qpi/no-division"
  message: string;
  offset: number;     // 0-based offset into the source
  length: number;
  severity: QpiSeverity;
}

const KEYWORDS: Record<string, { rule: string; message: string }> = {
  float: { rule: "qpi/no-float", message: "Floating-point types (`float`/`double`) are forbidden — their arithmetic isn't deterministic." },
  double: { rule: "qpi/no-float", message: "Floating-point types (`float`/`double`) are forbidden — their arithmetic isn't deterministic." },
  union: { rule: "qpi/no-union", message: "`union` is forbidden in QPI (it obscures code audits)." },
  const_cast: { rule: "qpi/no-const-cast", message: "`const_cast` is forbidden in QPI." },
  QpiContext: { rule: "qpi/no-qpicontext", message: "`QpiContext` may not be used directly in a contract." },
};

const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdChar = (c: string) => /[A-Za-z0-9_]/.test(c);

// Scan a contract .h fragment for Tier-A QPI rule violations. The contract is assumed NOT to include
// qpi.h (the extension supplies IntelliSense instead), so a `#` is flagged as a leftover dev include.
export function scanQpi(src: string): QpiFinding[] {
  const out: QpiFinding[] = [];
  const push = (rule: string, message: string, offset: number, length: number, severity: QpiSeverity = "warn") =>
    out.push({ rule, message, offset, length, severity });

  let i = 0;
  let brace = 0; // scope depth (0 = global) — for typedef/using rules
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // --- comments: skip entirely (their contents are not contract code) ---
    if (c === "/" && c2 === "/") { i += 2; while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && c2 === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }

    // --- string / char literals: the literal itself is the violation; skip its body so inner
    //     characters (#, /, etc.) don't double-fire ---
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i++;
      while (i < n && src[i] !== quote) { if (src[i] === "\\") i++; i++; }
      i++; // closing quote
      if (quote === '"') push("qpi/no-string", "String literals (`\"`) are forbidden in QPI — they can address arbitrary memory.", start, Math.max(1, i - start));
      else push("qpi/no-char", "Character literals (`'`) are forbidden in QPI.", start, Math.max(1, i - start));
      continue;
    }

    // --- single-character rules ---
    if (c === "#") {
      push("qpi/no-preprocessor", "Preprocessor directives (`#`) are forbidden. This extension provides IntelliSense without `#include \"qpi.h\"` — remove it before deploying.", i, 1, "info");
      while (i < n && src[i] !== "\n") i++; // skip the rest of the directive — its path string isn't a QPI string literal
      continue;
    }
    if (c === "/") { // not a comment (handled above) -> division (or /=)
      push("qpi/no-division", "The `/` operator is forbidden (division by zero is undefined). Use `div(a, b)`.", i, c2 === "=" ? 2 : 1);
      i += c2 === "=" ? 2 : 1; continue;
    }
    if (c === "%") {
      push("qpi/no-modulo", "The `%` operator is forbidden. Use `mod(a, b)`.", i, c2 === "=" ? 2 : 1);
      i += c2 === "=" ? 2 : 1; continue;
    }
    if (c === "[") { push("qpi/no-brackets", "`[` is forbidden (no low-level arrays / unchecked buffers). Use `Array<T, N>`.", i, 1); i++; continue; }
    if (c === "]") { push("qpi/no-brackets", "`]` is forbidden (no low-level arrays / unchecked buffers). Use `Array<T, N>`.", i, 1); i++; continue; }
    if (c === "." && c2 === "." && src[i + 2] === ".") {
      push("qpi/no-varargs", "Variadic arguments / parameter packs (`...`) are forbidden.", i, 3); i += 3; continue;
    }
    if (c === "{") { brace++; i++; continue; }
    if (c === "}") { brace = Math.max(0, brace - 1); i++; continue; }

    // --- identifiers / keywords ---
    if (isIdStart(c)) {
      const start = i;
      i++;
      while (i < n && isIdChar(src[i])) i++;
      const word = src.slice(start, i);

      if (word.includes("__")) {
        push("qpi/no-dunder", "Double underscores (`__`) are reserved for internal use and forbidden in contracts.", start, word.length);
        continue;
      }
      const kw = KEYWORDS[word];
      if (kw) { push(kw.rule, kw.message, start, word.length); continue; }

      if (brace === 0 && word === "typedef") {
        push("qpi/no-global-typedef", "`typedef` is only allowed in local scope (inside a struct or function).", start, word.length);
        continue;
      }
      if (brace === 0 && word === "using") {
        // `using namespace QPI` at global scope is the one allowed form.
        let j = i;
        while (j < n && /\s/.test(src[j])) j++;
        const rest = src.slice(j, j + 9);
        const allowed = rest.startsWith("namespace") && /\s/.test(src[j + 9] ?? " ");
        if (!allowed) push("qpi/no-global-using", "`using` at global scope is forbidden, except `using namespace QPI`.", start, word.length);
        continue;
      }
      continue;
    }

    i++;
  }

  return out;
}
