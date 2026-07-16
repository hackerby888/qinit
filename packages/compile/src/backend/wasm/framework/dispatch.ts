import type { ModuleSpecification, SystemProcedureInfo } from "./framework-types";

export function emitSysSwitch(sysprocs: SystemProcedureInfo[], val: (sp: SystemProcedureInfo) => number): string {
    const lines: string[] = [];
    for (const sp of sysprocs) {
        lines.push(`    (if (i32.eq (local.get $sp) (i32.const ${sp.id})) (then (return (i32.const ${val(sp)}))))`);
    }
    return lines.join("\n");
}

export function emitDispatch(spec: ModuleSpecification, usesPrng: boolean): string {
    const lines: string[] = [];
    lines.push("  ;; ---- dispatch ----");
    lines.push("  (func $dispatch (param $kind i32) (param $it i32) (param $inOff i32) (param $outOff i32) (param $localsOff i32)");
    if (usesPrng) {
        // The wrapper is the PRNG frame boundary. Wasm locals survive a synchronous
        // reentrant host call, so they hold the caller stream while the nested dispatch
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
    }
    else {
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
    }
    else {
        lines.push("    (if (i32.eq (local.get $kind) (i32.const 2)) (then (return)))");
    }
    // kind == 3: MIGRATE — inOff carries the old-state blob, outOff is unused (sdk/dispatch.h)
    if (spec.migrate) {
        lines.push("    (if (i32.eq (local.get $kind) (i32.const 3)) (then");
        lines.push(`      (call ${spec.migrate.label} (global.get $ctxBase) (global.get $stateBase) (local.get $inOff) (local.get $outOff) (local.get $localsOff))`);
        lines.push("      (return)))");
    }
    else {
        lines.push("    (if (i32.eq (local.get $kind) (i32.const 3)) (then (return)))");
    }
    // kind 0/1: user functions/procedures. The incoming it is masked to 16 bits like the native dispatch
    for (const entry of spec.entries) {
        lines.push(`    (if (i32.and (i32.eq (i32.and (local.get $it) (i32.const 0xffff)) (i32.const ${entry.inputType})) (i32.eq (local.get $kind) (i32.const ${entry.kind}))) (then`);
        lines.push(`      (call ${entry.label} (global.get $ctxBase) (global.get $stateBase) (local.get $inOff) (local.get $outOff) (local.get $localsOff))`);
        lines.push(`      (return)))`);
    }
    lines.push("  )");
    return lines.join("\n");
}

export function emitInitialize(): string {
    return `  ;; ---- reactor init ----
  (func $_initialize nop)`;
}
