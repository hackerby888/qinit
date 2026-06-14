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
      while (i < n && src[i] !== quote) i += src[i] === "\\" ? 2 : 1;
      if (i < n) i++; // consume the closing quote if present
      if (i > n) i = n; // clamp: an unterminated literal / trailing backslash must not overshoot the source
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

      // STATIC_ASSERT(...) / static_assert(...) is a COMPILE-TIME assertion: its message string and
      // its condition (even `/`, `%`) are not runtime QPI violations. Skip the whole call so we don't
      // flag e.g. STATIC_ASSERT(A == B, "A == B"). (qpi.h's STATIC_ASSERT macro accepts a message; real
      // contracts like Pulse.h use it.)
      if (word === "STATIC_ASSERT" || word === "static_assert") {
        let j = i;
        while (j < n && /\s/.test(src[j])) j++;
        if (src[j] === "(") {
          let depth = 0;
          for (; j < n; j++) {
            const ch = src[j];
            if (ch === '"' || ch === "'") { const q = ch; j++; while (j < n && src[j] !== q) { if (src[j] === "\\") j++; j++; } }
            else if (ch === "(") depth++;
            else if (ch === ")") { depth--; if (depth === 0) { j++; break; } }
          }
          i = j;
          continue;
        }
      }

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
      while (i < n && src[i] !== q) {
        if (src[i] === "\\" && i + 1 < n) { out += "  "; i += 2; } // escape: 2 source chars -> 2 spaces
        else { out += " "; i++; }
      }
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
const LIFECYCLE = "INITIALIZE|BEGIN_EPOCH|END_EPOCH|BEGIN_TICK|END_TICK|POST_INCOMING_TRANSFER|PRE_ACQUIRE_SHARES|POST_ACQUIRE_SHARES|PRE_RELEASE_SHARES|POST_RELEASE_SHARES|EXPAND";
const FN_MACRO = new RegExp(
  `\\b(?:PUBLIC|PRIVATE)_(?:FUNCTION|PROCEDURE)(?:_WITH_LOCALS)?\\s*\\([^)]*\\)|\\b(?:${LIFECYCLE})(?:_WITH_LOCALS)?\\s*\\(\\s*\\)`,
  "g",
);

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

// Detect a function/procedure that needs the `_WITH_LOCALS` form but uses the plain one: it either
// defines a `<Name>_locals` struct (which the plain macro re-typedefs to empty `QPI::NoData` → clang's
// cryptic "typedef redefinition") or uses `locals.` in its body (which would be empty). Turn that into
// an actionable hint pointing at `_WITH_LOCALS`.
export function scanLocalsForm(source: string): QpiFinding[] {
  const src = blankCommentsAndStrings(source);
  const out: QpiFinding[] = [];

  const userLocals = new Set<string>(); // names with a user-defined `struct <Name>_locals`
  for (const m of src.matchAll(/\bstruct\s+(\w+)_locals\b/g)) userLocals.add(m[1]);

  // For one plain (non-_WITH_LOCALS) function/hook: flag it if its body uses `locals.` or a
  // `<name>_locals` struct exists — both mean the author needs the _WITH_LOCALS form.
  const check = (name: string, plainForm: string, withForm: string, afterMacro: number, span: [number, number]) => {
    let usesLocals = false;
    let k = afterMacro;
    while (k < src.length && src[k] !== "{" && src[k] !== ";") k++;
    if (src[k] === "{") {
      let depth = 0, i = k;
      for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (!depth) { i++; break; } } }
      usesLocals = /\blocals\s*\./.test(src.slice(k, i));
    }
    if (!usesLocals && !userLocals.has(name)) return;
    out.push({
      rule: "qpi/needs-with-locals",
      message: userLocals.has(name)
        ? `\`${name}\` has a \`${name}_locals\` struct, but \`${plainForm}\` ignores it and re-typedefs \`${name}_locals\` to empty (QPI::NoData). Use \`${withForm}\` so \`locals\` is your struct.`
        : `\`${name}\` uses \`locals\`, but \`${plainForm}\` provides none (locals = empty QPI::NoData). Use \`${withForm}\` and declare \`struct ${name}_locals { … };\`.`,
      offset: span[0],
      length: span[1] - span[0],
      severity: "warn",
    });
  };

  let m: RegExpExecArray | null;
  // Named user functions/procedures: PUBLIC/PRIVATE_FUNCTION/PROCEDURE(Name).
  const namedRe = /\b(PUBLIC|PRIVATE)_(FUNCTION|PROCEDURE)(_WITH_LOCALS)?\s*\(\s*(\w+)\s*\)/gd;
  while ((m = namedRe.exec(src))) {
    if (m[3]) continue; // already _WITH_LOCALS
    const form = `${m[1]}_${m[2]}`;
    check(m[4], `${form}(${m[4]})`, `${form}_WITH_LOCALS(${m[4]})`, m.index + m[0].length, m.indices![0]);
  }
  // Lifecycle hooks: INITIALIZE() etc. — the hook name itself is the `<name>_locals` base.
  const lifeRe = new RegExp(`\\b(${LIFECYCLE})(_WITH_LOCALS)?\\s*\\(\\s*\\)`, "gd");
  while ((m = lifeRe.exec(src))) {
    if (m[2]) continue; // already _WITH_LOCALS
    check(m[1], `${m[1]}()`, `${m[1]}_WITH_LOCALS()`, m.index + m[0].length, m.indices![0]);
  }
  return out;
}

// Detect stack-local variable declarations inside QPI function/procedure bodies (forbidden — use the
// *_WITH_LOCALS form + a `<fn>_locals` struct, or store state via `state.mut()`). Conservative: only
// the unambiguous `<Type> <name>;` / `<Type> <name> = …;` / `for (<Type> <name> = …` forms — never
// calls (`foo(...)`), member access (`state.x = …`), or assignments. Restricted to function bodies, so
// struct fields (StateData, *_input/_output/_locals) are never touched.
export function scanLocals(source: string): QpiFinding[] {
  const src = blankCommentsAndStrings(source);
  const out: QpiFinding[] = [];
  const seen = new Set<number>();
  // A type may be templated — `Array<uint64, 4>`, `HashMap<id, V, 1024>`, `QPI::Array<…>` (one level
  // of `<>` nesting). Without this, `Array<…> x;` slips past the stack-local check.
  const TYPE = "[A-Za-z_]\\w*(?:::[A-Za-z_]\\w*)*(?:\\s*<(?:[^<>]|<[^<>]*>)*>)?";
  // Trailing `;`/`=` is a LOOKAHEAD so it isn't consumed — otherwise consecutive declarations
  // (`A x; B y;`) would lose the `;` that anchors the next one.
  const decl = new RegExp(`(?:^|[;{})])\\s*(${TYPE})\\s+([A-Za-z_]\\w*)\\s*(?=;|=(?!=))`, "gd");
  const forInit = new RegExp(`\\bfor\\s*\\(\\s*(${TYPE})\\s+([A-Za-z_]\\w*)\\s*=(?!=)`, "gd");

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
