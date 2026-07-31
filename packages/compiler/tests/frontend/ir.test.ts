import { WatExpectedType, WatNodeType } from "../../src/enums";
// Locks typed WAT IR formatting and helper output.
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  serializeWatNode as emit,
  assertWatType as assertTy,
  operation as operator,
  functionCall as call,
  functionCallWithSignature as callSig,
  rawWatNode as raw,
  i32Constant as i32c,
  i64Constant as i64c,
  localGet as getL,
  localSet as setL,
  addressWithOffset as addr0,
  rawLoad as loadRaw,
  rawStore as storeRaw,
  loadScalar,
  storeScalar,
  CALL_SIG,
  OP_SIG,
} from "../../src/wat-ir";
import { emitModule } from "../../src/framework";
import { QPI_CONTEXT_LAYOUT } from "../support/qpi-context-layout";

const p = getL("p", WatNodeType.I32);
const v = getL("v", WatNodeType.I64);

describe("emit format parity", () => {
  test("const is verbatim — hex, negative, bigint", () => {
    expect(emit(i64c("0xff"))).toBe("(i64.const 0xff)");
    expect(emit(i64c("0xffffffff"))).toBe("(i64.const 0xffffffff)");
    expect(emit(i32c(-1))).toBe("(i32.const -1)");
    expect(emit(i64c(18446744073709551615n))).toBe("(i64.const 18446744073709551615)");
    expect(emit(i32c(0))).toBe("(i32.const 0)");
  });

  test("local get/set", () => {
    expect(emit(getL("t3", WatNodeType.I64))).toBe("(local.get $t3)");
    expect(emit(setL("t3", i64c(7)))).toBe("(local.set $t3 (i64.const 7))");
  });

  test("load offset: null omits, 0 prints, 8 prints", () => {
    expect(emit(loadRaw("i64.load", null, p))).toBe("(i64.load (local.get $p))");
    expect(emit(loadRaw("i64.load", 0, p))).toBe("(i64.load offset=0 (local.get $p))");
    expect(emit(loadRaw("i64.load", 8, p))).toBe("(i64.load offset=8 (local.get $p))");
  });

  test("store offset: null omits, 8 prints", () => {
    expect(emit(storeRaw("i64.store", null, p, v))).toBe(
      "(i64.store (local.get $p) (local.get $v))",
    );
    expect(emit(storeRaw("i64.store", 8, p, v))).toBe(
      "(i64.store offset=8 (local.get $p) (local.get $v))",
    );
  });

  test("generic op", () => {
    expect(emit(operator("i64.add", v, i64c(1)))).toBe("(i64.add (local.get $v) (i64.const 1))");
    expect(emit(operator("i64.eqz", v))).toBe("(i64.eqz (local.get $v))");
    expect(emit(operator("i64.ne", i64c(0), v))).toBe("(i64.ne (i64.const 0) (local.get $v))");
  });

  test("call: zero-arg has no trailing space", () => {
    expect(emit(call("$self_id"))).toBe("(call $self_id)");
    expect(emit(call("$copyMem", p, getL("q", WatNodeType.I32), i32c(16)))).toBe(
      "(call $copyMem (local.get $p) (local.get $q) (i32.const 16))",
    );
  });

  test("raw is verbatim", () => {
    expect(
      emit(
        raw(
          "(i64.extend_i32_u (if (result i32) X (then (i32.const 1)) (else Y)))",
          WatNodeType.I64,
          "short-circuit",
        ),
      ),
    ).toBe("(i64.extend_i32_u (if (result i32) X (then (i32.const 1)) (else Y)))");
  });
});

describe("leaf-helper shapes (loadAt/storeAt/addrOf parity)", () => {
  test("loadScalar mirrors loadAt for every width and signedness", () => {
    expect(emit(loadScalar(p, 8))).toBe("(i64.load (local.get $p))");
    expect(emit(loadScalar(p, 4))).toBe("(i64.extend_i32_u (i32.load (local.get $p)))");
    expect(emit(loadScalar(p, 4, true))).toBe("(i64.extend_i32_s (i32.load (local.get $p)))");
    expect(emit(loadScalar(p, 2))).toBe("(i64.extend_i32_u (i32.load16_u (local.get $p)))");
    expect(emit(loadScalar(p, 2, true))).toBe("(i64.extend_i32_s (i32.load16_s (local.get $p)))");
    expect(emit(loadScalar(p, 1))).toBe("(i64.extend_i32_u (i32.load8_u (local.get $p)))");
    expect(emit(loadScalar(p, 1, true))).toBe("(i64.extend_i32_s (i32.load8_s (local.get $p)))");
    expect(emit(loadScalar(p, 16))).toBe("(i64.load (local.get $p))");
  });

  test("storeScalar mirrors storeAt for every width", () => {
    expect(emit(storeScalar(p, 8, v))).toBe("(i64.store (local.get $p) (local.get $v))");
    expect(emit(storeScalar(p, 4, v))).toBe(
      "(i32.store (local.get $p) (i32.wrap_i64 (local.get $v)))",
    );
    expect(emit(storeScalar(p, 2, v))).toBe(
      "(i32.store16 (local.get $p) (i32.wrap_i64 (local.get $v)))",
    );
    expect(emit(storeScalar(p, 1, v))).toBe(
      "(i32.store8 (local.get $p) (i32.wrap_i64 (local.get $v)))",
    );
    expect(emit(storeScalar(p, 16, v))).toBe("(i64.store (local.get $p) (local.get $v))");
  });

  test("addr0 mirrors addrOf: offset 0 is the base node itself", () => {
    expect(addr0(p, 0)).toBe(p);
    expect(emit(addr0(p, 24))).toBe("(i32.add (local.get $p) (i32.const 24))");
  });

  test("narrowCast shapes", () => {
    expect(emit(operator("i64.and", v, i64c("0xff")))).toBe("(i64.and (local.get $v) (i64.const 0xff))");
    expect(emit(operator("i64.extend16_s", v))).toBe("(i64.extend16_s (local.get $v))");
    expect(emit(operator("i64.extend_i32_u", operator("i64.ne", i64c(0), v)))).toBe(
      "(i64.extend_i32_u (i64.ne (i64.const 0) (local.get $v)))",
    );
  });

  test("compiler target primitive call shapes", () => {
    expect(emit(call("$intr_mulhi_u", v, i64c(3)))).toBe(
      "(call $intr_mulhi_u (local.get $v) (i64.const 3))",
    );
    expect(emit(call("$intr_mulhi_s", v, i64c(-3)))).toBe(
      "(call $intr_mulhi_s (local.get $v) (i64.const -3))",
    );
  });
});

describe("type assertions catch the silent-divergence class", () => {
  test("wrong operand width throws with the offending WAT", () => {
    expect(() => operator("i64.add", v, i32c(1))).toThrow(/expected i64, got i32.*\(i32\.const 1\)/);
    expect(() => operator("i32.add", p, v)).toThrow(/expected i32, got i64/);
  });

  test("wrong arity throws", () => {
    expect(() => operator("i64.add", v)).toThrow(/expects 2 operand/);
    expect(() => operator("i64.eqz", v, v)).toThrow(/expects 1 operand/);
  });

  test("unknown opcode / call target throws", () => {
    expect(() => operator("i64.bogus", v)).toThrow(/unknown opcode/);
    expect(() => call("$no_such_helper")).toThrow(/unknown call target/);
  });

  test("void call in value position throws", () => {
    const c = call("$copyMem", p, p, i32c(8));
    expect(() => assertTy(c, WatExpectedType.VALUE, "assignment RHS")).toThrow(/expected val, got void/);
    expect(() => setL("t", c)).toThrow(/expected val, got void/);
  });

  test("call arg width checked against the registry", () => {
    expect(() => call("$intr_mulhi_u", v, p)).toThrow(
      /call \$intr_mulhi_u arg 1.*expected i64, got i32/,
    );
    expect(() => call("$copyMem", p, p)).toThrow(/expects 3 arg/);
  });

  test("callSig covers dynamic targets", () => {
    const helper = callSig({ params: [WatNodeType.I32, WatNodeType.I64], res: WatNodeType.I64 }, "$lib0_probe", p, v);
    expect(emit(helper)).toBe("(call $lib0_probe (local.get $p) (local.get $v))");
    expect(() => callSig({ params: [WatNodeType.I32], res: WatNodeType.VOID }, "$fn_x", v)).toThrow(
      /expected i32, got i64/,
    );
  });

  test("address positions must be i32", () => {
    expect(() => loadRaw("i64.load", null, v)).toThrow(/address.*expected i32, got i64/);
    expect(() => storeScalar(v, 8, v)).toThrow(/address.*expected i32, got i64/);
    expect(() => addr0(v, 4)).toThrow(/expected i32, got i64/);
  });

  test("store value width checked", () => {
    expect(() => storeRaw("i64.store", null, p, p)).toThrow(/value.*expected i64, got i32/);
    expect(() => storeScalar(p, 8, p)).toThrow(/expected i64, got i32/);
  });

  test("drop accepts either value type, rejects void", () => {
    expect(emit(operator("drop", v))).toBe("(drop (local.get $v))");
    expect(emit(operator("drop", p))).toBe("(drop (local.get $p))");
    expect(() => operator("drop", call("$copyMem", p, p, i32c(1)))).toThrow(/expected val, got void/);
  });

  test("raw's declared type is trusted", () => {
    const r = raw("(call $mystery)", WatNodeType.I64);
    expect(assertTy(r, WatNodeType.I64)).toBe(r);
    expect(emit(operator("i64.add", r, v))).toBe("(i64.add (call $mystery) (local.get $v))");
  });
});

describe("escape-hatch ratchet", () => {
  // ir.raw bridges untyped forms; this ratchet keeps its use bounded.
  test("raw() count in codegen/ does not grow", () => {
    const dir = join(import.meta.dir, "../../src/codegen");
    let count = 0;
    for (const f of readdirSync(dir, { recursive: true }) as string[]) {
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(join(dir, f), "utf8");
      count += (src.match(/ir\.raw\(/g) ?? []).length;
    }
    // Source-instantiated uint128/free-function calls carry signatures discovered at
    // codegen time, so they currently cross the dynamic-call bridge intentionally.
    expect(count).toBeLessThanOrEqual(35);
  });
});

describe("CALL_SIG agrees with framework.ts", () => {
  test("handwritten QPI algorithm kernels cannot return", () => {
    const roots = [
      join(import.meta.dir, "../../src/framework.ts"),
      join(import.meta.dir, "../../src/wat-ir.ts"),
      join(import.meta.dir, "../../src/codegen"),
    ];
    const files: string[] = [];
    for (const root of roots) {
      if (root.endsWith(".ts")) files.push(root);
      else
        for (const file of readdirSync(root, { recursive: true }) as string[]) {
          if (file.endsWith(".ts")) files.push(join(root, file));
        }
    }
    const forbidden = /\$(?:hm|coll|m|u128)_[a-zA-Z0-9_]+/g;
    const hits = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(forbidden)].map((match) => `${file}:${match[0]}`),
    );
    expect(hits).toEqual([]);
  });

  test("every registry entry matches the framework definition", () => {
    const framework = emitModule({
      contractSlot: 29,
      stateSize: 0,
      arenaSize: 64 * 1024,
      contextLayout: QPI_CONTEXT_LAYOUT,
      entries: [],
      sysprocs: [],
      userFunctionsWat: ";; no user functions",
      gtest: true,
    });
    const defined = new Map<string, { params: string[]; res: string }>();
    const re =
      /\(func (\$[a-zA-Z0-9_]+)((?:\s*\(param(?:\s+\$[a-zA-Z0-9_.]+)?(?:\s+(?:i32|i64))+\))*)\s*(?:\(result (i32|i64)\))?/g;
    for (const m of framework.matchAll(re)) {
      const params: string[] = [];
      for (const pm of m[2].matchAll(/\(param(?:\s+\$[a-zA-Z0-9_.]+)?((?:\s+(?:i32|i64))+)\)/g)) {
        params.push(...(pm[1].match(/i32|i64/g) ?? []));
      }
      defined.set(m[1], { params, res: m[3] ?? "void" });
    }

    const missing: string[] = [];
    const wrong: string[] = [];
    for (const [target, s] of Object.entries(CALL_SIG)) {
      const d = defined.get(target);
      if (!d) {
        missing.push(target);
        continue;
      }
      const want = `${s.params.join(",")}->${s.res}`;
      const got = `${d.params.join(",")}->${d.res}`;
      if (want !== got) {
        wrong.push(`${target}: registry ${want} vs framework ${got}`);
      }
    }
    expect(missing).toEqual([]);
    expect(wrong).toEqual([]);
  });

  test("registry covers the helpers codegen emits calls to", () => {
    for (const t of [
      "$copyMem",
      "$setMem",
      "$qpiAllocLocals",
      "$intr_mulhi_u",
      "$intr_mulhi_s",
      "$memeq",
      "$self_id",
    ]) {
      expect(CALL_SIG[t]).toBeDefined();
    }
    expect(OP_SIG["i64.extend_i32_u"]).toBeDefined();
    expect(OP_SIG["i32.wrap_i64"]).toBeDefined();
  });
});
