import type { Layout, ModuleSpecification } from "./framework-types";
import { emitSysSwitch } from "./dispatch";

export function emitMetadata(capacity: Layout, spec: ModuleSpecification, sysprocMask: number): string {
    const lines: string[] = [];
    lines.push("  ;; ---- metadata exports ----");
    lines.push(`  (func $state_addr (result i32) (i32.const ${capacity.stateBase}))`);
    lines.push(`  (func $state_size (result i32) (i32.const ${capacity.stateSize}))`);
    lines.push(`  (func $io_base (result i32) (i32.const ${capacity.ioBase}))`);
    lines.push(`  (func $io_size (result i32) (i32.const ${capacity.ioSize}))`);
    lines.push(`  (func $ctx_addr (result i32) (i32.const ${capacity.ctxBase}))`);
    lines.push(`  (func $reg_count (result i32) (i32.const ${spec.entries.length}))`);
    // reg_info(index, outPtr) — writes { inputType:u32, kind:u32, inSize:u32, outSize:u32 }
    lines.push(`  (func $reg_info (param $i i32) (param $o i32)`);
    for (let entryIndex = 0; entryIndex < spec.entries.length; entryIndex++) {
        const entry = spec.entries[entryIndex];
        lines.push(`    (if (i32.eq (local.get $i) (i32.const ${entryIndex})) (then`);
        lines.push(`      (i32.store (local.get $o) (i32.const ${entry.inputType}))`);
        lines.push(`      (i32.store (i32.add (local.get $o) (i32.const 4)) (i32.const ${entry.kind}))`);
        lines.push(`      (i32.store (i32.add (local.get $o) (i32.const 8)) (i32.const ${entry.inSize}))`);
        lines.push(`      (i32.store (i32.add (local.get $o) (i32.const 12)) (i32.const ${entry.outSize}))`);
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
