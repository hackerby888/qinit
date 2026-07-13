import { emitLhostImports, type LhostAbiSpec } from "../../../lhost";
import type { Layout } from "./framework-types";

export function emitImports(gtest = false, lhostAbi?: LhostAbiSpec): string {
    return `  ;; ---- lhost imports ----
${emitLhostImports(lhostAbi)}
${gtest
        ? `  ;; ---- private TS gtest host imports ----
  (import "qtest" "invoke" (func $qt_invoke (param i32 i32 i32 i32 i32 i64 i32) (result i32)))
  (import "qtest" "query" (func $qt_query (param i32 i32 i32 i32 i32 i32) (result i32)))
  (import "qtest" "fund" (func $qt_fund (param i32 i64)))
  (import "qtest" "balance" (func $qt_balance (param i32) (result i64)))
  (import "qtest" "state" (func $qt_state (param i32 i32 i32) (result i32)))
  (import "qtest" "system" (func $qt_system (param i32 i32) (result i32)))
  (import "qtest" "setEpoch" (func $qt_set_epoch (param i32)))
  (import "qtest" "setTick" (func $qt_set_tick (param i32)))
  (import "qtest" "constructionEpoch" (func $qt_construction_epoch (param i32) (result i32)))
  (import "qtest" "fail" (func $qt_fail (param i32 i32)))`
        : ""}`;
}

export function emitGlobals(capacity: Layout): string {
    return `  ;; ---- globals ----
  (global $stateBase i32 (i32.const ${capacity.stateBase}))
  (global $ctxBase i32 (i32.const ${capacity.ctxBase}))
  (global $ioBase i32 (i32.const ${capacity.ioBase}))
  (global $arenaBase i32 (i32.const ${capacity.arenaBase}))
  (global $arenaTop (export "arena_top") (mut i32) (i32.const ${capacity.arenaBase}))
  (global $assetIterBase i32 (i32.const ${capacity.iterBufBase}))
  (global $prngSeed0 (mut i64) (i64.const 0))
  (global $prngSeed1 (mut i64) (i64.const 0))
  (global $prngSeed2 (mut i64) (i64.const 0))
  (global $prngSeed3 (mut i64) (i64.const 0))
  (global $prngCounter (mut i64) (i64.const 0))
  (global $dispatchDepth (mut i32) (i32.const 0))`;
}

export function emitExportList(): string {
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
