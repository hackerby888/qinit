import { LHOST_CALL_SIG } from "./lhost";

// Typed WAT IR nodes: `i32/i64/void` with constructor-time type assertions.

export type Ty = "i32" | "i64" | "void";
export type Val = "i32" | "i64";

export type Ir =
  | { k: "const"; ty: Val; lit: string }
  | { k: "get"; ty: Val; name: string }
  | { k: "set"; ty: "void"; name: string; v: Ir }
  | { k: "load"; ty: Val; op: string; offset: number | null; addr: Ir }
  | { k: "store"; ty: "void"; op: string; offset: number | null; addr: Ir; v: Ir }
  | { k: "op"; ty: Ty; op: string; args: Ir[] }
  | { k: "call"; ty: Ty; target: string; args: Ir[] }
  | { k: "raw"; ty: Ty; text: string; why?: string };

// ---- printer ----

export function emit(n: Ir): string {
  switch (n.k) {
    case "const":
      return `(${n.ty}.const ${n.lit})`;
    case "get":
      return `(local.get $${n.name})`;
    case "set":
      return `(local.set $${n.name} ${emit(n.v)})`;
    case "load":
      return n.offset === null
        ? `(${n.op} ${emit(n.addr)})`
        : `(${n.op} offset=${n.offset} ${emit(n.addr)})`;
    case "store":
      return n.offset === null
        ? `(${n.op} ${emit(n.addr)} ${emit(n.v)})`
        : `(${n.op} offset=${n.offset} ${emit(n.addr)} ${emit(n.v)})`;
    case "op":
      return n.args.length === 0 ? `(${n.op})` : `(${n.op} ${n.args.map(emit).join(" ")})`;
    case "call":
      return n.args.length === 0 ? `(call ${n.target})` : `(call ${n.target} ${n.args.map(emit).join(" ")})`;
    case "raw":
      return n.text;
  }
}

// ---- type assertion ----

// "val" accepts either value type (used by drop and by value-position checks).
export type Want = Ty | "val";

export function assertTy(n: Ir, want: Want, context?: string): Ir {
  const ok = want === "val" ? n.ty !== "void" : n.ty === want;
  if (!ok) {
    const where = context ? ` in ${context}` : "";
    throw new Error(`IR type error${where}: expected ${want}, got ${n.ty}: ${emit(n)}`);
  }
  return n;
}

// ---- opcode signatures ----

interface OpSig {
  res: Ty;
  ops: readonly Want[];
}

function binops(prefix: Val): Record<string, OpSig> {
  const t: Record<string, OpSig> = {};
  for (const m of ["add", "sub", "mul", "div_s", "div_u", "rem_s", "rem_u", "and", "or", "xor", "shl", "shr_s", "shr_u", "rotl", "rotr"]) {
    t[`${prefix}.${m}`] = { res: prefix, ops: [prefix, prefix] };
  }
  for (const m of ["eq", "ne", "lt_s", "lt_u", "gt_s", "gt_u", "le_s", "le_u", "ge_s", "ge_u"]) {
    t[`${prefix}.${m}`] = { res: "i32", ops: [prefix, prefix] };
  }
  for (const m of ["clz", "ctz", "popcnt"]) {
    t[`${prefix}.${m}`] = { res: prefix, ops: [prefix] };
  }
  t[`${prefix}.eqz`] = { res: "i32", ops: [prefix] };
  return t;
}

export const OP_SIG: Record<string, OpSig> = {
  ...binops("i32"),
  ...binops("i64"),
  "i32.wrap_i64": { res: "i32", ops: ["i64"] },
  "i64.extend_i32_u": { res: "i64", ops: ["i32"] },
  "i64.extend_i32_s": { res: "i64", ops: ["i32"] },
  "i64.extend8_s": { res: "i64", ops: ["i64"] },
  "i64.extend16_s": { res: "i64", ops: ["i64"] },
  "i64.extend32_s": { res: "i64", ops: ["i64"] },
  "i32.extend8_s": { res: "i32", ops: ["i32"] },
  "i32.extend16_s": { res: "i32", ops: ["i32"] },
  drop: { res: "void", ops: ["val"] },
};

// --- framework call signatures ---- Call signature table for framework static imports only.

export interface CallSig {
  params: readonly Val[];
  res: Ty;
}

const sig = (params: readonly Val[], res: Ty): CallSig => ({ params, res });
const I32 = "i32" as const;
const I64 = "i64" as const;

export const CALL_SIG: Record<string, CallSig> = {
  ...LHOST_CALL_SIG,
  // private TS gtest runner host
  $qt_invoke: sig([I32, I32, I32, I32, I32, I64, I32], I32),
  $qt_query: sig([I32, I32, I32, I32, I32, I32], I32),
  $qt_fund: sig([I32, I64], "void"),
  $qt_balance: sig([I32], I64),
  $qt_state: sig([I32, I32, I32], I32),
  $qt_system: sig([I32, I32], I32),
  $qt_set_epoch: sig([I32], "void"),
  $qt_set_tick: sig([I32], "void"),
  $qt_construction_epoch: sig([I32], I32),
  $qt_fail: sig([I32, I32], "void"),

  // memory + runtime plumbing
  $setMem: sig([I32, I32, I32], "void"),
  $copyMem: sig([I32, I32, I32], "void"),
  $memeq: sig([I32, I32, I32], I32),
  $m256_lt: sig([I32, I32], I32),
  $qpiAllocLocals: sig([I32], I32),
  $qpiFreeLocals: sig([], "void"),
  $acquireScratchpad: sig([I64, I32], I32),
  $releaseScratchpad: sig([I32], "void"),
  $self_id: sig([], I32),

  // compiler target primitives for platform widening multiply
  $intr_mulhi_u: sig([I64, I64], I64),
  $intr_mulhi_s: sig([I64, I64], I64),
  $intr_rdrand16: sig([I32], I32),
  $intr_rdrand32: sig([I32], I32),
  $intr_rdrand64: sig([I32], I32),

  // qpi forwarders — zero-arg getters
  $qpi_epoch: sig([], I32),
  $qpi_tick: sig([], I32),
  $qpi_numberOfTickTransactions: sig([], I32),
  $qpi_day: sig([], I32),
  $qpi_year: sig([], I32),
  $qpi_hour: sig([], I32),
  $qpi_minute: sig([], I32),
  $qpi_month: sig([], I32),
  $qpi_second: sig([], I32),
  $qpi_millisecond: sig([], I32),
  $qpi_contractIndex: sig([], I32),

  // qpi forwarders — calls
  $qpi_transfer: sig([I32, I64], I64),
  $qpi_transferTyped: sig([I32, I64, I32], I64),
  $qpi_burn: sig([I64, I32], I64),
  $qpi_now: sig([I32], "void"),
  $qpi_k12: sig([I32, I32, I32], "void"),
  $qpi_getEntity: sig([I32, I32], I32),
  $qpi_queryFeeReserve: sig([I32], I64),
  $qpi_nextId: sig([I32, I32], "void"),
  $qpi_prevId: sig([I32, I32], "void"),
  $qpi_isContractId: sig([I32], I32),
  $qpi_arbitrator: sig([I32], "void"),
  $qpi_computor: sig([I32, I32], "void"),
  $qpi_prevSpectrumDigest: sig([I32], "void"),
  $qpi_prevUniverseDigest: sig([I32], "void"),
  $qpi_prevComputerDigest: sig([I32], "void"),
  $qpi_isAssetIssued: sig([I32, I64], I32),
  $qpi_issueAsset: sig([I64, I32, I32, I64, I64], I64),
  $qpi_numberOfShares: sig([I32, I32, I32], I64),
  $qpi_numberOfPossessedShares: sig([I64, I32, I32, I32, I32, I32], I64),
  $qpi_transferShares: sig([I64, I32, I32, I32, I64, I32], I64),
  $qpi_acquireShares: sig([I64, I32, I32, I32, I64, I32, I32, I64], I64),
  $qpi_releaseShares: sig([I64, I32, I32, I32, I64, I32, I32, I64], I64),
  $qpi_dayOfWeek: sig([I32, I32, I32], I32),
  $qpi_signatureValidity: sig([I32, I32, I32], I32),
  $qpi_bidInIPO: sig([I32, I64, I32], I64),
  $qpi_ipoBidId: sig([I32, I32, I32], "void"),
  $qpi_ipoBidPrice: sig([I32, I32], I64),
  $qpi_computeMiningFunction: sig([I32, I32, I32, I32], "void"),
  $qpi_initMiningSeed: sig([I32], "void"),
  $qpi_getOracleQueryStatus: sig([I64], I32),
  $qpi_unsubscribeOracle: sig([I32], I32),
  $qpi_distributeDividends: sig([I64], I32),
  $qpi_abort: sig([I32], "void"),
  $qpi_markDirty: sig([I32], "void"),
  $qpi_logBytes: sig([I32, I32, I32, I32], "void"),

  // non-import bridges used directly by generated code
  $liteCallFunction: sig([I32, I32, I32, I32, I32, I32], I32),
  $liteInvokeProcedure: sig([I32, I32, I32, I32, I32, I32, I64], I32),
  $lh_liteSetShareholderProposal: sig([I32, I32, I64], I32),
  $lh_liteSetShareholderVotes: sig([I32, I32, I32, I64], I32),
};

// ---- smart constructors ----

export function i32c(lit: string | number | bigint): Ir {
  return { k: "const", ty: "i32", lit: String(lit) };
}

export function i64c(lit: string | number | bigint): Ir {
  return { k: "const", ty: "i64", lit: String(lit) };
}

// name is the bare local name (no $ prefix; the printer adds it).
export function getL(name: string, ty: Val): Ir {
  return { k: "get", ty, name };
}

export function setL(name: string, v: Ir): Ir {
  assertTy(v, "val", `local.set $${name}`);
  return { k: "set", ty: "void", name, v };
}

export function op(mnemonic: string, ...args: Ir[]): Ir {
  const s = OP_SIG[mnemonic];
  if (!s) {
    throw new Error(`IR: unknown opcode ${mnemonic}`);
  }
  if (args.length !== s.ops.length) {
    throw new Error(`IR: ${mnemonic} expects ${s.ops.length} operand(s), got ${args.length}`);
  }
  args.forEach((a, i) => assertTy(a, s.ops[i], `${mnemonic} operand ${i}`));
  return { k: "op", ty: s.res, op: mnemonic, args };
}

// target includes the $ prefix, exactly as it appears in the WAT.
export function call(target: string, ...args: Ir[]): Ir {
  const s = CALL_SIG[target];
  if (!s) {
    throw new Error(`IR: unknown call target ${target} (use callSig for dynamic targets)`);
  }
  return callSig(s, target, ...args);
}

// Call through an explicit signature — for per-contract generated targets (helpers, methods, dispatch stubs) that cannot live in
export function callSig(s: CallSig, target: string, ...args: Ir[]): Ir {
  if (args.length !== s.params.length) {
    throw new Error(`IR: call ${target} expects ${s.params.length} arg(s), got ${args.length}`);
  }
  args.forEach((a, i) => assertTy(a, s.params[i], `call ${target} arg ${i}`));
  return { k: "call", ty: s.res, target, args };
}

export function raw(text: string, ty: Ty, why?: string): Ir {
  return why === undefined ? { k: "raw", ty, text } : { k: "raw", ty, text, why };
}

// True when evaluating the node can neither trap nor produce a side effect — safe for wasm select's
export function pureIr(n: Ir): boolean {
  switch (n.k) {
    case "const":
    case "get":
      return true;
    case "load":
      return pureIr(n.addr);
    case "op":
      if (n.op === "i64.div_s" || n.op === "i64.div_u" || n.op === "i64.rem_s" || n.op === "i64.rem_u"
        || n.op === "i32.div_s" || n.op === "i32.div_u" || n.op === "i32.rem_s" || n.op === "i32.rem_u") {
        return false;
      }
      return n.args.every(pureIr);
    default:
      return false;
  }
}

// (select a b cond): polymorphic in wasm — both arms must agree, cond is i32, result is the arm type.
export function selectV(a: Ir, b: Ir, cond: Ir): Ir {
  assertTy(a, "val", "select arm 0");
  assertTy(b, a.ty, "select arm 1");
  assertTy(cond, "i32", "select condition");
  return { k: "op", ty: a.ty, op: "select", args: [a, b, cond] };
}

// ---- addressing + scalar access ----

// Address arithmetic: offset 0 returns the base unchanged (never wrap in a redundant i32.add).
export function addr0(base: Ir, offset: number): Ir {
  assertTy(base, "i32", "addrOf base");
  if (offset === 0) {
    return base;
  }
  return op("i32.add", base, i32c(offset));
}

// Explicit-opcode load, for shapes like (i64.load offset=8 a). offset null omits the attribute;
export function loadRaw(mnemonic: string, offset: number | null, addr: Ir): Ir {
  assertTy(addr, "i32", `${mnemonic} address`);
  const ty: Val = mnemonic.startsWith("i64.") ? "i64" : "i32";
  return { k: "load", ty, op: mnemonic, offset, addr };
}

export function storeRaw(mnemonic: string, offset: number | null, addr: Ir, v: Ir): Ir {
  assertTy(addr, "i32", `${mnemonic} address`);
  assertTy(v, mnemonic.startsWith("i64.") ? "i64" : "i32", `${mnemonic} value`);
  return { k: "store", ty: "void", op: mnemonic, offset, addr, v };
}

// Load a scalar field into the i64 value model: 8-byte fields load directly, narrower fields load at their
export function loadScalar(addr: Ir, size: number, signed = false): Ir {
  assertTy(addr, "i32", "loadScalar address");
  switch (size) {
    case 8:
      return loadRaw("i64.load", null, addr);
    case 4:
      return op(signed ? "i64.extend_i32_s" : "i64.extend_i32_u", loadRaw("i32.load", null, addr));
    case 2:
      return op(signed ? "i64.extend_i32_s" : "i64.extend_i32_u", loadRaw(signed ? "i32.load16_s" : "i32.load16_u", null, addr));
    case 1:
      return op(signed ? "i64.extend_i32_s" : "i64.extend_i32_u", loadRaw(signed ? "i32.load8_s" : "i32.load8_u", null, addr));
    default:
      return loadRaw("i64.load", null, addr);
  }
}

// Store an i64 register value to a scalar field: 8-byte fields store directly, narrower fields wrap to i32
export function storeScalar(addr: Ir, size: number, v: Ir): Ir {
  assertTy(addr, "i32", "storeScalar address");
  assertTy(v, "i64", "storeScalar value");
  switch (size) {
    case 8:
      return storeRaw("i64.store", null, addr, v);
    case 4:
      return storeRaw("i32.store", null, addr, op("i32.wrap_i64", v));
    case 2:
      return storeRaw("i32.store16", null, addr, op("i32.wrap_i64", v));
    case 1:
      return storeRaw("i32.store8", null, addr, op("i32.wrap_i64", v));
    default:
      return storeRaw("i64.store", null, addr, v);
  }
}
