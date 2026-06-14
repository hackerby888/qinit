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
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      const directive = src.slice(i, j);
      // The qpi.h dev-include is the sanctioned IntelliSense workaround (doc/contracts.md) and this
      // extension makes it harmless — treat it as an exception (no diagnostic). Every OTHER preprocessor
      // directive stays forbidden. Either way, skip the rest of the line so its path string isn't
      // mis-flagged as a QPI string literal.
      if (!/^#\s*include\s*[<"][^>"]*qpi\.h[>"]/.test(directive)) {
        push("qpi/no-preprocessor", "Preprocessor directives (`#`) are forbidden in QPI (remove before deploying).", i, 1, "info");
      }
      i = j;
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

// Blank comments + string/char literals with spaces (offsets + newlines preserved) so the structural
// regexes below never match inside them.
function blankCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (c === "/" && c2 === "/") { while (i < n && src[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && c2 === "*") {
      out += "  "; i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; }
      if (i < n) { out += "  "; i += 2; }
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c; out += " "; i++;
      while (i < n && src[i] !== q) { if (src[i] === "\\") { out += " "; i++; } out += " "; i++; }
      if (i < n) { out += " "; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

// The contract "functions" whose bodies hold user code (where stack locals are forbidden). Lifecycle
// hooks + PUBLIC/PRIVATE functions/procedures (incl. _WITH_LOCALS — you still can't declare a raw local
// there; you use the `locals` struct).
const FN_MACRO =
  /\b(?:PUBLIC|PRIVATE)_(?:FUNCTION|PROCEDURE)(?:_WITH_LOCALS)?\s*\([^)]*\)|\b(?:INITIALIZE|BEGIN_EPOCH|END_EPOCH|BEGIN_TICK|END_TICK|POST_INCOMING_TRANSFER|EXPAND)\s*\(\s*\)/g;

// [open, close) brace ranges of every contract function body in (already-blanked) src.
function functionBodies(src: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  FN_MACRO.lastIndex = 0;
  while ((m = FN_MACRO.exec(src))) {
    let k = m.index + m[0].length;
    while (k < src.length && src[k] !== "{" && src[k] !== ";") k++;
    if (src[k] !== "{") continue; // no body
    let depth = 0, i = k;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
    }
    ranges.push([k, i]);
  }
  return ranges;
}

const STMT_KEYWORDS = new Set([
  "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "default", "goto",
  "const", "static", "constexpr", "struct", "class", "enum", "union", "typedef", "using", "sizeof", "new",
  "delete", "this", "true", "false", "nullptr", "operator", "template",
]);

// Detect stack-local variable declarations inside QPI function/procedure bodies (forbidden — use the
// *_WITH_LOCALS form + a `<fn>_locals` struct, or store state via `state.mut()`). Conservative: only
// the unambiguous `<Type> <name>;` / `<Type> <name> = …;` / `for (<Type> <name> = …` forms — never
// calls (`foo(...)`), member access (`state.x = …`), or assignments. Restricted to function bodies, so
// struct fields (StateData, *_input/_output/_locals) are never touched.
export function scanLocals(source: string): QpiFinding[] {
  const src = blankCommentsAndStrings(source);
  const out: QpiFinding[] = [];
  const seen = new Set<number>();
  // Trailing `;`/`=` is a LOOKAHEAD so it isn't consumed — otherwise consecutive declarations
  // (`A x; B y;`) would lose the `;` that anchors the next one.
  const decl = /(?:^|[;{})])\s*([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s+([A-Za-z_]\w*)\s*(?=;|=(?!=))/gd;
  const forInit = /\bfor\s*\(\s*([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s+([A-Za-z_]\w*)\s*=(?!=)/gd;

  for (const [s, e] of functionBodies(src)) {
    const body = src.slice(s, e);
    for (const rx of [decl, forInit]) {
      rx.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rx.exec(body))) {
        if (STMT_KEYWORDS.has(m[1]) || STMT_KEYWORDS.has(m[2])) continue;
        const [ns] = m.indices![2];
        const offset = s + ns;
        if (seen.has(offset)) continue;
        seen.add(offset);
        out.push({
          rule: "qpi/stack-local",
          message: `Stack-local \`${m[2]}\` is forbidden in QPI — declare it in a \`<fn>_locals\` struct (use the *_WITH_LOCALS form), or keep state in StateData via \`state.mut()\`.`,
          offset,
          length: m[2].length,
          severity: "warn",
        });
      }
    }
  }
  return out;
}
