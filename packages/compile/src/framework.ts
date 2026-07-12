import { ASSET_ENUMERATION_RECORD, LHOST_ABI } from "@qinit/core";
import { emitLhostImports, lhostSymbol } from "./lhost";
import type { PlatformCapability } from "./codegen/platform-primitives";
import { QPI_BINDINGS } from "./codegen/calls/qpi";

// WAT assembler for a complete contract module.
export const IN_SZ = 64 * 1024;
export const OUT_SZ = 64 * 1024;
export const LOCALS_SZ = 32 * 1024;
const CTX_SZ = 256;

// QpiContext offsets used by all WAT forwarders.
export const CTX = { contractIndex: 0, originator: 40, invocator: 72, invocationReward: 104 } as const;

export interface UserEntry {
  inputType: number;       // user-assigned [1..65535]
  kind: number;            // 0 = function, 1 = procedure
  inSize: number;
  outSize: number;
  localsSize: number;
  label: string;           // WAT function name, e.g. "$user_0"
}

export interface SysProcInfo {
  id: number;              // LITE_SP_* id (0..11)
  localsSize: number;
  inSize: number;
  outSize: number;
  label: string;           // WAT function name, e.g. "$sys_0"
}

export interface ModuleSpec {
  stateSize: number;
  arenaSize: number;
  entries: UserEntry[];
  sysprocs: SysProcInfo[];
  userFunctionsWat: string;   // the $user_N / $sys_N function definitions
  migrate?: { label: string; oldStateSize: number; localsSize: number };  // MIGRATE() metadata + dispatch target
  memBase?: number;           // shared-memory gtest mode: import env.memory and place the whole layout at
                              // this byte offset inside the provider's (corpus runner's) memory. Every
  gtest?: boolean;            // TS-compiled test runner: include the private qtest host ABI
  capabilities?: readonly PlatformCapability[];
}

// Back-compat shape used by older callers / tests.
export interface FrameworkOpts {
  stateSize: number;
  arenaSize: number;
  userEntryCount: number;
  sysprocMask: number;
}

interface Layout {
  stateBase: number;
  stateSize: number;
  ctxBase: number;
  ioBase: number;
  inBase: number;
  outBase: number;
  localsBase: number;
  arenaBase: number;
  arenaEnd: number;
  ioSize: number;
  pages: number;
  iterBufBase: number;
}

function computeLayout(stateSize: number, arenaSize: number, memBase = 0): Layout {
  const align = (n: number, a: number) => Math.ceil(n / a) * a;
  const stateBase = memBase;
  const ctxBase = align(stateBase + Math.max(stateSize, 8), 16);
  const ioBase = align(ctxBase + CTX_SZ, 16);
  const inBase = ioBase;
  const outBase = inBase + IN_SZ;
  const localsBase = outBase + OUT_SZ;
  const arenaBase = localsBase + LOCALS_SZ;
  const arenaEnd = arenaBase + arenaSize;
  const ioSize = IN_SZ + OUT_SZ + LOCALS_SZ + arenaSize;
  // Asset-iterator result buffer (AssetOwnership/PossessionIterator): 1024 records × 80 bytes, written by the assetEnumerate host import at begin() and
  const iterBufBase = align(arenaEnd, 16);
  const iterBufSize = ASSET_ENUMERATION_RECORD.size * ASSET_ENUMERATION_RECORD.capacity;
  const pages = Math.ceil((iterBufBase + iterBufSize) / 65536) + 1;
  return { stateBase, stateSize, ctxBase, ioBase, inBase, outBase, localsBase, arenaBase, arenaEnd, ioSize, pages, iterBufBase };
}

// ---- The complete module assembler ----

export function emitModule(spec: ModuleSpec): string {
  const usesPrng = spec.capabilities?.includes("chain-prng") ?? false;
  // WAMR's app-to-native adapter treats linear-memory offset 0 as nullptr.
  // Random-capable modules pass their resident state to lhost.k12 when seeding,
  // so keep that state at a non-zero offset. Shared-memory gtests retain their
  // explicit base, and modules without PRNG code retain the historical zero base.
  const L = computeLayout(spec.stateSize, spec.arenaSize, spec.memBase ?? (usesPrng ? 8 : 0));
  const sysprocMask = spec.sysprocs.reduce((m, sp) => m | (1 << sp.id), 0);

  return [
    "(module",
    "  ;; ---- qinit-compile generated module ----",
    emitImports(spec.gtest),
    spec.memBase !== undefined
      ? `  (import "env" "memory" (memory ${L.pages}))`
      : `  (memory (export "memory") ${L.pages} ${L.pages})`,
    emitGlobals(L),
    emitExportList(),
    emitMemOps(),
    emitAllocators(L),
    emitForwarders(),
    emitIntrinsics(L, spec),
    emitMetadata(L, spec, sysprocMask),
    spec.userFunctionsWat,
    emitDispatch(spec, usesPrng),
    emitInitialize(),
    ")",
  ].join("\n");
}

// Back-compat wrapper (string-only, no user functions) used by the spike test.
export function emitFramework(opts: FrameworkOpts): string {
  return emitModule({
    stateSize: opts.stateSize,
    arenaSize: opts.arenaSize,
    entries: [],
    sysprocs: [],
    userFunctionsWat: "  ;; ---- USER CODE (spliced by codegen.ts) ----",
  });
}

function emitImports(gtest = false): string {
  return `  ;; ---- lhost imports ----
${emitLhostImports()}
${gtest ? `  ;; ---- private TS gtest host imports ----
  (import "qtest" "invoke" (func $qt_invoke (param i32 i32 i32 i32 i32 i64 i32) (result i32)))
  (import "qtest" "query" (func $qt_query (param i32 i32 i32 i32 i32 i32) (result i32)))
  (import "qtest" "fund" (func $qt_fund (param i32 i64)))
  (import "qtest" "balance" (func $qt_balance (param i32) (result i64)))
  (import "qtest" "state" (func $qt_state (param i32 i32 i32) (result i32)))
  (import "qtest" "system" (func $qt_system (param i32 i32) (result i32)))
  (import "qtest" "setEpoch" (func $qt_set_epoch (param i32)))
  (import "qtest" "setTick" (func $qt_set_tick (param i32)))
  (import "qtest" "constructionEpoch" (func $qt_construction_epoch (param i32) (result i32)))
  (import "qtest" "fail" (func $qt_fail (param i32 i32)))` : ""}`;
}

function emitGlobals(L: Layout): string {
  return `  ;; ---- globals ----
  (global $stateBase i32 (i32.const ${L.stateBase}))
  (global $ctxBase i32 (i32.const ${L.ctxBase}))
  (global $ioBase i32 (i32.const ${L.ioBase}))
  (global $arenaBase i32 (i32.const ${L.arenaBase}))
  (global $arenaTop (export "arena_top") (mut i32) (i32.const ${L.arenaBase}))
  (global $assetIterBase i32 (i32.const ${L.iterBufBase}))
  (global $prngSeed0 (mut i64) (i64.const 0))
  (global $prngSeed1 (mut i64) (i64.const 0))
  (global $prngSeed2 (mut i64) (i64.const 0))
  (global $prngSeed3 (mut i64) (i64.const 0))
  (global $prngCounter (mut i64) (i64.const 0))
  (global $dispatchDepth (mut i32) (i32.const 0))`;
}

function emitExportList(): string {
  return `  ;; ---- exports ----
  (export "state_addr" (func $state_addr))
  (export "state_size" (func $state_size))
  (export "io_base" (func $io_base))
  (export "io_size" (func $io_size))
  (export "ctx_addr" (func $ctx_addr))
  (export "reg_count" (func $reg_count))
  (export "reg_info" (func $reg_info))
  (export "reg_sysproc_mask" (func $reg_sysproc_mask))
  (export "sysproc_locals_size" (func $sysproc_locals_size))
  (export "sysproc_in_size" (func $sysproc_in_size))
  (export "sysproc_out_size" (func $sysproc_out_size))
  (export "has_migrate" (func $has_migrate))
  (export "migrate_old_state_size" (func $migrate_old_state_size))
  (export "migrate_locals_size" (func $migrate_locals_size))
  (export "dispatch" (func $dispatch))
  (export "_initialize" (func $_initialize))`;
}

function emitMemOps(): string {
  return `  ;; ---- mem ops ----
  (func $setMem (param $dst i32) (param $size i32) (param $val i32)
    (local $i i32)
    (block $done
      (br_if $done (i32.eqz (local.get $size)))
      (loop $fill
        (i32.store8 (i32.add (local.get $dst) (local.get $i)) (local.get $val))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br_if $fill (i32.lt_u (local.get $i) (local.get $size))))))

  (func $copyMem (param $dst i32) (param $src i32) (param $size i32)
    (local $i i32)
    (block $done
      (br_if $done (i32.eqz (local.get $size)))
      (loop $cp
        (i32.store8 (i32.add (local.get $dst) (local.get $i))
          (i32.load8_u (i32.add (local.get $src) (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br_if $cp (i32.lt_u (local.get $i) (local.get $size))))))

  (func $memeq (param $a i32) (param $b i32) (param $size i32) (result i32)
    (local $i i32)
    (block $done
      (loop $cmp
        (br_if $done (i32.ge_u (local.get $i) (local.get $size)))
        (if (i32.ne
            (i32.load8_u (i32.add (local.get $a) (local.get $i)))
            (i32.load8_u (i32.add (local.get $b) (local.get $i))))
          (then (return (i32.const 0))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $cmp)))
    (i32.const 1))
  ;; id/m256i operator< : lexicographic over the 4 u64 limbs (index 0 first, unsigned). Returns 1 if a<b.
  (func $m256_lt (param $a i32) (param $b i32) (result i32)
    (local $i i32)
    (local $av i64) (local $bv i64)
    (block $done
      (loop $cmp
        (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
        (local.set $av (i64.load (i32.add (local.get $a) (i32.mul (local.get $i) (i32.const 8)))))
        (local.set $bv (i64.load (i32.add (local.get $b) (i32.mul (local.get $i) (i32.const 8)))))
        (if (i64.lt_u (local.get $av) (local.get $bv)) (then (return (i32.const 1))))
        (if (i64.gt_u (local.get $av) (local.get $bv)) (then (return (i32.const 0))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $cmp)))
    (i32.const 0))`;
}

function emitAllocators(L: Layout): string {
  // Arena bump allocator. Locals + scratchpad both bump the arena; dispatch resets it per call.
  return `  ;; ---- allocators (arena bump; reset each dispatch) ----
  ;; Zeroed like native contract_exec.h's __qpiAllocLocals (setMem after allocate): a nested CALL()'s locals
  ;; frame (e.g. a HashSet used as a dedup scratch) must start empty. Scalar temps share this allocator and
  ;; are always fully written before read, so the extra zeroing is only a small constant cost for them.
  (func $qpiAllocLocals (param $size i32) (result i32)
    (local $off i32)
    (local.set $off (global.get $arenaTop))
    (global.set $arenaTop (i32.and (i32.add (i32.add (local.get $off) (local.get $size)) (i32.const 7)) (i32.const -8)))
    (call $setMem (local.get $off) (local.get $size) (i32.const 0))
    (local.get $off))

  (func $qpiFreeLocals nop)

  (func $acquireScratchpad (param $size i64) (param $initZero i32) (result i32)
    (local $off i32) (local $sz i32)
    (local.set $off (global.get $arenaTop))
    (local.set $sz (i32.wrap_i64 (local.get $size)))
    (global.set $arenaTop (i32.and (i32.add (i32.add (local.get $off) (local.get $sz)) (i32.const 7)) (i32.const -8)))
    (if (local.get $initZero) (then (call $setMem (local.get $off) (local.get $sz) (i32.const 0))))
    (local.get $off))

  ;; Scoped release (RAII in qpi.h, so releases nest strictly LIFO): pop the bump back to the released
  ;; block. Enclosing locals frames were allocated below the scratch, so the pop never frees live memory;
  ;; without it, sequential container cleanups within one dispatch sum their scratch instead of reusing it.
  (func $releaseScratchpad (param $ptr i32)
    (if (i32.and (i32.ge_u (local.get $ptr) (global.get $arenaBase)) (i32.le_u (local.get $ptr) (global.get $arenaTop)))
      (then (global.set $arenaTop (local.get $ptr)))))`;
}

function emitForwarders(): string {
  // Thin wrappers from $qpi_* (codegen targets) to the lhost imports.
  return `  ;; ---- qpi forwarders ----
${emitQpiBindingForwarders()}
  (func $qpi_transferTyped (param $d i32) (param $a i64) (param $t i32) (result i64) (call $lh_transferTyped (local.get $d) (local.get $a) (local.get $t)))
  (func $qpi_prevSpectrumDigest (param $o i32) (call $lh_prevSpectrumDigest (local.get $o)))
  (func $qpi_prevUniverseDigest (param $o i32) (call $lh_prevUniverseDigest (local.get $o)))
  (func $qpi_prevComputerDigest (param $o i32) (call $lh_prevComputerDigest (local.get $o)))
  (func $qpi_abort (param $c i32) (call $lh_abort (local.get $c)))
  (func $qpi_markDirty (param $c i32) (call $lh_markDirty (local.get $c)))
  (func $qpi_logBytes (param $ci i32) (param $lv i32) (param $m i32) (param $sz i32) (call $lh_logBytes (local.get $ci) (local.get $lv) (local.get $m) (local.get $sz)))
  (func $liteCallFunction (param $c i32) (param $it i32) (param $i i32) (param $is i32) (param $o i32) (param $os i32) (result i32) (call $lh_liteCallFunction (local.get $c) (local.get $it) (local.get $i) (local.get $is) (local.get $o) (local.get $os)))
  (func $liteInvokeProcedure (param $c i32) (param $it i32) (param $i i32) (param $is i32) (param $o i32) (param $os i32) (param $r i64) (result i32) (call $lh_liteInvokeProcedure (local.get $c) (local.get $it) (local.get $i) (local.get $is) (local.get $o) (local.get $os) (local.get $r)))
  ;; context header accessors (offsets from CTX — pinned to the engine's abi.ts by tests/qpi/abi-drift.test.ts)
  (func $qpi_contractIndex (result i32) (i32.load (i32.add (global.get $ctxBase) (i32.const ${CTX.contractIndex}))))
  (func $qpi_invocator (param $o i32) (call $copyMem (local.get $o) (i32.add (global.get $ctxBase) (i32.const ${CTX.invocator})) (i32.const 32)))
  (func $qpi_originator (param $o i32) (call $copyMem (local.get $o) (i32.add (global.get $ctxBase) (i32.const ${CTX.originator})) (i32.const 32)))
  (func $qpi_invocationReward (result i64) (i64.load (i32.add (global.get $ctxBase) (i32.const ${CTX.invocationReward}))))`;
}

function emitQpiBindingForwarders(): string {
  return Object.values(QPI_BINDINGS).flatMap((binding) => {
    if (!binding.host || !binding.fwd.startsWith("$qpi_")) return [];
    const signature = LHOST_ABI[binding.host];
    const params = signature.params.map((type, index) => `(param $p${index} ${type})`).join(" ");
    const result = signature.results[0] ? ` (result ${signature.results[0]})` : "";
    const operands = signature.params.map((_, index) => `(local.get $p${index})`).join(" ");
    return [`  (func ${binding.fwd}${params ? " " + params : ""}${result} (call ${lhostSymbol(binding.host)}${operands ? " " + operands : ""}))`];
  }).join("\n");
}

function emitIntrinsics(L: Layout, spec: ModuleSpec): string {
  const inputSizeCases: string[] = [];
  for (const entry of spec.entries) {
    inputSizeCases.push(`    (if (i32.and (i32.eq (local.get $kind) (i32.const ${entry.kind})) (i32.eq (i32.and (local.get $it) (i32.const 0xffff)) (i32.const ${entry.inputType}))) (then (return (i32.const ${entry.inSize}))))`);
  }
  for (const sysproc of spec.sysprocs) {
    inputSizeCases.push(`    (if (i32.and (i32.eq (local.get $kind) (i32.const 2)) (i32.eq (local.get $it) (i32.const ${sysproc.id}))) (then (return (i32.const ${sysproc.inSize}))))`);
  }
  if (spec.migrate) {
    inputSizeCases.push(`    (if (i32.eq (local.get $kind) (i32.const 3)) (then (return (i32.const ${spec.migrate.oldStateSize}))))`);
  }
  // Container + helper intrinsics the codegen targets. HashMap helpers reproduce the real qpi.h
  return `  ;; ---- intrinsics ----
  ;; Canonical dispatch transcript:
  ;; prev spectrum[32], tick:u32, contract:u32, kind:u32, inputType:u32,
  ;; invocator[32], originator[32], reward:u64, inputLen:u32, stateLen:u32,
  ;; K12(resident state)[32], input bytes. All integers are little-endian.
  (func $dispatch_input_size (param $kind i32) (param $it i32) (result i32)
${inputSizeCases.join("\n")}
    (i32.const 0))

  (func $prng_seed_dispatch (param $kind i32) (param $it i32) (param $inOff i32)
    (local $inputSize i32) (local $transcript i32) (local $digest i32)
    (local.set $inputSize (call $dispatch_input_size (local.get $kind) (local.get $it)))
    (local.set $transcript (call $qpiAllocLocals (i32.add (i32.const 192) (local.get $inputSize))))
    (call $lh_prevSpectrumDigest (local.get $transcript))
    (i32.store (i32.add (local.get $transcript) (i32.const 32)) (call $lh_tick))
    (i32.store (i32.add (local.get $transcript) (i32.const 36)) (call $qpi_contractIndex))
    (i32.store (i32.add (local.get $transcript) (i32.const 40)) (local.get $kind))
    (i32.store (i32.add (local.get $transcript) (i32.const 44)) (local.get $it))
    (call $copyMem (i32.add (local.get $transcript) (i32.const 48)) (i32.add (global.get $ctxBase) (i32.const ${CTX.invocator})) (i32.const 32))
    (call $copyMem (i32.add (local.get $transcript) (i32.const 80)) (i32.add (global.get $ctxBase) (i32.const ${CTX.originator})) (i32.const 32))
    (i64.store (i32.add (local.get $transcript) (i32.const 112)) (call $qpi_invocationReward))
    (i32.store (i32.add (local.get $transcript) (i32.const 120)) (local.get $inputSize))
    (i32.store (i32.add (local.get $transcript) (i32.const 124)) (i32.const ${L.stateSize}))
    (call $lh_k12 (global.get $stateBase) (i32.const ${L.stateSize}) (i32.add (local.get $transcript) (i32.const 128)))
    (call $copyMem (i32.add (local.get $transcript) (i32.const 160)) (local.get $inOff) (local.get $inputSize))
    (local.set $digest (i32.add (i32.add (local.get $transcript) (i32.const 160)) (local.get $inputSize)))
    (call $lh_k12 (local.get $transcript) (i32.add (i32.const 160) (local.get $inputSize)) (local.get $digest))
    (global.set $prngSeed0 (i64.load (local.get $digest)))
    (global.set $prngSeed1 (i64.load (i32.add (local.get $digest) (i32.const 8))))
    (global.set $prngSeed2 (i64.load (i32.add (local.get $digest) (i32.const 16))))
    (global.set $prngSeed3 (i64.load (i32.add (local.get $digest) (i32.const 24))))
    (global.set $prngCounter (i64.const 0)))

  ;; Portable replacement for the x86 RDRAND step contract: write one value and
  ;; report success. K12(seed || counter) gives a deterministic dispatch-local
  ;; testnet stream; it is replayable chain-derived data, not independent CPU entropy.
  (func $prng_next (param $out i32) (param $width i32) (result i32)
    (local $block i32) (local $digest i32)
    (local.set $block (call $qpiAllocLocals (i32.const 72)))
    (i64.store (local.get $block) (global.get $prngSeed0))
    (i64.store (i32.add (local.get $block) (i32.const 8)) (global.get $prngSeed1))
    (i64.store (i32.add (local.get $block) (i32.const 16)) (global.get $prngSeed2))
    (i64.store (i32.add (local.get $block) (i32.const 24)) (global.get $prngSeed3))
    (i64.store (i32.add (local.get $block) (i32.const 32)) (global.get $prngCounter))
    (local.set $digest (i32.add (local.get $block) (i32.const 40)))
    (call $lh_k12 (local.get $block) (i32.const 40) (local.get $digest))
    (call $copyMem (local.get $out) (local.get $digest) (local.get $width))
    (global.set $prngCounter (i64.add (global.get $prngCounter) (i64.const 1)))
    (i32.const 1))
  (func $intr_rdrand16 (param $out i32) (result i32) (call $prng_next (local.get $out) (i32.const 2)))
  (func $intr_rdrand32 (param $out i32) (result i32) (call $prng_next (local.get $out) (i32.const 4)))
  (func $intr_rdrand64 (param $out i32) (result i32) (call $prng_next (local.get $out) (i32.const 8)))

  ;; SELF as a materialized id: { contractIndex:u64, 0, 0, 0 } in scratch, returns its address.
  (func $self_id (result i32) (local $p i32)
    (local.set $p (call $qpiAllocLocals (i32.const 32)))
    (call $setMem (local.get $p) (i32.const 32) (i32.const 0))
    (i64.store (local.get $p) (i64.extend_i32_u (call $qpi_contractIndex)))
    (local.get $p))

  ;; ---- uint128 (two-limb little-endian: low@0, high@8) ----
  ;; High 64 bits of the unsigned 64x64 product, via 32-bit splitting (wasm has no widening multiply).
  (func $intr_mulhi_u (param $x i64) (param $y i64) (result i64)
    (local $x0 i64) (local $x1 i64) (local $y0 i64) (local $y1 i64) (local $cross i64)
    (local.set $x0 (i64.and (local.get $x) (i64.const 0xffffffff)))
    (local.set $x1 (i64.shr_u (local.get $x) (i64.const 32)))
    (local.set $y0 (i64.and (local.get $y) (i64.const 0xffffffff)))
    (local.set $y1 (i64.shr_u (local.get $y) (i64.const 32)))
    (local.set $cross (i64.add (i64.add
      (i64.shr_u (i64.mul (local.get $x0) (local.get $y0)) (i64.const 32))
      (i64.and (i64.mul (local.get $x1) (local.get $y0)) (i64.const 0xffffffff)))
      (i64.and (i64.mul (local.get $x0) (local.get $y1)) (i64.const 0xffffffff))))
    (i64.add (i64.add (i64.add
      (i64.mul (local.get $x1) (local.get $y1))
      (i64.shr_u (i64.mul (local.get $x1) (local.get $y0)) (i64.const 32)))
      (i64.shr_u (i64.mul (local.get $x0) (local.get $y1)) (i64.const 32)))
      (i64.shr_u (local.get $cross) (i64.const 32))))

  (func $intr_mulhi_s (param $x i64) (param $y i64) (result i64)
    (i64.sub (call $intr_mulhi_u (local.get $x) (local.get $y))
      (i64.add
        (i64.and (i64.shr_s (local.get $x) (i64.const 63)) (local.get $y))
        (i64.and (i64.shr_s (local.get $y) (i64.const 63)) (local.get $x)))))

`;
}

function emitMetadata(L: Layout, spec: ModuleSpec, sysprocMask: number): string {
  const lines: string[] = [];
  lines.push("  ;; ---- metadata exports ----");
  lines.push(`  (func $state_addr (result i32) (i32.const ${L.stateBase}))`);
  lines.push(`  (func $state_size (result i32) (i32.const ${L.stateSize}))`);
  lines.push(`  (func $io_base (result i32) (i32.const ${L.ioBase}))`);
  lines.push(`  (func $io_size (result i32) (i32.const ${L.ioSize}))`);
  lines.push(`  (func $ctx_addr (result i32) (i32.const ${L.ctxBase}))`);
  lines.push(`  (func $reg_count (result i32) (i32.const ${spec.entries.length}))`);

  // reg_info(index, outPtr) — writes { inputType:u32, kind:u32, inSize:u32, outSize:u32 }
  lines.push(`  (func $reg_info (param $i i32) (param $o i32)`);
  for (let i = 0; i < spec.entries.length; i++) {
    const e = spec.entries[i];
    lines.push(`    (if (i32.eq (local.get $i) (i32.const ${i})) (then`);
    lines.push(`      (i32.store (local.get $o) (i32.const ${e.inputType}))`);
    lines.push(`      (i32.store (i32.add (local.get $o) (i32.const 4)) (i32.const ${e.kind}))`);
    lines.push(`      (i32.store (i32.add (local.get $o) (i32.const 8)) (i32.const ${e.inSize}))`);
    lines.push(`      (i32.store (i32.add (local.get $o) (i32.const 12)) (i32.const ${e.outSize}))`);
    lines.push(`      (return)))`);
  }
  lines.push(`    (i32.store (local.get $o) (i32.const 0))`);
  lines.push(`    (i32.store (i32.add (local.get $o) (i32.const 4)) (i32.const 0))`);
  lines.push(`    (i32.store (i32.add (local.get $o) (i32.const 8)) (i32.const 0))`);
  lines.push(`    (i32.store (i32.add (local.get $o) (i32.const 12)) (i32.const 0)))`);

  lines.push(`  (func $reg_sysproc_mask (result i32) (i32.const ${sysprocMask}))`);

  lines.push(`  (func $sysproc_locals_size (param $sp i32) (result i32)`);
  lines.push(emitSysSwitch(spec.sysprocs, (sp) => sp.localsSize));
  lines.push(`    (i32.const 0))`);

  lines.push(`  (func $sysproc_in_size (param $sp i32) (result i32)`);
  lines.push(emitSysSwitch(spec.sysprocs, (sp) => sp.inSize));
  lines.push(`    (i32.const 0))`);

  lines.push(`  (func $sysproc_out_size (param $sp i32) (result i32)`);
  lines.push(emitSysSwitch(spec.sysprocs, (sp) => sp.outSize));
  lines.push(`    (i32.const 0))`);

  lines.push(`  (func $has_migrate (result i32) (i32.const ${spec.migrate ? 1 : 0}))`);
  lines.push(`  (func $migrate_old_state_size (result i32) (i32.const ${spec.migrate?.oldStateSize ?? 0}))`);
  lines.push(`  (func $migrate_locals_size (result i32) (i32.const ${spec.migrate?.localsSize ?? 0}))`);

  return lines.join("\n");
}

function emitSysSwitch(sysprocs: SysProcInfo[], val: (sp: SysProcInfo) => number): string {
  const lines: string[] = [];
  for (const sp of sysprocs) {
    lines.push(`    (if (i32.eq (local.get $sp) (i32.const ${sp.id})) (then (return (i32.const ${val(sp)}))))`);
  }
  return lines.join("\n");
}

function emitDispatch(spec: ModuleSpec, usesPrng: boolean): string {
  const lines: string[] = [];
  lines.push("  ;; ---- dispatch ----");
  lines.push("  (func $dispatch (param $kind i32) (param $it i32) (param $inOff i32) (param $outOff i32) (param $localsOff i32)");
  if (usesPrng) {
    // The wrapper is the PRNG frame boundary. Wasm locals survive a synchronous
    // reentrant host call, so they hold the caller stream while the nested dispatch
    // derives and consumes its own seed.
    lines.push("    (local $saved0 i64) (local $saved1 i64) (local $saved2 i64) (local $saved3 i64) (local $savedCounter i64) (local $nested i32)");
    lines.push("    (local.set $saved0 (global.get $prngSeed0))");
    lines.push("    (local.set $saved1 (global.get $prngSeed1))");
    lines.push("    (local.set $saved2 (global.get $prngSeed2))");
    lines.push("    (local.set $saved3 (global.get $prngSeed3))");
    lines.push("    (local.set $savedCounter (global.get $prngCounter))");
    lines.push("    (local.set $nested (global.get $dispatchDepth))");
    lines.push("    (global.set $dispatchDepth (i32.add (global.get $dispatchDepth) (i32.const 1)))");
    lines.push("    (call $prng_seed_dispatch (local.get $kind) (local.get $it) (local.get $inOff))");
    lines.push("    (call $dispatch_body (local.get $kind) (local.get $it) (local.get $inOff) (local.get $outOff) (local.get $localsOff))");
    lines.push("    (global.set $dispatchDepth (i32.sub (global.get $dispatchDepth) (i32.const 1)))");
    lines.push("    (if (local.get $nested) (then");
    lines.push("      (global.set $prngSeed0 (local.get $saved0))");
    lines.push("      (global.set $prngSeed1 (local.get $saved1))");
    lines.push("      (global.set $prngSeed2 (local.get $saved2))");
    lines.push("      (global.set $prngSeed3 (local.get $saved3))");
    lines.push("      (global.set $prngCounter (local.get $savedCounter))))");
  } else {
    lines.push("    (call $dispatch_body (local.get $kind) (local.get $it) (local.get $inOff) (local.get $outOff) (local.get $localsOff))");
  }
  lines.push("  )");

  // No arena reset here: a reentrant dispatch must allocate above the live outer frames.
  lines.push("  (func $dispatch_body (param $kind i32) (param $it i32) (param $inOff i32) (param $outOff i32) (param $localsOff i32)");

  // kind == 2: system procedure
  if (spec.sysprocs.length > 0) {
    lines.push("    (if (i32.eq (local.get $kind) (i32.const 2)) (then");
    for (const sp of spec.sysprocs) {
      lines.push(`      (if (i32.eq (local.get $it) (i32.const ${sp.id})) (then`);
      lines.push(`        (call ${sp.label} (global.get $ctxBase) (global.get $stateBase) (local.get $inOff) (local.get $outOff) (local.get $localsOff))`);
      lines.push(`        (return)))`);
    }
    lines.push("      (return)))");
  } else {
    lines.push("    (if (i32.eq (local.get $kind) (i32.const 2)) (then (return)))");
  }

  // kind == 3: MIGRATE — inOff carries the old-state blob, outOff is unused (lite_wasm_tu.h dispatch)
  if (spec.migrate) {
    lines.push("    (if (i32.eq (local.get $kind) (i32.const 3)) (then");
    lines.push(`      (call ${spec.migrate.label} (global.get $ctxBase) (global.get $stateBase) (local.get $inOff) (local.get $outOff) (local.get $localsOff))`);
    lines.push("      (return)))");
  } else {
    lines.push("    (if (i32.eq (local.get $kind) (i32.const 3)) (then (return)))");
  }

  // kind 0/1: user functions/procedures. The incoming it is masked to 16 bits like the native dispatch
  for (const e of spec.entries) {
    lines.push(`    (if (i32.and (i32.eq (i32.and (local.get $it) (i32.const 0xffff)) (i32.const ${e.inputType})) (i32.eq (local.get $kind) (i32.const ${e.kind}))) (then`);
    lines.push(`      (call ${e.label} (global.get $ctxBase) (global.get $stateBase) (local.get $inOff) (local.get $outOff) (local.get $localsOff))`);
    lines.push(`      (return)))`);
  }

  lines.push("  )");
  return lines.join("\n");
}

function emitInitialize(): string {
  return `  ;; ---- reactor init ----
  (func $_initialize nop)`;
}
