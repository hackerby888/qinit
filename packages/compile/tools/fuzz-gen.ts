// Seeded differential-fuzzer generator: deterministic source/input vectors from a seed.

export interface FuzzContract {
  seed: number;
  source: string;
  inputs: bigint[][];
}

interface ScalarType {
  name: string;
  width: 1 | 2 | 4 | 8;
  signed: boolean;
}

interface LocalVar {
  name: string;
  type: ScalarType;
  mutable: boolean;
}

interface HelperSig {
  name: string;
  ret: ScalarType;
  params: { name: string; type: ScalarType }[];
}

const TYPES: ScalarType[] = [
  { name: "sint8", width: 1, signed: true },
  { name: "uint8", width: 1, signed: false },
  { name: "sint16", width: 2, signed: true },
  { name: "uint16", width: 2, signed: false },
  { name: "sint32", width: 4, signed: true },
  { name: "uint32", width: 4, signed: false },
  { name: "sint64", width: 8, signed: true },
  { name: "uint64", width: 8, signed: false },
];

// math_lib only provides sadd/smul overloads for the 32- and 64-bit widths.
const SAFE_MATH_TYPES = TYPES.filter((t) => t.width >= 4);
const UNSIGNED_DIV_TYPES = TYPES.filter((t) => t.width >= 4 && !t.signed);

const BOUNDARY_VALUES: bigint[] = [
  0n, 1n, 2n, 3n, 7n, 8n, 15n, 31n, 42n, 63n, 100n, 127n, 128n, 255n, 256n,
  1000n, 32767n, 32768n, 65535n, 65536n, 1000000n,
  2147483647n, 2147483648n, 4294967295n, 4294967296n,
  9223372036854775807n, 18446744073709551615n,
];

const INPUT_BOUNDARIES: bigint[] = [
  0n, 1n, 2n, 127n, 128n, 255n, 32767n, 32768n, 65535n,
  2147483647n, 2147483648n, 4294967295n, 4294967296n,
  9223372036854775807n, 9223372036854775808n, 18446744073709551615n,
];

const INT64_MAX = 9223372036854775807n;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Gen {
  private next: () => number;
  private nameCounter = 0;
  private scopes: LocalVar[][] = [];
  private stmtBudget = 0;
  private avail: HelperSig[] = [];
  private inHelper = false;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  private int(n: number): number {
    return Math.floor(this.next() * n);
  }

  private pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  private chance(p: number): boolean {
    return this.next() < p;
  }

  private u64(): bigint {
    const hi = BigInt(Math.floor(this.next() * 0x100000000));
    const lo = BigInt(Math.floor(this.next() * 0x100000000));
    return (hi << 32n) | lo;
  }

  private freshName(prefix: string): string {
    return `${prefix}${this.nameCounter++}`;
  }

  private visibleVars(): LocalVar[] {
    return this.scopes.flat();
  }

  private mutableVars(): LocalVar[] {
    return this.visibleVars().filter((v) => v.mutable);
  }

  // ---- expressions ----

  private literal(): string {
    let v: bigint;
    if (this.chance(0.7)) {
      v = this.pick(BOUNDARY_VALUES);
    } else if (this.chance(0.4)) {
      v = BigInt(this.int(256));
    } else if (this.chance(0.5)) {
      v = BigInt(this.int(0x100000000));
    } else {
      v = this.u64();
    }

    const suffixes = v > INT64_MAX ? ["u", "ull"] : ["", "", "", "u", "ll", "ull"];
    return `${v}${this.pick(suffixes)}`;
  }

  private leaf(): string {
    // qpi.h `bit` is a struct with implicit bool conversion; mixing it into arbitrary expressions (ternary branches especially) is
    const vars = this.visibleVars().filter((v) => v.type.name !== "bit");
    const r = this.next();
    if (r < 0.3 && vars.length > 0) {
      return this.pick(vars).name;
    }
    if (r < 0.45 && !this.inHelper) {
      return `input.${this.pick(["a", "b", "c", "d"])}`;
    }
    return this.literal();
  }

  // Shift counts stay C++-defined for generated operand widths.
  private shiftCount(depth: number): string {
    if (this.chance(0.4)) {
      return `(${this.expression(depth)} & 31)`;
    }
    return `${this.int(32)}`;
  }

  private expression(depth: number): string {
    if (depth <= 0) {
      return this.leaf();
    }

    const d = depth - 1;
    const r = this.next();
    if (r < 0.28) {
      const operator = this.pick(["+", "-", "*", "&", "|", "^"]);
      return `(${this.expression(d)} ${operator} ${this.expression(d)})`;
    }
    if (r < 0.36) {
      const operator = this.pick(["<", ">", "<=", ">=", "==", "!="]);
      return `(${this.expression(d)} ${operator} ${this.expression(d)})`;
    }
    if (r < 0.42) {
      const operator = this.pick(["<<", ">>"]);
      return `(${this.expression(d)} ${operator} ${this.shiftCount(d)})`;
    }
    if (r < 0.47) {
      const t = this.pick(UNSIGNED_DIV_TYPES);
      const operator = this.pick(["/", "%"]);
      const one = t.width === 4 ? "1u" : "1ull";
      return `((${t.name})(${this.expression(d)}) ${operator} (((${t.name})(${this.expression(d)})) | ${one}))`;
    }
    if (r < 0.53) {
      return `((${this.expression(d)}) ? (${this.expression(d)}) : (${this.expression(d)}))`;
    }
    if (r < 0.6) {
      const t = this.pick(TYPES);
      return `(${t.name})(${this.expression(d)})`;
    }
    if (r < 0.67) {
      const operator = this.pick(["-", "~", "!"]);
      return `(${operator}(${this.expression(d)}))`;
    }
    if (r < 0.72) {
      const operator = this.pick(["&&", "||"]);
      return `(${this.expression(d)} ${operator} ${this.expression(d)})`;
    }
    if (r < 0.79) {
      const t = this.pick(SAFE_MATH_TYPES);
      const fn = this.pick(["sadd", "smul"]);
      return `${fn}((${t.name})(${this.expression(d)}), (${t.name})(${this.expression(d)}))`;
    }
    if (r < 0.86) {
      const t = this.pick(UNSIGNED_DIV_TYPES);
      const fn = this.pick(["div", "mod"]);
      const targ = this.chance(0.3) ? `<${t.name}>` : "";
      return `${fn}${targ}((${t.name})(${this.expression(d)}), (${t.name})(${this.expression(d)}))`;
    }
    if (r < 0.93) {
      const t = this.pick(TYPES);
      const fn = this.pick(["math_lib::min", "math_lib::max"]);
      const targ = this.chance(0.3) ? `<${t.name}>` : "";
      return `${fn}${targ}((${t.name})(${this.expression(d)}), (${t.name})(${this.expression(d)}))`;
    }
    if (r < 0.98 && this.avail.length > 0) {
      return this.helperCall(d);
    }
    return this.leaf();
  }

  // Arguments are cast exactly to the chosen signature, so native resolves the same overload.
  private helperCall(depth: number): string {
    const sig = this.pick(this.avail);
    const callArguments = sig.params.map((p) => `(${p.type.name})(${this.expression(depth)})`);
    return `${sig.name}(${callArguments.join(", ")})`;
  }

  // ---- statements ----

  private declStmt(indent: string): string {
    const bitDecl = this.chance(0.05);
    const name = this.freshName("l");

    if (bitDecl) {
      const v: LocalVar = { name, type: { name: "bit", width: 1, signed: false }, mutable: false };
      this.scopes[this.scopes.length - 1].push(v);
      return `${indent}bit ${name} = (bit)(${this.expression(3)});`;
    }

    const t = this.pick(TYPES);
    const initializer = this.chance(0.5) ? `(${t.name})(${this.expression(3)})` : this.expression(3);
    this.scopes[this.scopes.length - 1].push({ name, type: t, mutable: true });
    return `${indent}${t.name} ${name} = ${initializer};`;
  }

  private assignStmt(indent: string): string {
    const v = this.pick(this.mutableVars());
    const rhs = this.chance(0.4) ? `(${v.type.name})(${this.expression(3)})` : this.expression(3);
    return `${indent}${v.name} = ${rhs};`;
  }

  private compoundStmt(indent: string): string {
    const v = this.pick(this.mutableVars());
    const operator = this.pick(["+=", "-=", "*=", "&=", "|=", "^=", "<<=", ">>="]);
    if (operator === "<<=" || operator === ">>=") {
      const mask = v.type.width === 8 ? 63 : 31;
      return `${indent}${v.name} ${operator} ((${this.expression(2)}) & ${mask});`;
    }
    return `${indent}${v.name} ${operator} ${this.expression(2)};`;
  }

  private incDecStmt(indent: string): string {
    const v = this.pick(this.mutableVars());
    const operator = this.pick(["++", "--"]);
    const r = this.next();
    if (r < 0.5) {
      return this.chance(0.5) ? `${indent}${v.name}${operator};` : `${indent}${operator}${v.name};`;
    }

    const targets = this.mutableVars().filter((t) => t.name !== v.name);
    if (targets.length === 0) {
      return `${indent}${v.name}${operator};`;
    }
    const dst = this.pick(targets);
    const form = this.chance(0.5) ? `${v.name}${operator}` : `${operator}${v.name}`;
    return this.chance(0.5)
      ? `${indent}${dst.name} = ${form};`
      : `${indent}${dst.name} = (${form}) + ${this.literal()};`;
  }

  private ifStmt(indent: string, depth: number): string {
    const condition = this.expression(2);
    const body = this.block(indent, depth, 1 + this.int(3));
    if (this.chance(0.4)) {
      const els = this.block(indent, depth, 1 + this.int(2));
      return `${indent}if (${condition})\n${body}\n${indent}else\n${els}`;
    }
    return `${indent}if (${condition})\n${body}`;
  }

  private forStmt(indent: string, depth: number): string {
    const iv = this.freshName("i");
    const bound = 1 + this.int(8);
    this.scopes.push([{ name: iv, type: TYPES[4], mutable: false }]);
    const inner = indent + "  ";
    const lines: string[] = [];
    const count = 1 + this.int(3);
    for (let k = 0; k < count && this.stmtBudget > 0; k++) {
      lines.push(this.statement(inner, depth - 1));
    }
    this.scopes.pop();
    return `${indent}for (sint32 ${iv} = 0; ${iv} < ${bound}; ${iv}++) {\n${lines.join("\n")}\n${indent}}`;
  }

  private switchStmt(indent: string): string {
    const caseCount = 2 + this.int(3);
    const mask = caseCount === 2 ? 1 : 3;
    const inner = indent + "  ";
    const lines: string[] = [`${indent}switch ((sint32)((${this.expression(2)}) & ${mask})) {`];

    for (let c = 0; c < caseCount; c++) {
      lines.push(`${indent}case ${c}:`);
      const n = 1 + this.int(2);
      for (let k = 0; k < n; k++) {
        this.stmtBudget--;
        lines.push(this.assignStmt(inner));
      }
      if (this.chance(0.8)) {
        lines.push(`${inner}break;`);
      }
    }

    lines.push(`${indent}default:`);
    this.stmtBudget--;
    lines.push(this.assignStmt(inner));
    lines.push(`${inner}break;`);
    lines.push(`${indent}}`);
    return lines.join("\n");
  }

  private block(indent: string, depth: number, count: number): string {
    this.scopes.push([]);
    const inner = indent + "  ";
    const lines: string[] = [];
    for (let k = 0; k < count && this.stmtBudget > 0; k++) {
      lines.push(this.statement(inner, depth - 1));
    }
    this.scopes.pop();
    return `${indent}{\n${lines.join("\n")}\n${indent}}`;
  }

  private statement(indent: string, depth: number): string {
    this.stmtBudget--;
    const canMutate = this.mutableVars().length > 0;
    const r = this.next();

    if (!canMutate || r < 0.22) {
      return this.declStmt(indent);
    }
    if (r < 0.44) {
      return this.assignStmt(indent);
    }
    if (r < 0.58) {
      return this.compoundStmt(indent);
    }
    if (r < 0.68) {
      return this.incDecStmt(indent);
    }
    if (depth <= 0) {
      return this.assignStmt(indent);
    }
    if (r < 0.78) {
      return this.ifStmt(indent, depth);
    }
    if (r < 0.86) {
      return this.forStmt(indent, depth);
    }
    if (r < 0.93) {
      return this.switchStmt(indent);
    }
    return this.block(indent, depth, 1 + this.int(3));
  }

  // ---- helper functions ----

  // A helper body sees only its params (immutable) and its own locals — no input/state. Bodies of
  private helperDef(sig: HelperSig): string {
    this.stmtBudget = 5;
    this.inHelper = true;
    this.scopes = [sig.params.map((p) => ({ name: p.name, type: p.type, mutable: false }))];

    const lines: string[] = [];
    const count = this.int(3);
    for (let k = 0; k < count && this.stmtBudget > 0; k++) {
      lines.push(this.statement("    ", 1));
    }
    const ret = this.chance(0.5) ? `(${sig.ret.name})(${this.expression(3)})` : this.expression(3);
    lines.push(`    return ${ret};`);
    this.inHelper = false;

    const params = sig.params.map((p) => `${p.type.name} ${p.name}`).join(", ");
    return `  static ${sig.ret.name} ${sig.name}(${params})\n  {\n${lines.join("\n")}\n  }`;
  }

  private genHelpers(): string[] {
    const defs: string[] = [];
    const count = 1 + this.int(3);
    for (let k = 0; k < count; k++) {
      const name = `fn${k}`;
      const params = Array.from({ length: 1 + this.int(2) }, () => ({ name: this.freshName("p"), type: this.pick(TYPES) }));
      const base: HelperSig = { name, ret: this.pick(TYPES), params };
      defs.push(this.helperDef(base));
      this.avail.push(base);

      if (this.chance(0.3)) {
        // The overload keeps the parameter count but guarantees a different first parameter type, so the signatures differ and
        const p2 = params.map((p) => ({ name: this.freshName("p"), type: p.type }));
        const idx = TYPES.indexOf(p2[0].type);
        p2[0] = { name: p2[0].name, type: TYPES[(idx + 1 + this.int(7)) % 8] };
        const ov: HelperSig = { name, ret: this.pick(TYPES), params: p2 };
        defs.push(this.helperDef(ov));
        this.avail.push(ov);
      }
    }
    return defs;
  }

  // ---- contract assembly ----

  generate(seed: number): FuzzContract {
    const helperDefs = this.genHelpers();

    this.stmtBudget = 48;
    this.scopes = [[]];
    const topCount = 5 + this.int(16);
    const lines: string[] = [];

    for (let k = 0; k < 2; k++) {
      this.stmtBudget--;
      lines.push(this.declStmt("    "));
    }
    for (let k = 2; k < topCount && this.stmtBudget > 0; k++) {
      lines.push(this.statement("    ", 2));
    }

    const tops = this.scopes[0];
    tops.forEach((v, idx) => {
      const f = `f${idx % 8}`;
      if (idx < 8) {
        lines.push(`    state.mut().${f} = (uint64)(${v.name});`);
      } else {
        lines.push(`    state.mut().${f} = state.get().${f} ^ (uint64)(${v.name});`);
      }
    });

    const source = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 f0; uint64 f1; uint64 f2; uint64 f3; uint64 f4; uint64 f5; uint64 f6; uint64 f7; };
  struct Go_input { uint64 a; uint64 b; uint64 c; uint64 d; };
  struct Go_output {};
${helperDefs.join("\n")}
  PUBLIC_PROCEDURE(Go)
  {
${lines.join("\n")}
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

    const inputs: bigint[][] = [];
    for (let vec = 0; vec < 4; vec++) {
      const boundaryBias = vec === 0 ? 0.9 : 0.5;
      const row: bigint[] = [];
      for (let k = 0; k < 4; k++) {
        row.push(this.chance(boundaryBias) ? this.pick(INPUT_BOUNDARIES) : this.u64());
      }
      inputs.push(row);
    }

    return { seed, source, inputs };
  }
}

export function generate(seed: number): FuzzContract {
  return new Gen(seed).generate(seed);
}

export function encodeInput(row: bigint[]): Uint8Array {
  const buf = new Uint8Array(32);
  const dv = new DataView(buf.buffer);
  row.forEach((v, i) => {
    dv.setBigUint64(i * 8, v, true);
  });
  return buf;
}
