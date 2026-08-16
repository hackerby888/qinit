// Seeded generator for constexpr-fold parity tests (deterministic, no I/O). Each contract stores the same
// expression twice — once folded at compile time, once evaluated at runtime — so the two evaluators check
// each other without a hand-written reference implementation.

export interface FuzzConstexprContract {
    seed: number;
    source: string;
    expression: string;
}

// Literals and depth are bounded so no generated expression can leave the uint64 range, where an overflow
// would fail at WAT encode instead of exercising the fold.
const MAX_LITERAL = 255;
const MAX_DEPTH = 3;
const MAX_SHIFT = 20;

const SIZEOF_LEAVES = ["sizeof(uint64)", "sizeof(uint32)", "sizeof(FuzzBlob)"];

const ARITHMETIC_OPERATORS = ["+", "-", "*", "&", "|", "^"];
const COMPARISON_OPERATORS = ["<", ">", "<=", ">=", "==", "!="];
const LOGICAL_OPERATORS = ["&&", "||"];

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state |= 0;
        state = (state + 0x6d2b79f5) | 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

class ExpressionGenerator {
    private readonly next: () => number;

    constructor(seed: number) {
        this.next = mulberry32(seed);
    }

    private int(bound: number): number {
        return Math.floor(this.next() * bound);
    }

    private pick<T>(choices: readonly T[]): T {
        return choices[this.int(choices.length)];
    }

    private leaf(): string {
        if (this.int(4) === 0) {
            return this.pick(SIZEOF_LEAVES);
        }
        return String(1 + this.int(MAX_LITERAL));
    }

    build(depth: number): string {
        if (depth >= MAX_DEPTH) {
            return this.leaf();
        }

        switch (this.int(7)) {
            case 0:
                return `(${this.build(depth + 1)} ${this.pick(ARITHMETIC_OPERATORS)} ${this.build(depth + 1)})`;
            case 1:
                return `(${this.build(depth + 1)} ${this.pick(COMPARISON_OPERATORS)} ${this.build(depth + 1)})`;
            case 2:
                return `(${this.build(depth + 1)} ${this.pick(LOGICAL_OPERATORS)} ${this.build(depth + 1)})`;
            // A zero divisor folds to zero but traps at runtime, so the right side is always a non-zero literal.
            case 3:
                return `(${this.build(depth + 1)} / ${1 + this.int(MAX_LITERAL)})`;
            case 4:
                return `(${this.build(depth + 1)} % ${1 + this.int(MAX_LITERAL)})`;
            case 5:
                return `(${this.build(depth + 1)} ${this.pick(["<<", ">>"])} ${this.int(MAX_SHIFT)})`;
            default:
                return `(!${this.build(depth + 1)})`;
        }
    }
}

export function generate(seed: number): FuzzConstexprContract {
    const expression = new ExpressionGenerator(seed).build(0);
    const source = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct FuzzBlob { uint64 a; uint64 b; };
  static constexpr uint64 FUZZ_K = ${expression};
  struct StateData { uint64 folded; uint64 runtime; };
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) {
      state.mut().folded = FUZZ_K;
      state.mut().runtime = ${expression};
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

    return { seed, source, expression };
}
