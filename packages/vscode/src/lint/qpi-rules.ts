export type QpiSeverity = "warn" | "info";

export interface QpiFinding {
  rule: string;
  message: string;
  offset: number;
  length: number;
  severity: QpiSeverity;
}

const KEYWORDS: Record<string, { rule: string; message: string }> = {
  float: {
    rule: "qpi/no-float",
    message:
      "Floating-point types (`float`/`double`) are forbidden — their arithmetic isn't deterministic.",
  },
  double: {
    rule: "qpi/no-float",
    message:
      "Floating-point types (`float`/`double`) are forbidden — their arithmetic isn't deterministic.",
  },
  union: {
    rule: "qpi/no-union",
    message: "`union` is forbidden in QPI (it obscures code audits).",
  },
  const_cast: { rule: "qpi/no-const-cast", message: "`const_cast` is forbidden in QPI." },
  QpiContext: {
    rule: "qpi/no-qpicontext",
    message: "`QpiContext` may not be used directly in a contract.",
  },
};

const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdChar = (c: string) => /[A-Za-z0-9_]/.test(c);

export function scanQpi(src: string): QpiFinding[] {
  const out: QpiFinding[] = [];
  const push = (
    rule: string,
    message: string,
    offset: number,
    length: number,
    severity: QpiSeverity = "warn",
  ) => out.push({ rule, message, offset, length, severity });

  let i = 0;
  let brace = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (c === "/" && c2 === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // C++ digit separators are part of numeric literals.
    if (c === "'" && /[0-9a-fA-F]/.test(src[i - 1] ?? "") && /[0-9a-fA-F]/.test(src[i + 1] ?? "")) {
      i++;
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i++;
      while (i < n && src[i] !== quote) i += src[i] === "\\" ? 2 : 1;
      if (i < n) i++;
      if (i > n) i = n;
      if (quote === '"')
        push(
          "qpi/no-string",
          'String literals (`"`) are forbidden in QPI — they can address arbitrary memory.',
          start,
          Math.max(1, i - start),
        );
      else
        push(
          "qpi/no-char",
          "Character literals (`'`) are forbidden in QPI.",
          start,
          Math.max(1, i - start),
        );
      continue;
    }

    if (c === "#") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      const directive = src.slice(i, j);
      if (!/^#\s*include\s*[<"][^>"]*qpi\.h[>"]/.test(directive)) {
        push(
          "qpi/no-preprocessor",
          "Preprocessor directives (`#`) are forbidden in QPI (remove before deploying).",
          i,
          1,
          "info",
        );
      }
      i = j;
      continue;
    }
    if (c === "/") {
      push(
        "qpi/no-division",
        "The `/` operator is forbidden (division by zero is undefined). Use `div(a, b)`.",
        i,
        c2 === "=" ? 2 : 1,
      );
      i += c2 === "=" ? 2 : 1;
      continue;
    }
    if (c === "%") {
      push(
        "qpi/no-modulo",
        "The `%` operator is forbidden. Use `mod(a, b)`.",
        i,
        c2 === "=" ? 2 : 1,
      );
      i += c2 === "=" ? 2 : 1;
      continue;
    }
    if (c === "[") {
      push(
        "qpi/no-brackets",
        "`[` is forbidden (no low-level arrays / unchecked buffers). Use `Array<T, N>`.",
        i,
        1,
      );
      i++;
      continue;
    }
    if (c === "]") {
      push(
        "qpi/no-brackets",
        "`]` is forbidden (no low-level arrays / unchecked buffers). Use `Array<T, N>`.",
        i,
        1,
      );
      i++;
      continue;
    }
    if (c === "." && c2 === "." && src[i + 2] === ".") {
      push("qpi/no-varargs", "Variadic arguments / parameter packs (`...`) are forbidden.", i, 3);
      i += 3;
      continue;
    }
    if (c === "{") {
      brace++;
      i++;
      continue;
    }
    if (c === "}") {
      brace = Math.max(0, brace - 1);
      i++;
      continue;
    }

    if (isIdStart(c)) {
      const start = i;
      i++;
      while (i < n && isIdChar(src[i])) i++;
      const word = src.slice(start, i);

      // Static-assert expressions are not runtime QPI code.
      if (word === "STATIC_ASSERT" || word === "static_assert") {
        let j = i;
        while (j < n && /\s/.test(src[j])) j++;
        if (src[j] === "(") {
          let depth = 0;
          for (; j < n; j++) {
            const ch = src[j];
            if (ch === '"' || ch === "'") {
              const q = ch;
              j++;
              while (j < n && src[j] !== q) {
                if (src[j] === "\\") j++;
                j++;
              }
            } else if (ch === "(") depth++;
            else if (ch === ")") {
              depth--;
              if (depth === 0) {
                j++;
                break;
              }
            }
          }
          i = j;
          continue;
        }
      }

      if (word.includes("__")) {
        push(
          "qpi/no-dunder",
          "Double underscores (`__`) are reserved for internal use and forbidden in contracts.",
          start,
          word.length,
        );
        continue;
      }
      const kw = KEYWORDS[word];
      if (kw) {
        push(kw.rule, kw.message, start, word.length);
        continue;
      }

      if (brace === 0 && word === "typedef") {
        push(
          "qpi/no-global-typedef",
          "`typedef` is only allowed in local scope (inside a struct or function).",
          start,
          word.length,
        );
        continue;
      }
      if (brace === 0 && word === "using") {
        let j = i;
        while (j < n && /\s/.test(src[j])) j++;
        const rest = src.slice(j, j + 9);
        const allowed = rest.startsWith("namespace") && /\s/.test(src[j + 9] ?? " ");
        if (!allowed)
          push(
            "qpi/no-global-using",
            "`using` at global scope is forbidden, except `using namespace QPI`.",
            start,
            word.length,
          );
        continue;
      }
      continue;
    }

    i++;
  }

  return out;
}

export function blankCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i],
      c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && c2 === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      out += " ";
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\" && i + 1 < n) {
          out += "  ";
          i += 2;
        } else {
          out += " ";
          i++;
        }
      }
      if (i < n) {
        out += " ";
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const LIFECYCLE =
  "INITIALIZE|BEGIN_EPOCH|END_EPOCH|BEGIN_TICK|END_TICK|POST_INCOMING_TRANSFER|PRE_ACQUIRE_SHARES|POST_ACQUIRE_SHARES|PRE_RELEASE_SHARES|POST_RELEASE_SHARES|EXPAND";
const FN_MACRO = new RegExp(
  `\\b(?:PUBLIC|PRIVATE)_(?:FUNCTION|PROCEDURE)(?:_WITH_LOCALS)?\\s*\\([^)]*\\)|\\b(?:${LIFECYCLE})(?:_WITH_LOCALS)?\\s*\\(\\s*\\)`,
  "g",
);

function functionBodies(src: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  FN_MACRO.lastIndex = 0;
  while ((m = FN_MACRO.exec(src))) {
    let k = m.index + m[0].length;
    while (k < src.length && src[k] !== "{" && src[k] !== ";") k++;
    if (src[k] !== "{") continue;
    let depth = 0,
      i = k;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    ranges.push([k, i]);
  }
  return ranges;
}

export interface EnclosingFn {
  name: string | null;
  withLocals: boolean;
  macroStart: number;
  macroEnd: number;
  bodyStart: number;
  bodyEnd: number;
}

export function enclosingFunction(source: string, offset: number): EnclosingFn | null {
  const src = blankCommentsAndStrings(source);
  FN_MACRO.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FN_MACRO.exec(src))) {
    let k = m.index + m[0].length;
    while (k < src.length && src[k] !== "{" && src[k] !== ";") k++;
    if (src[k] !== "{") continue;
    let depth = 0,
      i = k;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (!depth) {
          i++;
          break;
        }
      }
    }
    if (offset >= k && offset < i) {
      const named = m[0].match(
        /(?:PUBLIC|PRIVATE)_(?:FUNCTION|PROCEDURE)(_WITH_LOCALS)?\s*\(\s*(\w+)\s*\)/,
      );
      const life = m[0].match(new RegExp(`(${LIFECYCLE})(_WITH_LOCALS)?\\s*\\(\\s*\\)`));
      return {
        name: named ? named[2] : life ? life[1] : null,
        withLocals: named ? !!named[1] : life ? !!life[2] : false,
        macroStart: m.index,
        macroEnd: m.index + m[0].length,
        bodyStart: k,
        bodyEnd: i,
      };
    }
  }
  return null;
}

const STMT_KEYWORDS = new Set([
  "return",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "default",
  "goto",
  "const",
  "static",
  "constexpr",
  "struct",
  "class",
  "enum",
  "union",
  "typedef",
  "using",
  "sizeof",
  "new",
  "delete",
  "this",
  "true",
  "false",
  "nullptr",
  "operator",
  "template",
]);

export function scanLocalsForm(source: string): QpiFinding[] {
  const src = blankCommentsAndStrings(source);
  const out: QpiFinding[] = [];

  const userLocals = new Set<string>();
  for (const m of src.matchAll(/\bstruct\s+(\w+)_locals\b/g)) userLocals.add(m[1]);

  const check = (
    name: string,
    plainForm: string,
    withForm: string,
    afterMacro: number,
    span: [number, number],
  ) => {
    let usesLocals = false;
    let k = afterMacro;
    while (k < src.length && src[k] !== "{" && src[k] !== ";") k++;
    if (src[k] === "{") {
      let depth = 0,
        i = k;
      for (; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
          depth--;
          if (!depth) {
            i++;
            break;
          }
        }
      }
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
  const namedRe = /\b(PUBLIC|PRIVATE)_(FUNCTION|PROCEDURE)(_WITH_LOCALS)?\s*\(\s*(\w+)\s*\)/dg;
  while ((m = namedRe.exec(src))) {
    if (m[3]) continue;
    const form = `${m[1]}_${m[2]}`;
    check(
      m[4],
      `${form}(${m[4]})`,
      `${form}_WITH_LOCALS(${m[4]})`,
      m.index + m[0].length,
      m.indices![0],
    );
  }
  const lifeRe = new RegExp(`\\b(${LIFECYCLE})(_WITH_LOCALS)?\\s*\\(\\s*\\)`, "gd");
  while ((m = lifeRe.exec(src))) {
    if (m[2]) continue;
    check(m[1], `${m[1]}()`, `${m[1]}_WITH_LOCALS()`, m.index + m[0].length, m.indices![0]);
  }
  return out;
}

export function scanLocals(source: string): QpiFinding[] {
  const src = blankCommentsAndStrings(source);
  const out: QpiFinding[] = [];
  const seen = new Set<number>();
  // Match one nested template level without parsing C++.
  const TYPE = "[A-Za-z_]\\w*(?:::[A-Za-z_]\\w*)*(?:\\s*<(?:[^<>]|<[^<>]*>)*>)?";
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
