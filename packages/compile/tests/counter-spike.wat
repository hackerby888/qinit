;; Counter contract — hand-written WAT for the spike.
;; Validates: framework ABI, memory layout, dispatch, registration, engine loading.
;; StateData: { uint64 counter; } — 8 bytes
;; Inc (procedure, it=1): state.counter += 1
;; Get (function, it=1): output.value = state.counter

(module
  ;; ---- Memory ----
  (memory (export "memory") 256 256)

  ;; ---- Constants ----
  ;; state: 0..7 (8 bytes for uint64 counter)
  ;; ctx:   64..319 (256 bytes, 64-byte aligned for simplicity)
  ;; io:    320.. (in 64K | out 64K | locals 32K | arena small)

  ;; ---- lhost imports (minimal set for Counter) ----
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
  (import "lhost" "abort" (func $lh_abort (param i32)))
  (import "lhost" "burn" (func $lh_burn (param i64 i32) (result i64)))
  (import "lhost" "epoch" (func $lh_epoch (result i32)))
  (import "lhost" "tick" (func $lh_tick (result i32)))
  (import "lhost" "now" (func $lh_now (param i32)))
  (import "lhost" "queryFeeReserve" (func $lh_queryFeeReserve (param i32) (result i64)))

  ;; wasi stubs
  (import "wasi_snapshot_preview1" "fd_close" (func $wasi_fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $wasi_fd_write (param i32 i32 i32 i32) (result i32)))

  ;; ---- Exports (metadata) ----
  (func (export "state_addr") (result i32)
    (i32.const 0))

  (func (export "state_size") (result i32)
    (i32.const 8))  ;; sizeof(StateData) = 8 (one uint64)

  (func (export "io_base") (result i32)
    (i32.const 320))  ;; after state (0..7) + ctx (64..319)

  (func (export "io_size") (result i32)
    (i32.const 131072))  ;; 128K

  (func (export "ctx_addr") (result i32)
    (i32.const 64))

  ;; ---- Registration table ----
  ;; 2 entries: [it=1,kind=1,Inc] [it=1,kind=0,Get]
  ;; Stored as function indices (0=Inc, 1=Get)
  (global $entry_count (mut i32) (i32.const 2))
  (global $registered (mut i32) (i32.const 0))

  (func (export "reg_count") (result i32)
    (call $ensure_registered)
    (global.get $entry_count))

  (func $ensure_registered
    (if (i32.eqz (global.get $registered))
      (then
        (global.set $registered (i32.const 1)))))

  ;; reg_info(i, outPtr) — writes entry metadata at outPtr
  ;; Layout: [inputType:u32, kind:u32, inSize:u32, outSize:u32] = 16 bytes
  (func (export "reg_info") (param $i i32) (param $out i32)
    (call $ensure_registered)
    (if (i32.eq (local.get $i) (i32.const 0))
      (then
        ;; Entry 0: Inc — procedure, it=1, in=0, out=0
        (i32.store (local.get $out) (i32.const 1))            ;; inputType
        (i32.store (i32.add (local.get $out) (i32.const 4)) (i32.const 1))  ;; kind=1 (procedure)
        (i32.store (i32.add (local.get $out) (i32.const 8)) (i32.const 0))  ;; inSize
        (i32.store (i32.add (local.get $out) (i32.const 12)) (i32.const 0)) ;; outSize
        return))
    (if (i32.eq (local.get $i) (i32.const 1))
      (then
        ;; Entry 1: Get — function, it=1, in=0, out=8
        (i32.store (local.get $out) (i32.const 1))            ;; inputType
        (i32.store (i32.add (local.get $out) (i32.const 4)) (i32.const 0))  ;; kind=0 (function)
        (i32.store (i32.add (local.get $out) (i32.const 8)) (i32.const 0))  ;; inSize
        (i32.store (i32.add (local.get $out) (i32.const 12)) (i32.const 8)) ;; outSize
        return))
    ;; Out of bounds — zero fill
    (i32.store (local.get $out) (i32.const 0))
    (i32.store (i32.add (local.get $out) (i32.const 4)) (i32.const 0))
    (i32.store (i32.add (local.get $out) (i32.const 8)) (i32.const 0))
    (i32.store (i32.add (local.get $out) (i32.const 12)) (i32.const 0)))

  (func (export "reg_sysproc_mask") (result i32)
    (i32.const 0))  ;; no system procedures

  (func (export "sysproc_locals_size") (param $sp i32) (result i32)
    (i32.const 0))

  (func (export "sysproc_in_size") (param $sp i32) (result i32)
    (i32.const 0))

  (func (export "sysproc_out_size") (param $sp i32) (result i32)
    (i32.const 0))

  (func (export "has_migrate") (result i32)
    (i32.const 0))

  (func (export "migrate_old_state_size") (result i32)
    (i32.const 0))

  (func (export "migrate_locals_size") (result i32)
    (i32.const 0))

  ;; ---- Counter::Inc (procedure, it=1) ----
  ;; Signature: (ctx:i32, state:i32, in:i32, out:i32, locals:i32) -> void
  ;; state.mut().counter += 1
  (func $Inc (param $ctx i32) (param $state i32) (param $in i32) (param $out i32) (param $locals i32)
    ;; Read current counter value
    (local $val i64)
    (local.set $val (i64.load (local.get $state)))
    ;; Increment
    (local.set $val (i64.add (local.get $val) (i64.const 1)))
    ;; Write back
    (i64.store (local.get $state) (local.get $val))
    ;; Mark state dirty (contractIndex from ctx at offset 72)
    (call $lh_markDirty (i32.load (i32.add (local.get $ctx) (i32.const 72)))))

  ;; ---- Counter::Get (function, it=1) ----
  ;; Signature: (ctx:i32, state:i32, in:i32, out:i32, locals:i32) -> void
  ;; output.value = state.get().counter
  (func $Get (param $ctx i32) (param $state i32) (param $in i32) (param $out i32) (param $locals i32)
    ;; Read counter from state, write to output
    (i64.store (local.get $out) (i64.load (local.get $state))))

  ;; ---- Dispatch ----
  ;; dispatch(kind, it, inOff, outOff, localsOff)
  (func (export "dispatch") (param $kind i32) (param $it i32) (param $inOff i32) (param $outOff i32) (param $localsOff i32)
    ;; kind == 2: sysproc — not used
    (if (i32.eq (local.get $kind) (i32.const 2))
      (then
        return))

    ;; kind == 3: migrate — not used
    (if (i32.eq (local.get $kind) (i32.const 3))
      (then
        return))

    ;; Linear scan registration entries
    ;; Entry 0: Inc (kind=1, it=1)
    (if (i32.and
          (i32.eq (local.get $it) (i32.const 1))
          (i32.eq (local.get $kind) (i32.const 1)))
      (then
        (call $Inc
          (global.get $ctx_base)     ;; ctx ptr
          (i32.const 0)               ;; state ptr
          (local.get $inOff)
          (local.get $outOff)
          (local.get $localsOff))
        return))

    ;; Entry 1: Get (kind=0, it=1)
    (if (i32.and
          (i32.eq (local.get $it) (i32.const 1))
          (i32.eq (local.get $kind) (i32.const 0)))
      (then
        (call $Get
          (global.get $ctx_base)     ;; ctx ptr
          (i32.const 0)               ;; state ptr
          (local.get $inOff)
          (local.get $outOff)
          (local.get $localsOff))
        return)))

  ;; _initialize — reactor model
  (func (export "_initialize")
    (call $ensure_registered))

  ;; ctx_base global (ctx header is at offset 64 in linear memory)
  (global $ctx_base i32 (i32.const 64))
)
