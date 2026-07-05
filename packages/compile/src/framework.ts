// Framework WAT assembler. Produces a complete WASM-text module from per-contract data
// (state size, registered entries, system procedures, and the user function bodies).
// No placeholders, no regex splicing — codegen passes concrete data and this emits a valid module.
//
// Memory layout (all offsets computed here, embedded as constants):
//   [0 .. stateSize)            resident StateData (engine aliases contractStates[slot] here)
//   [ctxBase .. ctxBase+256)    QpiContext header (host populates per call)
//   [ioBase ..]                 io carve: [in 64K | out 64K | locals 32K | arena]
//
// QpiContext field offsets (engine abi.ts): contractIndex@0, originator@40, invocator@72, reward@104.

// IO carve sizes — MUST match the engine (runtime.ts IN_SZ/OUT_SZ/LOCALS_SZ) and core-lite's
// lite_wasm_contracts.h. tests/abi-drift.test.ts pins these against the engine so a core change can't
// desync silently.
export const IN_SZ = 64 * 1024;
export const OUT_SZ = 64 * 1024;
export const LOCALS_SZ = 32 * 1024;
const CTX_SZ = 256;

// QpiContext field byte-offsets the forwarders read — the single place this WAT depends on the context
// header layout. MUST equal the engine's abi.ts QpiContext.OFFSETS (which derives them from the C struct);
// tests/abi-drift.test.ts asserts that, so a layout change in core surfaces as a failing test, not silent
// wrong-identity reads.
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
  hasMigrate?: boolean;
  memBase?: number;           // shared-memory gtest mode: import env.memory and place the whole layout at
                              // this byte offset inside the provider's (corpus runner's) memory. Every
                              // address in the module is layout-global-relative, so shifting the bases in
                              // computeLayout relocates everything — there are no data segments.
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
  // Asset-iterator result buffer (AssetOwnership/PossessionIterator): 1024 records × 80 bytes, written by
  // the assetEnumerate host import at begin() and indexed by the iterator's cursor.
  const iterBufBase = align(arenaEnd, 16);
  const iterBufSize = 80 * 1024;
  const pages = Math.ceil((iterBufBase + iterBufSize) / 65536) + 1;
  return { stateBase, stateSize, ctxBase, ioBase, inBase, outBase, localsBase, arenaBase, arenaEnd, ioSize, pages, iterBufBase };
}

// ---- The complete module assembler ----

export function emitModule(spec: ModuleSpec): string {
  const L = computeLayout(spec.stateSize, spec.arenaSize, spec.memBase ?? 0);
  const sysprocMask = spec.sysprocs.reduce((m, sp) => m | (1 << sp.id), 0);

  return [
    "(module",
    "  ;; ---- qinit-compile generated module ----",
    emitImports(),
    spec.memBase !== undefined
      ? `  (import "env" "memory" (memory ${L.pages}))`
      : `  (memory (export "memory") ${L.pages} ${L.pages})`,
    emitGlobals(L),
    emitExportList(),
    emitMemOps(),
    emitAllocators(L),
    emitForwarders(),
    emitIntrinsics(),
    emitMetadata(L, spec, sysprocMask),
    spec.userFunctionsWat,
    emitDispatch(spec),
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

function emitImports(): string {
  return `  ;; ---- lhost imports ----
  (import "lhost" "beginFn" (func $lh_beginFn (param i32)))
  (import "lhost" "endFn" (func $lh_endFn (param i32)))
  (import "lhost" "markDirty" (func $lh_markDirty (param i32)))
  (import "lhost" "pauseLog" (func $lh_pauseLog))
  (import "lhost" "resumeLog" (func $lh_resumeLog))
  (import "lhost" "acquireScratch" (func $lh_acquireScratch (param i64 i32) (result i32)))
  (import "lhost" "releaseScratch" (func $lh_releaseScratch (param i32)))
  (import "lhost" "logBytes" (func $lh_logBytes (param i32 i32 i32 i32)))
  (import "lhost" "k12" (func $lh_k12 (param i32 i32 i32)))
  (import "lhost" "transfer" (func $lh_transfer (param i32 i64) (result i64)))
  (import "lhost" "transferTyped" (func $lh_transferTyped (param i32 i64 i32) (result i64)))
  (import "lhost" "abort" (func $lh_abort (param i32)))
  (import "lhost" "burn" (func $lh_burn (param i64 i32) (result i64)))
  (import "lhost" "epoch" (func $lh_epoch (result i32)))
  (import "lhost" "tick" (func $lh_tick (result i32)))
  (import "lhost" "numberOfTickTransactions" (func $lh_numberOfTickTransactions (result i32)))
  (import "lhost" "getEntity" (func $lh_getEntity (param i32 i32) (result i32)))
  (import "lhost" "queryFeeReserve" (func $lh_queryFeeReserve (param i32) (result i64)))
  (import "lhost" "nextId" (func $lh_nextId (param i32 i32)))
  (import "lhost" "prevId" (func $lh_prevId (param i32 i32)))
  (import "lhost" "isContractId" (func $lh_isContractId (param i32) (result i32)))
  (import "lhost" "arbitrator" (func $lh_arbitrator (param i32)))
  (import "lhost" "computor" (func $lh_computor (param i32 i32)))
  (import "lhost" "day" (func $lh_day (result i32)))
  (import "lhost" "year" (func $lh_year (result i32)))
  (import "lhost" "hour" (func $lh_hour (result i32)))
  (import "lhost" "minute" (func $lh_minute (result i32)))
  (import "lhost" "month" (func $lh_month (result i32)))
  (import "lhost" "second" (func $lh_second (result i32)))
  (import "lhost" "millisecond" (func $lh_millisecond (result i32)))
  (import "lhost" "now" (func $lh_now (param i32)))
  (import "lhost" "prevSpectrumDigest" (func $lh_prevSpectrumDigest (param i32)))
  (import "lhost" "prevUniverseDigest" (func $lh_prevUniverseDigest (param i32)))
  (import "lhost" "prevComputerDigest" (func $lh_prevComputerDigest (param i32)))
  (import "lhost" "isAssetIssued" (func $lh_isAssetIssued (param i32 i64) (result i32)))
  (import "lhost" "issueAsset" (func $lh_issueAsset (param i64 i32 i32 i64 i64) (result i64)))
  (import "lhost" "numberOfShares" (func $lh_numberOfShares (param i32 i32 i32) (result i64)))
  (import "lhost" "numberOfPossessedShares" (func $lh_numberOfPossessedShares (param i64 i32 i32 i32 i32 i32) (result i64)))
  (import "lhost" "transferShareOwnershipAndPossession" (func $lh_transferShares (param i64 i32 i32 i32 i64 i32) (result i64)))
  (import "lhost" "acquireShares" (func $lh_acquireShares (param i64 i32 i32 i32 i64 i32 i32 i64) (result i64)))
  (import "lhost" "releaseShares" (func $lh_releaseShares (param i64 i32 i32 i32 i64 i32 i32 i64) (result i64)))
  (import "lhost" "dayOfWeek" (func $lh_dayOfWeek (param i32 i32 i32) (result i32)))
  (import "lhost" "signatureValidity" (func $lh_signatureValidity (param i32 i32 i32) (result i32)))
  (import "lhost" "bidInIPO" (func $lh_bidInIPO (param i32 i64 i32) (result i64)))
  (import "lhost" "ipoBidId" (func $lh_ipoBidId (param i32 i32 i32)))
  (import "lhost" "ipoBidPrice" (func $lh_ipoBidPrice (param i32 i32) (result i64)))
  (import "lhost" "computeMiningFunction" (func $lh_computeMiningFunction (param i32 i32 i32 i32)))
  (import "lhost" "initMiningSeed" (func $lh_initMiningSeed (param i32)))
  (import "lhost" "getOracleQueryStatus" (func $lh_getOracleQueryStatus (param i64) (result i32)))
  (import "lhost" "unsubscribeOracle" (func $lh_unsubscribeOracle (param i32) (result i32)))
  (import "lhost" "queryOracle" (func $lh_queryOracle (param i32 i32 i32 i32 i32 i64) (result i64)))
  (import "lhost" "subscribeOracle" (func $lh_subscribeOracle (param i32 i32 i32 i32 i32 i32 i64) (result i32)))
  (import "lhost" "getOracleQuery" (func $lh_getOracleQuery (param i64 i32 i32) (result i32)))
  (import "lhost" "getOracleReply" (func $lh_getOracleReply (param i64 i32 i32) (result i32)))
  (import "lhost" "distributeDividends" (func $lh_distributeDividends (param i64) (result i32)))
  (import "lhost" "liteCallFunction" (func $lh_liteCallFunction (param i32 i32 i32 i32 i32 i32) (result i32)))
  (import "lhost" "liteInvokeProcedure" (func $lh_liteInvokeProcedure (param i32 i32 i32 i32 i32 i32 i64) (result i32)))
  (import "lhost" "liteSetShareholderProposal" (func $lh_liteSetShareholderProposal (param i32 i32 i64) (result i32)))
  (import "lhost" "liteSetShareholderVotes" (func $lh_liteSetShareholderVotes (param i32 i32 i32 i64) (result i32)))
  (import "lhost" "assetEnumerate" (func $lh_assetEnumerate (param i32 i32 i32 i32 i32 i32) (result i32)))`;
}

function emitGlobals(L: Layout): string {
  return `  ;; ---- globals ----
  (global $stateBase i32 (i32.const ${L.stateBase}))
  (global $ctxBase i32 (i32.const ${L.ctxBase}))
  (global $ioBase i32 (i32.const ${L.ioBase}))
  (global $arenaBase i32 (i32.const ${L.arenaBase}))
  (global $arenaTop (export "arena_top") (mut i32) (i32.const ${L.arenaBase}))
  (global $assetIterBase i32 (i32.const ${L.iterBufBase}))`;
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
  // Context accessors read the QpiContext header at $ctxBase: contractIndex@0, originator@40, invocator@72, reward@104.
  return `  ;; ---- qpi forwarders ----
  (func $qpi_transfer (param $d i32) (param $a i64) (result i64) (call $lh_transfer (local.get $d) (local.get $a)))
  (func $qpi_transferTyped (param $d i32) (param $a i64) (param $t i32) (result i64) (call $lh_transferTyped (local.get $d) (local.get $a) (local.get $t)))
  (func $qpi_burn (param $a i64) (param $c i32) (result i64) (call $lh_burn (local.get $a) (local.get $c)))
  (func $qpi_epoch (result i32) (call $lh_epoch))
  (func $qpi_tick (result i32) (call $lh_tick))
  (func $qpi_numberOfTickTransactions (result i32) (call $lh_numberOfTickTransactions))
  (func $qpi_day (result i32) (call $lh_day))
  (func $qpi_year (result i32) (call $lh_year))
  (func $qpi_hour (result i32) (call $lh_hour))
  (func $qpi_minute (result i32) (call $lh_minute))
  (func $qpi_month (result i32) (call $lh_month))
  (func $qpi_second (result i32) (call $lh_second))
  (func $qpi_millisecond (result i32) (call $lh_millisecond))
  (func $qpi_now (param $o i32) (call $lh_now (local.get $o)))
  (func $qpi_k12 (param $i i32) (param $l i32) (param $o i32) (call $lh_k12 (local.get $i) (local.get $l) (local.get $o)))
  (func $qpi_getEntity (param $i i32) (param $e i32) (result i32) (call $lh_getEntity (local.get $i) (local.get $e)))
  (func $qpi_queryFeeReserve (param $c i32) (result i64) (call $lh_queryFeeReserve (local.get $c)))
  (func $qpi_nextId (param $i i32) (param $o i32) (call $lh_nextId (local.get $i) (local.get $o)))
  (func $qpi_prevId (param $i i32) (param $o i32) (call $lh_prevId (local.get $i) (local.get $o)))
  (func $qpi_isContractId (param $i i32) (result i32) (call $lh_isContractId (local.get $i)))
  (func $qpi_arbitrator (param $o i32) (call $lh_arbitrator (local.get $o)))
  (func $qpi_computor (param $i i32) (param $o i32) (call $lh_computor (local.get $i) (local.get $o)))
  (func $qpi_prevSpectrumDigest (param $o i32) (call $lh_prevSpectrumDigest (local.get $o)))
  (func $qpi_prevUniverseDigest (param $o i32) (call $lh_prevUniverseDigest (local.get $o)))
  (func $qpi_prevComputerDigest (param $o i32) (call $lh_prevComputerDigest (local.get $o)))
  (func $qpi_isAssetIssued (param $i i32) (param $n i64) (result i32) (call $lh_isAssetIssued (local.get $i) (local.get $n)))
  (func $qpi_issueAsset (param $n i64) (param $i i32) (param $d i32) (param $s i64) (param $u i64) (result i64) (call $lh_issueAsset (local.get $n) (local.get $i) (local.get $d) (local.get $s) (local.get $u)))
  (func $qpi_numberOfShares (param $a i32) (param $o i32) (param $p i32) (result i64) (call $lh_numberOfShares (local.get $a) (local.get $o) (local.get $p)))
  (func $qpi_numberOfPossessedShares (param $n i64) (param $i i32) (param $o i32) (param $p i32) (param $om i32) (param $pm i32) (result i64) (call $lh_numberOfPossessedShares (local.get $n) (local.get $i) (local.get $o) (local.get $p) (local.get $om) (local.get $pm)))
  (func $qpi_transferShares (param $n i64) (param $i i32) (param $o i32) (param $p i32) (param $s i64) (param $no i32) (result i64) (call $lh_transferShares (local.get $n) (local.get $i) (local.get $o) (local.get $p) (local.get $s) (local.get $no)))
  (func $qpi_acquireShares (param $n i64) (param $i i32) (param $o i32) (param $p i32) (param $s i64) (param $som i32) (param $spm i32) (param $f i64) (result i64) (call $lh_acquireShares (local.get $n) (local.get $i) (local.get $o) (local.get $p) (local.get $s) (local.get $som) (local.get $spm) (local.get $f)))
  (func $qpi_releaseShares (param $n i64) (param $i i32) (param $o i32) (param $p i32) (param $s i64) (param $dom i32) (param $dpm i32) (param $f i64) (result i64) (call $lh_releaseShares (local.get $n) (local.get $i) (local.get $o) (local.get $p) (local.get $s) (local.get $dom) (local.get $dpm) (local.get $f)))
  (func $qpi_dayOfWeek (param $y i32) (param $m i32) (param $d i32) (result i32) (call $lh_dayOfWeek (local.get $y) (local.get $m) (local.get $d)))
  (func $qpi_signatureValidity (param $e i32) (param $g i32) (param $s i32) (result i32) (call $lh_signatureValidity (local.get $e) (local.get $g) (local.get $s)))
  (func $qpi_bidInIPO (param $i i32) (param $p i64) (param $q i32) (result i64) (call $lh_bidInIPO (local.get $i) (local.get $p) (local.get $q)))
  (func $qpi_ipoBidId (param $i i32) (param $b i32) (param $o i32) (call $lh_ipoBidId (local.get $i) (local.get $b) (local.get $o)))
  (func $qpi_ipoBidPrice (param $i i32) (param $b i32) (result i64) (call $lh_ipoBidPrice (local.get $i) (local.get $b)))
  (func $qpi_computeMiningFunction (param $s i32) (param $p i32) (param $n i32) (param $o i32) (call $lh_computeMiningFunction (local.get $s) (local.get $p) (local.get $n) (local.get $o)))
  (func $qpi_initMiningSeed (param $s i32) (call $lh_initMiningSeed (local.get $s)))
  (func $qpi_getOracleQueryStatus (param $q i64) (result i32) (call $lh_getOracleQueryStatus (local.get $q)))
  (func $qpi_unsubscribeOracle (param $s i32) (result i32) (call $lh_unsubscribeOracle (local.get $s)))
  (func $qpi_distributeDividends (param $a i64) (result i32) (call $lh_distributeDividends (local.get $a)))
  (func $qpi_abort (param $c i32) (call $lh_abort (local.get $c)))
  (func $qpi_markDirty (param $c i32) (call $lh_markDirty (local.get $c)))
  (func $qpi_logBytes (param $ci i32) (param $lv i32) (param $m i32) (param $sz i32) (call $lh_logBytes (local.get $ci) (local.get $lv) (local.get $m) (local.get $sz)))
  (func $liteCallFunction (param $c i32) (param $it i32) (param $i i32) (param $is i32) (param $o i32) (param $os i32) (result i32) (call $lh_liteCallFunction (local.get $c) (local.get $it) (local.get $i) (local.get $is) (local.get $o) (local.get $os)))
  (func $liteInvokeProcedure (param $c i32) (param $it i32) (param $i i32) (param $is i32) (param $o i32) (param $os i32) (param $r i64) (result i32) (call $lh_liteInvokeProcedure (local.get $c) (local.get $it) (local.get $i) (local.get $is) (local.get $o) (local.get $os) (local.get $r)))
  ;; context header accessors (offsets from CTX — pinned to the engine's abi.ts by tests/abi-drift.test.ts)
  (func $qpi_contractIndex (result i32) (i32.load (i32.add (global.get $ctxBase) (i32.const ${CTX.contractIndex}))))
  (func $qpi_invocator (param $o i32) (call $copyMem (local.get $o) (i32.add (global.get $ctxBase) (i32.const ${CTX.invocator})) (i32.const 32)))
  (func $qpi_originator (param $o i32) (call $copyMem (local.get $o) (i32.add (global.get $ctxBase) (i32.const ${CTX.originator})) (i32.const 32)))
  (func $qpi_invocationReward (result i64) (i64.load (i32.add (global.get $ctxBase) (i32.const ${CTX.invocationReward}))))`;
}

function emitIntrinsics(): string {
  // Container + helper intrinsics the codegen targets. HashMap helpers reproduce the real qpi.h
  // layout (Element _elements[L] @0, _occupationFlags @occBase, _population @popOff) and probing
  // (linear, one occupation flag at a time — observably identical to the batched qpi.h version).
  // hashMode: 0 = id/m256i key (hash = first 8 bytes), 1 = other key (hash = K12(key)[0..8]).
  return `  ;; ---- intrinsics ----
  ;; SELF as a materialized id: { contractIndex:u64, 0, 0, 0 } in scratch, returns its address.
  (func $self_id (result i32) (local $p i32)
    (local.set $p (call $qpiAllocLocals (i32.const 32)))
    (call $setMem (local.get $p) (i32.const 32) (i32.const 0))
    (i64.store (local.get $p) (i64.extend_i32_u (call $qpi_contractIndex)))
    (local.get $p))

  ;; hash(key) & (L-1) → initial probe index
  (func $hm_hash (param $keyAddr i32) (param $keySize i32) (param $L i32) (param $hashMode i32) (result i32)
    (local $h i64) (local $t i32)
    (if (i32.eqz (local.get $hashMode))
      (then (local.set $h (i64.load (local.get $keyAddr))))
      (else
        (local.set $t (call $qpiAllocLocals (i32.const 8)))
        (call $qpi_k12 (local.get $keyAddr) (local.get $keySize) (local.get $t))
        (local.set $h (i64.load (local.get $t)))))
    (i32.and (i32.wrap_i64 (local.get $h)) (i32.sub (local.get $L) (i32.const 1))))

  ;; read 2-bit occupation flag for slot index
  (func $hm_flag (param $occ i32) (param $index i32) (result i32)
    (i32.and
      (i32.wrap_i64 (i64.shr_u
        (i64.load (i32.add (local.get $occ) (i32.mul (i32.shr_u (local.get $index) (i32.const 5)) (i32.const 8))))
        (i64.extend_i32_u (i32.shl (i32.and (local.get $index) (i32.const 31)) (i32.const 1)))))
      (i32.const 3)))

  ;; element address for slot index
  (func $hm_elem (param $map i32) (param $index i32) (param $elemSize i32) (result i32)
    (i32.add (local.get $map) (i32.mul (local.get $index) (local.get $elemSize))))

  ;; getElementIndex(key) → slot index, or -1 if not present
  (func $hm_index (param $map i32) (param $keyAddr i32) (param $L i32) (param $elemSize i32) (param $keySize i32) (param $occBase i32) (param $hashMode i32) (result i32)
    (local $index i32) (local $i i32) (local $occ i32) (local $flag i32)
    (local.set $occ (i32.add (local.get $map) (local.get $occBase)))
    (local.set $index (call $hm_hash (local.get $keyAddr) (local.get $keySize) (local.get $L) (local.get $hashMode)))
    (block $done
      (loop $probe
        (br_if $done (i32.ge_u (local.get $i) (local.get $L)))
        (local.set $flag (call $hm_flag (local.get $occ) (local.get $index)))
        (if (i32.eqz (local.get $flag)) (then (return (i32.const -1))))
        (if (i32.eq (local.get $flag) (i32.const 1)) (then
          (if (call $memeq (call $hm_elem (local.get $map) (local.get $index) (local.get $elemSize)) (local.get $keyAddr) (local.get $keySize))
            (then (return (local.get $index))))))
        (local.set $index (i32.and (i32.add (local.get $index) (i32.const 1)) (i32.sub (local.get $L) (i32.const 1))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $probe)))
    (i32.const -1))

  ;; get(key, &value) → 1 if found (value copied to valOut), else 0
  (func $hm_get (param $map i32) (param $keyAddr i32) (param $valOut i32) (param $L i32) (param $elemSize i32) (param $keySize i32) (param $valOff i32) (param $valSize i32) (param $occBase i32) (param $hashMode i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $hm_index (local.get $map) (local.get $keyAddr) (local.get $L) (local.get $elemSize) (local.get $keySize) (local.get $occBase) (local.get $hashMode)))
    (if (i32.lt_s (local.get $idx) (i32.const 0)) (then (return (i32.const 0))))
    (call $copyMem (local.get $valOut) (i32.add (call $hm_elem (local.get $map) (local.get $idx) (local.get $elemSize)) (local.get $valOff)) (local.get $valSize))
    (i32.const 1))

  ;; set(key, value) — insert or replace; returns slot index or -1 if full
  (func $hm_set (param $map i32) (param $keyAddr i32) (param $valAddr i32) (param $L i32) (param $elemSize i32) (param $keySize i32) (param $valOff i32) (param $valSize i32) (param $occBase i32) (param $popOff i32) (param $hashMode i32) (result i32)
    (local $index i32) (local $i i32) (local $occ i32) (local $flag i32) (local $e i32) (local $word i32)
    (local.set $occ (i32.add (local.get $map) (local.get $occBase)))
    (local.set $index (call $hm_hash (local.get $keyAddr) (local.get $keySize) (local.get $L) (local.get $hashMode)))
    (block $done
      (loop $probe
        (br_if $done (i32.ge_u (local.get $i) (local.get $L)))
        (local.set $flag (call $hm_flag (local.get $occ) (local.get $index)))
        (local.set $e (call $hm_elem (local.get $map) (local.get $index) (local.get $elemSize)))
        (if (i32.eqz (local.get $flag)) (then
          ;; empty slot → occupy: set flag bit, write key+value, bump population
          (local.set $word (i32.add (local.get $occ) (i32.mul (i32.shr_u (local.get $index) (i32.const 5)) (i32.const 8))))
          (i64.store (local.get $word) (i64.or (i64.load (local.get $word))
            (i64.shl (i64.const 1) (i64.extend_i32_u (i32.shl (i32.and (local.get $index) (i32.const 31)) (i32.const 1))))))
          (call $copyMem (local.get $e) (local.get $keyAddr) (local.get $keySize))
          (call $copyMem (i32.add (local.get $e) (local.get $valOff)) (local.get $valAddr) (local.get $valSize))
          (i64.store (i32.add (local.get $map) (local.get $popOff)) (i64.add (i64.load (i32.add (local.get $map) (local.get $popOff))) (i64.const 1)))
          (return (local.get $index))))
        (if (i32.eq (local.get $flag) (i32.const 1)) (then
          (if (call $memeq (local.get $e) (local.get $keyAddr) (local.get $keySize)) (then
            ;; existing key → replace value
            (call $copyMem (i32.add (local.get $e) (local.get $valOff)) (local.get $valAddr) (local.get $valSize))
            (return (local.get $index))))))
        (local.set $index (i32.and (i32.add (local.get $index) (i32.const 1)) (i32.sub (local.get $L) (i32.const 1))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $probe)))
    (i32.const -1))

  ;; population() → element count
  (func $hm_population (param $map i32) (param $popOff i32) (result i64)
    (i64.load (i32.add (local.get $map) (local.get $popOff))))

  ;; reset() — zero the whole map
  (func $hm_reset (param $map i32) (param $totalSize i32)
    (call $setMem (local.get $map) (local.get $totalSize) (i32.const 0)))

  ;; nextElementIndex(prev) — first occupied slot index > prev (pass -1 to start), or -1 when none left
  (func $hm_next (param $map i32) (param $prev i32) (param $L i32) (param $occBase i32) (result i32)
    (local $i i32) (local $occ i32)
    (local.set $occ (i32.add (local.get $map) (local.get $occBase)))
    (local.set $i (if (result i32) (i32.lt_s (local.get $prev) (i32.const 0)) (then (i32.const 0)) (else (i32.add (local.get $prev) (i32.const 1)))))
    (block $done
      (loop $scan
        (br_if $done (i32.ge_u (local.get $i) (local.get $L)))
        (if (i32.eq (call $hm_flag (local.get $occ) (local.get $i)) (i32.const 1)) (then (return (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $scan)))
    (i32.const -1))

  ;; removeByKey(key) — mark the slot for removal (occupied 0b01 -> 0b10), decrement population, clear element
  (func $hm_remove (param $map i32) (param $keyAddr i32) (param $L i32) (param $elemSize i32) (param $keySize i32) (param $occBase i32) (param $popOff i32) (param $hashMode i32)
    (local $idx i32) (local $word i32)
    (local.set $idx (call $hm_index (local.get $map) (local.get $keyAddr) (local.get $L) (local.get $elemSize) (local.get $keySize) (local.get $occBase) (local.get $hashMode)))
    (if (i32.lt_s (local.get $idx) (i32.const 0)) (then (return)))
    (local.set $word (i32.add (i32.add (local.get $map) (local.get $occBase)) (i32.mul (i32.shr_u (local.get $idx) (i32.const 5)) (i32.const 8))))
    (i64.store (local.get $word) (i64.xor (i64.load (local.get $word))
      (i64.shl (i64.const 3) (i64.extend_i32_u (i32.shl (i32.and (local.get $idx) (i32.const 31)) (i32.const 1))))))
    (i64.store (i32.add (local.get $map) (local.get $popOff)) (i64.sub (i64.load (i32.add (local.get $map) (local.get $popOff))) (i64.const 1)))
    ;; _markRemovalCounter (popOff + 8) ++
    (i64.store (i32.add (local.get $map) (i32.add (local.get $popOff) (i32.const 8))) (i64.add (i64.load (i32.add (local.get $map) (i32.add (local.get $popOff) (i32.const 8)))) (i64.const 1)))
    (call $setMem (call $hm_elem (local.get $map) (local.get $idx) (local.get $elemSize)) (local.get $elemSize) (i32.const 0)))

  ;; QPI safe math: div/mod return 0 on a zero divisor; min/max/abs evaluate each arg once.
  (func $m_div_s (param $a i64) (param $b i64) (result i64)
    (if (result i64) (i64.eqz (local.get $b)) (then (i64.const 0)) (else (i64.div_s (local.get $a) (local.get $b)))))
  (func $m_mod_s (param $a i64) (param $b i64) (result i64)
    (if (result i64) (i64.eqz (local.get $b)) (then (i64.const 0)) (else (i64.rem_s (local.get $a) (local.get $b)))))
  (func $m_min_s (param $a i64) (param $b i64) (result i64)
    (select (local.get $a) (local.get $b) (i64.lt_s (local.get $a) (local.get $b))))
  (func $m_max_s (param $a i64) (param $b i64) (result i64)
    (select (local.get $a) (local.get $b) (i64.gt_s (local.get $a) (local.get $b))))
  (func $m_div_u (param $a i64) (param $b i64) (result i64)
    (if (result i64) (i64.eqz (local.get $b)) (then (i64.const 0)) (else (i64.div_u (local.get $a) (local.get $b)))))
  (func $m_mod_u (param $a i64) (param $b i64) (result i64)
    (if (result i64) (i64.eqz (local.get $b)) (then (i64.const 0)) (else (i64.rem_u (local.get $a) (local.get $b)))))
  (func $m_min_u (param $a i64) (param $b i64) (result i64)
    (select (local.get $a) (local.get $b) (i64.lt_u (local.get $a) (local.get $b))))
  (func $m_max_u (param $a i64) (param $b i64) (result i64)
    (select (local.get $a) (local.get $b) (i64.gt_u (local.get $a) (local.get $b))))
  (func $m_abs (param $a i64) (result i64)
    (select (local.get $a) (i64.sub (i64.const 0) (local.get $a)) (i64.ge_s (local.get $a) (i64.const 0))))

  ;; ---- uint128 (two-limb little-endian: low@0, high@8) ----
  ;; High 64 bits of the unsigned 64x64 product, via 32-bit splitting (wasm has no widening multiply).
  (func $u128_mulhi (param $x i64) (param $y i64) (result i64)
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

  (func $u128_set (param $dst i32) (param $lo i64) (param $hi i64)
    (i64.store (local.get $dst) (local.get $lo))
    (i64.store offset=8 (local.get $dst) (local.get $hi)))

  (func $u128_add (param $dst i32) (param $a i32) (param $b i32)
    (local $lo i64)
    (local.set $lo (i64.add (i64.load (local.get $a)) (i64.load (local.get $b))))
    (i64.store offset=8 (local.get $dst) (i64.add (i64.add
      (i64.load offset=8 (local.get $a)) (i64.load offset=8 (local.get $b)))
      (i64.extend_i32_u (i64.lt_u (local.get $lo) (i64.load (local.get $a)))))) ;; carry
    (i64.store (local.get $dst) (local.get $lo)))

  (func $u128_sub (param $dst i32) (param $a i32) (param $b i32)
    (local $al i64) (local $bl i64)
    (local.set $al (i64.load (local.get $a)))
    (local.set $bl (i64.load (local.get $b)))
    (i64.store offset=8 (local.get $dst) (i64.sub (i64.sub
      (i64.load offset=8 (local.get $a)) (i64.load offset=8 (local.get $b)))
      (i64.extend_i32_u (i64.lt_u (local.get $al) (local.get $bl))))) ;; borrow
    (i64.store (local.get $dst) (i64.sub (local.get $al) (local.get $bl))))

  (func $u128_mul (param $dst i32) (param $a i32) (param $b i32)
    (local $al i64) (local $ah i64) (local $bl i64) (local $bh i64)
    (local.set $al (i64.load (local.get $a)))
    (local.set $ah (i64.load offset=8 (local.get $a)))
    (local.set $bl (i64.load (local.get $b)))
    (local.set $bh (i64.load offset=8 (local.get $b)))
    (i64.store offset=8 (local.get $dst) (i64.add (i64.add
      (call $u128_mulhi (local.get $al) (local.get $bl))
      (i64.mul (local.get $al) (local.get $bh)))
      (i64.mul (local.get $ah) (local.get $bl))))
    (i64.store (local.get $dst) (i64.mul (local.get $al) (local.get $bl))))

  ;; unsigned a < b (128-bit)
  (func $u128_lt (param $a i32) (param $b i32) (result i32)
    (local $ah i64) (local $bh i64)
    (local.set $ah (i64.load offset=8 (local.get $a)))
    (local.set $bh (i64.load offset=8 (local.get $b)))
    (if (result i32) (i64.eq (local.get $ah) (local.get $bh))
      (then (i64.lt_u (i64.load (local.get $a)) (i64.load (local.get $b))))
      (else (i64.lt_u (local.get $ah) (local.get $bh)))))

  (func $u128_eq (param $a i32) (param $b i32) (result i32)
    (i32.and
      (i64.eq (i64.load (local.get $a)) (i64.load (local.get $b)))
      (i64.eq (i64.load offset=8 (local.get $a)) (i64.load offset=8 (local.get $b)))))

  (func $u128_and (param $dst i32) (param $a i32) (param $b i32)
    (i64.store (local.get $dst) (i64.and (i64.load (local.get $a)) (i64.load (local.get $b))))
    (i64.store offset=8 (local.get $dst) (i64.and (i64.load offset=8 (local.get $a)) (i64.load offset=8 (local.get $b)))))

  (func $u128_or (param $dst i32) (param $a i32) (param $b i32)
    (i64.store (local.get $dst) (i64.or (i64.load (local.get $a)) (i64.load (local.get $b))))
    (i64.store offset=8 (local.get $dst) (i64.or (i64.load offset=8 (local.get $a)) (i64.load offset=8 (local.get $b)))))

  (func $u128_xor (param $dst i32) (param $a i32) (param $b i32)
    (i64.store (local.get $dst) (i64.xor (i64.load (local.get $a)) (i64.load (local.get $b))))
    (i64.store offset=8 (local.get $dst) (i64.xor (i64.load offset=8 (local.get $a)) (i64.load offset=8 (local.get $b)))))

  ;; dst = a << n (0 <= n < 128)
  (func $u128_shl (param $dst i32) (param $a i32) (param $n i64)
    (local $lo i64) (local $hi i64)
    (local.set $lo (i64.load (local.get $a)))
    (local.set $hi (i64.load offset=8 (local.get $a)))
    (if (i64.eqz (local.get $n))
      (then)
      (else (if (i64.ge_u (local.get $n) (i64.const 64))
        (then
          (local.set $hi (i64.shl (local.get $lo) (i64.sub (local.get $n) (i64.const 64))))
          (local.set $lo (i64.const 0)))
        (else
          (local.set $hi (i64.or (i64.shl (local.get $hi) (local.get $n))
            (i64.shr_u (local.get $lo) (i64.sub (i64.const 64) (local.get $n)))))
          (local.set $lo (i64.shl (local.get $lo) (local.get $n)))))))
    (i64.store (local.get $dst) (local.get $lo))
    (i64.store offset=8 (local.get $dst) (local.get $hi)))

  ;; dst = a >> n (logical, 0 <= n < 128)
  (func $u128_shr (param $dst i32) (param $a i32) (param $n i64)
    (local $lo i64) (local $hi i64)
    (local.set $lo (i64.load (local.get $a)))
    (local.set $hi (i64.load offset=8 (local.get $a)))
    (if (i64.eqz (local.get $n))
      (then)
      (else (if (i64.ge_u (local.get $n) (i64.const 64))
        (then
          (local.set $lo (i64.shr_u (local.get $hi) (i64.sub (local.get $n) (i64.const 64))))
          (local.set $hi (i64.const 0)))
        (else
          (local.set $lo (i64.or (i64.shr_u (local.get $lo) (local.get $n))
            (i64.shl (local.get $hi) (i64.sub (i64.const 64) (local.get $n)))))
          (local.set $hi (i64.shr_u (local.get $hi) (local.get $n)))))))
    (i64.store (local.get $dst) (local.get $lo))
    (i64.store offset=8 (local.get $dst) (local.get $hi)))

  ;; q = a / b (unsigned 128-bit binary long division; b==0 yields 0). mod is left in the rem locals,
  ;; not stored (callers needing it can add a rem out-param later).
  (func $u128_divmod (param $q i32) (param $a i32) (param $b i32)
    (local $al i64) (local $ah i64) (local $bl i64) (local $bh i64)
    (local $rl i64) (local $rh i64) (local $ql i64) (local $qh i64)
    (local $i i32) (local $bit i64) (local $borrow i64) (local $ge i32)
    (local.set $al (i64.load (local.get $a)))
    (local.set $ah (i64.load offset=8 (local.get $a)))
    (local.set $bl (i64.load (local.get $b)))
    (local.set $bh (i64.load offset=8 (local.get $b)))
    (if (i32.and (i64.eqz (local.get $bl)) (i64.eqz (local.get $bh)))
      (then (i64.store (local.get $q) (i64.const 0)) (i64.store offset=8 (local.get $q) (i64.const 0)) (return)))
    (local.set $i (i32.const 127))
    (block $done (loop $lp
      (br_if $done (i32.lt_s (local.get $i) (i32.const 0)))
      ;; rem <<= 1
      (local.set $rh (i64.or (i64.shl (local.get $rh) (i64.const 1)) (i64.shr_u (local.get $rl) (i64.const 63))))
      (local.set $rl (i64.shl (local.get $rl) (i64.const 1)))
      ;; rem |= bit i of a
      (if (i32.ge_s (local.get $i) (i32.const 64))
        (then (local.set $bit (i64.and (i64.shr_u (local.get $ah) (i64.extend_i32_u (i32.sub (local.get $i) (i32.const 64)))) (i64.const 1))))
        (else (local.set $bit (i64.and (i64.shr_u (local.get $al) (i64.extend_i32_u (local.get $i))) (i64.const 1)))))
      (local.set $rl (i64.or (local.get $rl) (local.get $bit)))
      ;; ge = rem >= b
      (local.set $ge (if (result i32) (i64.eq (local.get $rh) (local.get $bh))
        (then (i64.ge_u (local.get $rl) (local.get $bl))) (else (i64.gt_u (local.get $rh) (local.get $bh)))))
      (if (local.get $ge) (then
        ;; rem -= b
        (local.set $borrow (i64.extend_i32_u (i64.lt_u (local.get $rl) (local.get $bl))))
        (local.set $rh (i64.sub (i64.sub (local.get $rh) (local.get $bh)) (local.get $borrow)))
        (local.set $rl (i64.sub (local.get $rl) (local.get $bl)))
        ;; set bit i of q
        (if (i32.ge_s (local.get $i) (i32.const 64))
          (then (local.set $qh (i64.or (local.get $qh) (i64.shl (i64.const 1) (i64.extend_i32_u (i32.sub (local.get $i) (i32.const 64)))))))
          (else (local.set $ql (i64.or (local.get $ql) (i64.shl (i64.const 1) (i64.extend_i32_u (local.get $i)))))))))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (br $lp)))
    (i64.store (local.get $q) (local.get $ql))
    (i64.store offset=8 (local.get $q) (local.get $qh)))`;
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

  lines.push(`  (func $has_migrate (result i32) (i32.const ${spec.hasMigrate ? 1 : 0}))`);
  lines.push(`  (func $migrate_old_state_size (result i32) (i32.const 0))`);
  lines.push(`  (func $migrate_locals_size (result i32) (i32.const 0))`);

  return lines.join("\n");
}

function emitSysSwitch(sysprocs: SysProcInfo[], val: (sp: SysProcInfo) => number): string {
  const lines: string[] = [];
  for (const sp of sysprocs) {
    lines.push(`    (if (i32.eq (local.get $sp) (i32.const ${sp.id})) (then (return (i32.const ${val(sp)}))))`);
  }
  return lines.join("\n");
}

function emitDispatch(spec: ModuleSpec): string {
  const lines: string[] = [];
  lines.push("  ;; ---- dispatch ----");
  // No arena reset here: a reentrant dispatch (POST_INCOMING_TRANSFER fired mid-call) must allocate above
  // the live outer frames. The host resets arena_top at depth 0 and carves nested io regions from the arena.
  lines.push("  (func $dispatch (param $kind i32) (param $it i32) (param $inOff i32) (param $outOff i32) (param $localsOff i32)");

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

  // kind == 3: migrate (not yet supported) — no-op
  lines.push("    (if (i32.eq (local.get $kind) (i32.const 3)) (then (return)))");

  // kind 0/1: user functions/procedures
  for (const e of spec.entries) {
    lines.push(`    (if (i32.and (i32.eq (local.get $it) (i32.const ${e.inputType})) (i32.eq (local.get $kind) (i32.const ${e.kind}))) (then`);
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
