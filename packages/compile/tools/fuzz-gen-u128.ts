// Seeded generator for uint128 differential tests (deterministic, no I/O).

export interface FuzzContract {
  seed: number;
  source: string;
  inputs: bigint[][];
}

const U64_BOUNDARIES: bigint[] = [
  0n, 1n, 2n, 3n, 7n, 42n, 255n, 256n, 65535n, 65536n, 1000000n,
  2147483647n, 2147483648n, 4294967295n, 4294967296n,
  9223372036854775807n, 9223372036854775808n, 18446744073709551614n, 18446744073709551615n,
];

const SHIFT_COUNTS = [0, 1, 7, 31, 63, 64, 65, 100, 127, 128, 129, 200];

const INPUT_BOUNDARIES: bigint[] = [
  0n, 1n, 2n, 255n, 4294967295n, 4294967296n,
  9223372036854775807n, 9223372036854775808n, 18446744073709551615n,
];

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
  private u128Vars: string[] = [];
  private scalarVars: string[] = [];
  private ivStack: string[] = [];
  private stmtBudget = 0;

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

  // ---- scalar layer (uint64-typed material for counts, conditions, limbs) ----

  private scalarLeaf(): string {
    const r = this.next();
    if (r < 0.25 && this.scalarVars.length > 0) {
      return this.pick(this.scalarVars);
    }
    if (r < 0.4) {
      return `input.${this.pick(["a", "b", "c", "d"])}`;
    }
    if (r < 0.5 && this.ivStack.length > 0) {
      return `(uint64)(${this.pick(this.ivStack)})`;
    }
    const v = this.chance(0.7) ? this.pick(U64_BOUNDARIES) : this.u64();
    return `${v}ull`;
  }

  private scalarExpr(depth: number): string {
    if (depth <= 0) {
      return this.scalarLeaf();
    }

    const d = depth - 1;
    const r = this.next();
    if (r < 0.3) {
      const op = this.pick(["+", "-", "*", "&", "|", "^"]);
      return `(${this.scalarExpr(d)} ${op} ${this.scalarExpr(d)})`;
    }
    if (r < 0.5 && this.u128Vars.length > 0) {
      return `(uint64)(${this.pick(this.u128Vars)}.${this.pick(["low", "high"])})`;
    }
    if (r < 0.65 && this.u128Vars.length > 0) {
      return this.u128Compare(d);
    }
    return this.scalarLeaf();
  }

  // Comparison of two uint128 values — yields a scalar bool. The left side is always
  private u128Compare(depth: number): string {
    const op = this.pick(["==", "<", ">", "<=", ">="]);
    return `(${this.u128Expr(depth)} ${op} ${this.u128Expr(depth)})`;
  }

  // ---- uint128 layer ----

  // The count is spelled as a uint128 cast: a bare int count is AMBIGUOUS natively (uint128_t's non-explicit operator
  private shiftCount(): string {
    if (this.chance(0.6)) {
      return `(uint128)(${this.pick(SHIFT_COUNTS)}ull)`;
    }
    return `(uint128)(((${this.scalarLeaf()}) & 127ull))`;
  }

  private u128Leaf(): string {
    const r = this.next();
    if (r < 0.4 && this.u128Vars.length > 0) {
      return this.pick(this.u128Vars);
    }
    if (r < 0.7) {
      return `(uint128)(${this.scalarExpr(1)})`;
    }
    return `uint128(${this.scalarExpr(1)}, ${this.scalarExpr(1)})`;
  }

  private u128Expr(depth: number): string {
    if (depth <= 0) {
      return this.u128Leaf();
    }

    const d = depth - 1;
    const r = this.next();
    if (r < 0.3) {
      const op = this.pick(["+", "-", "*", "&"]);
      return `(${this.u128Expr(d)} ${op} ${this.u128Expr(d)})`;
    }
    if (r < 0.5) {
      const op = this.pick(["<<", ">>"]);
      return `(${this.u128Expr(d)} ${op} ${this.shiftCount()})`;
    }
    if (r < 0.62) {
      return `div<uint128>(${this.u128Expr(d)}, ${this.u128Expr(d)})`;
    }
    if (r < 0.74) {
      return `((${this.scalarExpr(1)}) ? (${this.u128Expr(d)}) : (${this.u128Expr(d)}))`;
    }
    return this.u128Leaf();
  }

  // ---- statements ----

  private u128AssignStmt(indent: string): string {
    const v = this.pick(this.u128Vars);
    const r = this.next();
    if (r < 0.4) {
      return `${indent}${v} = ${this.u128Expr(3)};`;
    }
    if (r < 0.75) {
      const op = this.pick(["+=", "-=", "&="]);
      return `${indent}${v} ${op} ${this.u128Expr(2)};`;
    }
    const op = this.pick(["<<=", ">>="]);
    return `${indent}${v} ${op} ${this.shiftCount()};`;
  }

  private scalarAssignStmt(indent: string): string {
    const v = this.pick(this.scalarVars);
    return `${indent}${v} = ${this.scalarExpr(3)};`;
  }

  private assignStmt(indent: string): string {
    if (this.scalarVars.length > 0 && this.chance(0.35)) {
      return this.scalarAssignStmt(indent);
    }
    return this.u128AssignStmt(indent);
  }

  private ifStmt(indent: string, depth: number): string {
    const cond = this.chance(0.6) ? this.u128Compare(1) : this.scalarExpr(2);
    const inner = indent + "  ";
    const bodyLines: string[] = [];
    const n = 1 + this.int(3);
    for (let k = 0; k < n && this.stmtBudget > 0; k++) {
      bodyLines.push(this.stmt(inner, depth - 1));
    }
    const body = `${indent}{\n${bodyLines.join("\n")}\n${indent}}`;
    if (this.chance(0.4)) {
      const elseLines: string[] = [];
      const m = 1 + this.int(2);
      for (let k = 0; k < m && this.stmtBudget > 0; k++) {
        elseLines.push(this.stmt(inner, depth - 1));
      }
      return `${indent}if (${cond})\n${body}\n${indent}else\n${indent}{\n${elseLines.join("\n")}\n${indent}}`;
    }
    return `${indent}if (${cond})\n${body}`;
  }

  private forStmt(indent: string, depth: number): string {
    const iv = this.freshName("i");
    const bound = 1 + this.int(6);
    this.ivStack.push(iv);
    const inner = indent + "  ";
    const lines: string[] = [];
    const count = 1 + this.int(3);
    for (let k = 0; k < count && this.stmtBudget > 0; k++) {
      lines.push(this.stmt(inner, depth - 1));
    }
    this.ivStack.pop();
    return `${indent}for (sint32 ${iv} = 0; ${iv} < ${bound}; ${iv}++) {\n${lines.join("\n")}\n${indent}}`;
  }

  private stmt(indent: string, depth: number): string {
    this.stmtBudget--;
    const r = this.next();
    if (depth <= 0 || r < 0.6) {
      return this.assignStmt(indent);
    }
    if (r < 0.8) {
      return this.ifStmt(indent, depth);
    }
    return this.forStmt(indent, depth);
  }

  // ---- contract assembly ----

  generate(seed: number): FuzzContract {
    this.stmtBudget = 24;
    const lines: string[] = [];

    // Declarations use the two-arg constructor form only: our declaration-initializer path does not yet lower a general `(uint128)(expr)` cast
    const u128Count = 2 + this.int(3);
    for (let k = 0; k < u128Count; k++) {
      const name = this.freshName("q");
      const init = this.chance(0.5)
        ? `uint128(0ull, ${this.scalarExpr(1)})`
        : `uint128(${this.scalarExpr(1)}, ${this.scalarExpr(1)})`;
      lines.push(`    uint128 ${name} = ${init};`);
      this.u128Vars.push(name);
    }
    const scalarCount = 1 + this.int(2);
    for (let k = 0; k < scalarCount; k++) {
      const name = this.freshName("l");
      lines.push(`    uint64 ${name} = ${this.scalarExpr(2)};`);
      this.scalarVars.push(name);
    }

    const topCount = 4 + this.int(9);
    for (let k = 0; k < topCount && this.stmtBudget > 0; k++) {
      lines.push(this.stmt("    ", 2));
    }

    const flushExprs: string[] = [];
    for (const q of this.u128Vars) {
      flushExprs.push(`${q}.low`, `${q}.high`);
    }
    for (const l of this.scalarVars) {
      flushExprs.push(l);
    }
    flushExprs.forEach((e, idx) => {
      const f = `f${idx % 8}`;
      if (idx < 8) {
        lines.push(`    state.mut().${f} = (uint64)(${e});`);
      } else {
        lines.push(`    state.mut().${f} = state.get().${f} ^ (uint64)(${e});`);
      }
    });

    const source = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 f0; uint64 f1; uint64 f2; uint64 f3; uint64 f4; uint64 f5; uint64 f6; uint64 f7; };
  struct Go_input { uint64 a; uint64 b; uint64 c; uint64 d; };
  struct Go_output {};
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
