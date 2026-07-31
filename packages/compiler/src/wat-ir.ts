import {
  WatExpectedType,
  WatNodeKind,
  WatNodeType,
  type ExpectedWatType,
  type WatValueType,
} from "./enums";
import { LHOST_CALL_SIG } from "./lhost";

export {
  WatExpectedType,
  WatNodeKind,
  WatNodeType,
};
export type {
  ExpectedWatType,
  WatValueType,
};

// Typed WAT IR nodes: `i32/i64/void` with constructor-time type assertions.

export type WatNode =
  | { k: WatNodeKind.CONST; ty: WatValueType; lit: string }
  | { k: WatNodeKind.GET; ty: WatValueType; name: string }
  | { k: WatNodeKind.SET; ty: WatNodeType.VOID; name: string; v: WatNode }
  | { k: WatNodeKind.LOAD; ty: WatValueType; operator: string; offset: number | null; addr: WatNode }
  | { k: WatNodeKind.STORE; ty: WatNodeType.VOID; operator: string; offset: number | null; addr: WatNode; v: WatNode }
  | { k: WatNodeKind.OP; ty: WatNodeType; operator: string; callArguments: WatNode[] }
  | { k: WatNodeKind.CALL; ty: WatNodeType; target: string; callArguments: WatNode[] }
  | { k: WatNodeKind.RAW; ty: WatNodeType; text: string; why?: string };

// ---- printer ----

export function serializeWatNode(count: WatNode): string {
  switch (count.k) {
    case WatNodeKind.CONST:
      return `(${count.ty}.const ${count.lit})`;
    case WatNodeKind.GET:
      return `(local.get $${count.name})`;
    case WatNodeKind.SET:
      return `(local.set $${count.name} ${serializeWatNode(count.v)})`;
    case WatNodeKind.LOAD:
      return count.offset === null
        ? `(${count.operator} ${serializeWatNode(count.addr)})`
        : `(${count.operator} offset=${count.offset} ${serializeWatNode(count.addr)})`;
    case WatNodeKind.STORE:
      return count.offset === null
        ? `(${count.operator} ${serializeWatNode(count.addr)} ${serializeWatNode(count.v)})`
        : `(${count.operator} offset=${count.offset} ${serializeWatNode(count.addr)} ${serializeWatNode(count.v)})`;
    case WatNodeKind.OP:
      return count.callArguments.length === 0 ? `(${count.operator})` : `(${count.operator} ${count.callArguments.map(serializeWatNode).join(" ")})`;
    case WatNodeKind.CALL:
      return count.callArguments.length === 0
        ? `(call ${count.target})`
        : `(call ${count.target} ${count.callArguments.map(serializeWatNode).join(" ")})`;
    case WatNodeKind.RAW:
      return count.text;
  }
}

// ---- type assertion ----

// "val" accepts either value type (used by drop and by value-position checks).

export function assertWatType(count: WatNode, want: ExpectedWatType, context?: string): WatNode {
  const ok = want === WatExpectedType.VALUE ? count.ty !== WatNodeType.VOID : count.ty === want;
  if (!ok) {
    const where = context ? ` in ${context}` : "";
    throw new Error(`IR type error${where}: expected ${want}, got ${count.ty}: ${serializeWatNode(count)}`);
  }
  return count;
}

// ---- opcode signatures ----

interface WatOperationSignature {
  res: WatNodeType;
  ops: readonly ExpectedWatType[];
}

function binops(prefix: WatValueType): Record<string, WatOperationSignature> {
  const text: Record<string, WatOperationSignature> = {};
  for (const itemItem of [
    "add",
    "sub",
    "mul",
    "div_s",
    "div_u",
    "rem_s",
    "rem_u",
    "and",
    "or",
    "xor",
    "shl",
    "shr_s",
    "shr_u",
    "rotl",
    "rotr",
  ]) {
    text[`${prefix}.${itemItem}`] = { res: prefix, ops: [prefix, prefix] };
  }
  for (const itemItemCandidate of ["eq", "ne", "lt_s", "lt_u", "gt_s", "gt_u", "le_s", "le_u", "ge_s", "ge_u"]) {
    text[`${prefix}.${itemItemCandidate}`] = { res: WatNodeType.I32, ops: [prefix, prefix] };
  }
  for (const itemItemCandidate of ["clz", "ctz", "popcnt"]) {
    text[`${prefix}.${itemItemCandidate}`] = { res: prefix, ops: [prefix] };
  }
  text[`${prefix}.eqz`] = { res: WatNodeType.I32, ops: [prefix] };
  return text;
}

export const OP_SIG: Record<string, WatOperationSignature> = {
  ...binops(WatNodeType.I32),
  ...binops(WatNodeType.I64),
  "i32.wrap_i64": { res: WatNodeType.I32, ops: [WatNodeType.I64] },
  "i64.extend_i32_u": { res: WatNodeType.I64, ops: [WatNodeType.I32] },
  "i64.extend_i32_s": { res: WatNodeType.I64, ops: [WatNodeType.I32] },
  "i64.extend8_s": { res: WatNodeType.I64, ops: [WatNodeType.I64] },
  "i64.extend16_s": { res: WatNodeType.I64, ops: [WatNodeType.I64] },
  "i64.extend32_s": { res: WatNodeType.I64, ops: [WatNodeType.I64] },
  "i32.extend8_s": { res: WatNodeType.I32, ops: [WatNodeType.I32] },
  "i32.extend16_s": { res: WatNodeType.I32, ops: [WatNodeType.I32] },
  drop: { res: WatNodeType.VOID, ops: [WatExpectedType.VALUE] },
};

// --- framework call signatures ---- Call signature table for framework static imports only.

export interface WatCallSignature {
  params: readonly WatValueType[];
  res: WatNodeType;
}

const sig = (params: readonly WatValueType[], res: WatNodeType): WatCallSignature => ({ params, res });
const I32 = WatNodeType.I32;
const I64 = WatNodeType.I64;

export const CALL_SIG: Record<string, WatCallSignature> = {
  ...LHOST_CALL_SIG,
  // private TS gtest runner host
  $qt_invoke: sig([I32, I32, I32, I32, I32, I64, I32], I32),
  $qt_query: sig([I32, I32, I32, I32, I32, I32], I32),
  $qt_fund: sig([I32, I64], WatNodeType.VOID),
  $qt_balance: sig([I32], I64),
  $qt_state: sig([I32, I32, I32], I32),
  $qt_system: sig([I32, I32], I32),
  $qt_set_epoch: sig([I32], WatNodeType.VOID),
  $qt_set_tick: sig([I32], WatNodeType.VOID),
  $qt_construction_epoch: sig([I32], I32),
  $qt_fail: sig([I32, I32], WatNodeType.VOID),

  // memory + runtime plumbing
  $setMem: sig([I32, I32, I32], WatNodeType.VOID),
  $copyMem: sig([I32, I32, I32], WatNodeType.VOID),
  $memeq: sig([I32, I32, I32], I32),
  $m256_lt: sig([I32, I32], I32),
  $qpiAllocLocals: sig([I32], I32),
  $qpiFreeLocals: sig([], WatNodeType.VOID),
  $acquireScratchpad: sig([I64, I32], I32),
  $releaseScratchpad: sig([I32], WatNodeType.VOID),
  $self_id: sig([], I32),

  // compiler target primitives for platform widening multiply
  $intr_mulhi_u: sig([I64, I64], I64),
  $intr_mulhi_s: sig([I64, I64], I64),
  $intr_rdrand16: sig([I32], I32),
  $intr_rdrand32: sig([I32], I32),
  $intr_rdrand64: sig([I32], I32),

  // Runtime bridges that are still emitted by framework.ts.
  $qpi_contractIndex: sig([], I32),
  $qpi_transferTyped: sig([I32, I64, I32], I64),
  $qpi_prevSpectrumDigest: sig([I32], WatNodeType.VOID),
  $qpi_prevUniverseDigest: sig([I32], WatNodeType.VOID),
  $qpi_prevComputerDigest: sig([I32], WatNodeType.VOID),
  $qpi_abort: sig([I32], WatNodeType.VOID),
  $qpi_markDirty: sig([I32], WatNodeType.VOID),
  $qpi_logBytes: sig([I32, I32, I32, I32], WatNodeType.VOID),

  // non-import bridges used directly by generated code
  $liteCallFunction: sig([I32, I32, I32, I32, I32, I32], I32),
  $liteInvokeProcedure: sig([I32, I32, I32, I32, I32, I32, I64], I32),
  $lh_liteSetShareholderProposal: sig([I32, I32, I64], I32),
  $lh_liteSetShareholderVotes: sig([I32, I32, I32, I64], I32),
};

export function registerCallSig(target: string, signature: WatCallSignature): void {
  CALL_SIG[target] = signature;
}

export function resetLhostCallSigs(): void {
  for (const target of Object.keys(CALL_SIG))
    if (target.startsWith("$lh_")) delete CALL_SIG[target];
  Object.assign(CALL_SIG, LHOST_CALL_SIG);
}

// ---- smart constructors ----

export function i32Constant(lit: string | number | bigint): WatNode {
  return { k: WatNodeKind.CONST, ty: WatNodeType.I32, lit: String(lit) };
}

export function i64Constant(lit: string | number | bigint): WatNode {
  return { k: WatNodeKind.CONST, ty: WatNodeType.I64, lit: String(lit) };
}

// name is the bare local name (no $ prefix; the printer adds it).
export function localGet(name: string, ty: WatValueType): WatNode {
  return { k: WatNodeKind.GET, ty, name };
}

export function localSet(name: string, value: WatNode): WatNode {
  assertWatType(value, WatExpectedType.VALUE, `local.set $${name}`);
  return { k: WatNodeKind.SET, ty: WatNodeType.VOID, name, v: value };
}

export function operation(mnemonic: string, ...callArguments: WatNode[]): WatNode {
  const OP_SIGItem = OP_SIG[mnemonic];
  if (!OP_SIGItem) {
    throw new Error(`IR: unknown opcode ${mnemonic}`);
  }
  if (callArguments.length !== OP_SIGItem.ops.length) {
    throw new Error(`IR: ${mnemonic} expects ${OP_SIGItem.ops.length} operand(s), got ${callArguments.length}`);
  }
  callArguments.forEach((argument, argumentIndex) => assertWatType(argument, OP_SIGItem.ops[argumentIndex], `${mnemonic} operand ${argumentIndex}`));
  return { k: WatNodeKind.OP, ty: OP_SIGItem.res, operator: mnemonic, callArguments };
}

// target includes the $ prefix, exactly as it appears in the WAT.
export function functionCall(target: string, ...callArguments: WatNode[]): WatNode {
  const CALL_SIGItem = CALL_SIG[target];
  if (!CALL_SIGItem) {
    throw new Error(`IR: unknown call target ${target} (use callSig for dynamic targets)`);
  }
  return functionCallWithSignature(CALL_SIGItem, target, ...callArguments);
}

// Call generated targets through an explicit signature.
export function functionCallWithSignature(size: WatCallSignature, target: string, ...callArguments: WatNode[]): WatNode {
  if (callArguments.length !== size.params.length) {
    throw new Error(`IR: call ${target} expects ${size.params.length} arg(s), got ${callArguments.length}`);
  }
  callArguments.forEach((argument, argumentIndex) => assertWatType(argument, size.params[argumentIndex], `call ${target} arg ${argumentIndex}`));
  return { k: WatNodeKind.CALL, ty: size.res, target, callArguments };
}

export function rawWatNode(text: string, ty: WatNodeType, why?: string): WatNode {
  return why === undefined ? { k: WatNodeKind.RAW, ty, text } : { k: WatNodeKind.RAW, ty, text, why };
}

// Identify nodes safe for eager Wasm select evaluation.
export function isPureWatNode(count: WatNode): boolean {
  switch (count.k) {
    case WatNodeKind.CONST:
    case WatNodeKind.GET:
      return true;
    case WatNodeKind.LOAD:
      return isPureWatNode(count.addr);
    case WatNodeKind.OP:
      if (
        count.operator === "i64.div_s" ||
        count.operator === "i64.div_u" ||
        count.operator === "i64.rem_s" ||
        count.operator === "i64.rem_u" ||
        count.operator === "i32.div_s" ||
        count.operator === "i32.div_u" ||
        count.operator === "i32.rem_s" ||
        count.operator === "i32.rem_u"
      ) {
        return false;
      }
      return count.callArguments.every(isPureWatNode);
    default:
      return false;
  }
}

// (select a b cond): polymorphic in wasm — both arms must agree, cond is i32, result is the arm type.
export function selectValue(argument: WatNode, templateBindings: WatNode, condition: WatNode): WatNode {
  assertWatType(argument, WatExpectedType.VALUE, "select arm 0");
  assertWatType(templateBindings, argument.ty, "select arm 1");
  assertWatType(condition, WatNodeType.I32, "select condition");
  return { k: WatNodeKind.OP, ty: argument.ty, operator: "select", callArguments: [argument, templateBindings, condition] };
}

// ---- addressing + scalar access ----

// Address arithmetic: offset 0 returns the base unchanged (never wrap in a redundant i32.add).
export function addressWithOffset(base: WatNode, offset: number): WatNode {
  assertWatType(base, WatNodeType.I32, "addrOf base");
  if (offset === 0) {
    return base;
  }
  return operation("i32.add", base, i32Constant(offset));
}

// Explicit-opcode load, for shapes like (i64.load offset=8 a). offset null omits the attribute;
export function rawLoad(mnemonic: string, offset: number | null, addr: WatNode): WatNode {
  assertWatType(addr, WatNodeType.I32, `${mnemonic} address`);
  const ty: WatValueType = mnemonic.startsWith("i64.") ? WatNodeType.I64 : WatNodeType.I32;
  return { k: WatNodeKind.LOAD, ty, operator: mnemonic, offset, addr };
}

export function rawStore(mnemonic: string, offset: number | null, addr: WatNode, value: WatNode): WatNode {
  assertWatType(addr, WatNodeType.I32, `${mnemonic} address`);
  assertWatType(value, mnemonic.startsWith("i64.") ? WatNodeType.I64 : WatNodeType.I32, `${mnemonic} value`);
  return { k: WatNodeKind.STORE, ty: WatNodeType.VOID, operator: mnemonic, offset, addr, v: value };
}

// Load scalar fields into i64 with the correct narrow extension.
export function loadScalar(addr: WatNode, size: number, signed = false): WatNode {
  assertWatType(addr, WatNodeType.I32, "loadScalar address");
  switch (size) {
    case 8:
      return rawLoad("i64.load", null, addr);
    case 4:
      return operation(signed ? "i64.extend_i32_s" : "i64.extend_i32_u", rawLoad("i32.load", null, addr));
    case 2:
      return operation(
        signed ? "i64.extend_i32_s" : "i64.extend_i32_u",
        rawLoad(signed ? "i32.load16_s" : "i32.load16_u", null, addr),
      );
    case 1:
      return operation(
        signed ? "i64.extend_i32_s" : "i64.extend_i32_u",
        rawLoad(signed ? "i32.load8_s" : "i32.load8_u", null, addr),
      );
    default:
      return rawLoad("i64.load", null, addr);
  }
}

// Store i64 values directly or narrow them for smaller scalar fields.
export function storeScalar(addr: WatNode, size: number, value: WatNode): WatNode {
  assertWatType(addr, WatNodeType.I32, "storeScalar address");
  assertWatType(value, WatNodeType.I64, "storeScalar value");
  switch (size) {
    case 8:
      return rawStore("i64.store", null, addr, value);
    case 4:
      return rawStore("i32.store", null, addr, operation("i32.wrap_i64", value));
    case 2:
      return rawStore("i32.store16", null, addr, operation("i32.wrap_i64", value));
    case 1:
      return rawStore("i32.store8", null, addr, operation("i32.wrap_i64", value));
    default:
      return rawStore("i64.store", null, addr, value);
  }
}
