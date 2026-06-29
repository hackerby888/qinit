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

const IN_SZ = 64 * 1024;
const OUT_SZ = 64 * 1024;
const LOCALS_SZ = 32 * 1024;
const CTX_SZ = 256;

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
}

function computeLayout(stateSize: number, arenaSize: number): Layout {
  const align = (n: number, a: number) => Math.ceil(n / a) * a;
  const stateBase = 0;
  const ctxBase = align(Math.max(stateSize, 8), 16);
  const ioBase = align(ctxBase + CTX_SZ, 16);
  const inBase = ioBase;
  const outBase = inBase + IN_SZ;
  const localsBase = outBase + OUT_SZ;
  const arenaBase = localsBase + LOCALS_SZ;
  const arenaEnd = arenaBase + arenaSize;
  const ioSize = IN_SZ + OUT_SZ + LOCALS_SZ + arenaSize;
  const pages = Math.ceil(arenaEnd / 65536) + 1;
  return { stateBase, stateSize, ctxBase, ioBase, inBase, outBase, localsBase, arenaBase, arenaEnd, ioSize, pages };
}

// ---- The complete module assembler ----

export function emitModule(spec: ModuleSpec): string {
  const L = computeLayout(spec.stateSize, spec.arenaSize);
  const sysprocMask = spec.sysprocs.reduce((m, sp) => m | (1 << sp.id), 0);

  return [
    "(module",
    "  ;; ---- qinit-compile generated module ----",
    emitImports(),
    `  (memory (export "memory") ${L.pages} ${L.pages})`,
    emitGlobals(L),
    emitExportList(),
    emitMemOps(),
    emitAllocators(L),
    emitForwarders(),
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
  (global $arenaTop (mut i32) (i32.const ${L.arenaBase}))`;
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
        (br_if $cp (i32.lt_u (local.get $i) (local.get $size))))))`;
}

function emitAllocators(L: Layout): string {
  // Arena bump allocator. Locals + scratchpad both bump the arena; dispatch resets it per call.
  return `  ;; ---- allocators (arena bump; reset each dispatch) ----
  (func $qpiAllocLocals (param $size i32) (result i32)
    (local $off i32)
    (local.set $off (global.get $arenaTop))
    (global.set $arenaTop (i32.and (i32.add (i32.add (local.get $off) (local.get $size)) (i32.const 7)) (i32.const -8)))
    (local.get $off))

  (func $qpiFreeLocals nop)

  (func $acquireScratchpad (param $size i64) (param $initZero i32) (result i32)
    (local $off i32) (local $sz i32)
    (local.set $off (global.get $arenaTop))
    (local.set $sz (i32.wrap_i64 (local.get $size)))
    (global.set $arenaTop (i32.and (i32.add (i32.add (local.get $off) (local.get $sz)) (i32.const 7)) (i32.const -8)))
    (if (local.get $initZero) (then (call $setMem (local.get $off) (local.get $sz) (i32.const 0))))
    (local.get $off))

  (func $releaseScratchpad (param $ptr i32) nop)`;
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
  ;; context header accessors
  (func $qpi_contractIndex (result i32) (i32.load (global.get $ctxBase)))
  (func $qpi_invocator (param $o i32) (call $copyMem (local.get $o) (i32.add (global.get $ctxBase) (i32.const 72)) (i32.const 32)))
  (func $qpi_originator (param $o i32) (call $copyMem (local.get $o) (i32.add (global.get $ctxBase) (i32.const 40)) (i32.const 32)))
  (func $qpi_invocationReward (result i64) (i64.load (i32.add (global.get $ctxBase) (i32.const 104))))`;
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
  lines.push("  (func $dispatch (param $kind i32) (param $it i32) (param $inOff i32) (param $outOff i32) (param $localsOff i32)");
  lines.push("    (global.set $arenaTop (global.get $arenaBase))");

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
