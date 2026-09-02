import type { QpiContextLayout } from "./framework-types";
import { hasLhostImport, type LhostAbiSpec } from "../lhost";

export function emitForwarders(contextLayout: QpiContextLayout, lhostAbi?: LhostAbiSpec): string {
    // `cheat` is the one optional import: headers predating the cheatcodes never declare it, and a
    // forwarder to an undeclared import fails the WAT encode for every contract, cheatcode or not.
    const cheatForwarder = hasLhostImport(lhostAbi, "cheat")
        ? `\n  (func $qpi_cheat (param $op i32) (param $a i64) (param $b i64) (param $ptr i32) (param $len i32) (result i64) (call $lh_cheat (local.get $op) (local.get $a) (local.get $b) (local.get $ptr) (local.get $len)))`
        : "";

    // Thin wrappers from $qpi_* (codegen targets) to the lhost imports.
    return `  ;; ---- qpi forwarders ----
  (func $qpi_transferTyped (param $d i32) (param $a i64) (param $t i32) (result i64) (call $lh_transferTyped (local.get $d) (local.get $a) (local.get $t)))
  (func $qpi_prevSpectrumDigest (param $o i32) (call $lh_prevSpectrumDigest (local.get $o)))
  (func $qpi_prevUniverseDigest (param $o i32) (call $lh_prevUniverseDigest (local.get $o)))
  (func $qpi_prevComputerDigest (param $o i32) (call $lh_prevComputerDigest (local.get $o)))
  (func $qpi_abort (param $c i32) (call $lh_abort (local.get $c)))
  (func $qpi_markDirty (param $c i32) (call $lh_markDirty (local.get $c)))
  (func $qpi_logBytes (param $contractIndex i32) (param $logLevel i32) (param $message i32) (param $byteSize i32) (call $lh_logBytes (local.get $contractIndex) (local.get $logLevel) (local.get $message) (local.get $byteSize)))${cheatForwarder}
  (func $liteCallFunction (param $c i32) (param $it i32) (param $i i32) (param $is i32) (param $o i32) (param $os i32) (result i32) (call $lh_liteCallFunction (local.get $c) (local.get $it) (local.get $i) (local.get $is) (local.get $o) (local.get $os)))
  (func $liteInvokeProcedure (param $c i32) (param $it i32) (param $i i32) (param $is i32) (param $o i32) (param $os i32) (param $r i64) (result i32) (call $lh_liteInvokeProcedure (local.get $c) (local.get $it) (local.get $i) (local.get $is) (local.get $o) (local.get $os) (local.get $r)))
  ;; Internal context index accessor. User-visible context accessors compile from qpi.h.
  (func $qpi_contractIndex (result i32) (i32.load (i32.add (global.get $ctxBase) (i32.const ${contextLayout.contractIndex}))))`;
}
