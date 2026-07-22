import type { Layout, ModuleSpecification } from "./framework-types";

export function emitIntrinsics(capacity: Layout, spec: ModuleSpecification): string {
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
    // Provide compiler intrinsics used by source-backed container helpers.
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
    (call $copyMem (i32.add (local.get $transcript) (i32.const 48)) (i32.add (global.get $ctxBase) (i32.const ${spec.contextLayout.invocator})) (i32.const 32))
    (call $copyMem (i32.add (local.get $transcript) (i32.const 80)) (i32.add (global.get $ctxBase) (i32.const ${spec.contextLayout.originator})) (i32.const 32))
    (i64.store (i32.add (local.get $transcript) (i32.const 112)) (i64.load (i32.add (global.get $ctxBase) (i32.const ${spec.contextLayout.invocationReward}))))
    (i32.store (i32.add (local.get $transcript) (i32.const 120)) (local.get $inputSize))
    (i32.store (i32.add (local.get $transcript) (i32.const 124)) (i32.const ${capacity.stateSize}))
    (call $lh_k12 (global.get $stateBase) (i32.const ${capacity.stateSize}) (i32.add (local.get $transcript) (i32.const 128)))
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
