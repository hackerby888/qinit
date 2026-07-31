export function emitMemOps(): string {
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

export function emitAllocators(): string {
    return `  ;; ---- allocators (owned by lhost per dispatch frame) ----
  (func $qpiAllocLocals (param $size i32) (result i32)
    (call $lh_acquireScratch (i64.extend_i32_u (local.get $size)) (i32.const 1)))

  (func $qpiFreeLocals nop)

  (func $acquireScratchpad (param $size i64) (param $initZero i32) (result i32)
    (call $lh_acquireScratch (local.get $size) (local.get $initZero)))

  (func $releaseScratchpad (param $ptr i32)
    (call $lh_releaseScratch (local.get $ptr)))`;
}
