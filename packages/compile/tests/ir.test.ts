// Format lock for the typed WAT IR: every emit() branch and every leaf-helper shape must print the
// exact single-space canonical S-expression the string-based codegen produced. Golden strings here
// are copied from real codegen output shapes — if one of these changes, the WAT byte-equality
// oracle breaks.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  emit, assertTy, op, call, callSig, raw,
  i32c, i64c, getL, setL,
  addr0, loadRaw, storeRaw, loadScalar, storeScalar,
  CALL_SIG, OP_SIG,
} from "../src/ir";

const p = getL("p", "i32");
const v = getL("v", "i64");

describe("emit format parity", () => {
  test("const is verbatim — hex, negative, bigint", () => {
    expect(emit(i64c("0xff"))).toBe("(i64.const 0xff)");
    expect(emit(i64c("0xffffffff"))).toBe("(i64.const 0xffffffff)");
    expect(emit(i32c(-1))).toBe("(i32.const -1)");
    expect(emit(i64c(18446744073709551615n))).toBe("(i64.const 18446744073709551615)");
    expect(emit(i32c(0))).toBe("(i32.const 0)");
  });

  test("local get/set", () => {
    expect(emit(getL("t3", "i64"))).toBe("(local.get $t3)");
    expect(emit(setL("t3", i64c(7)))).toBe("(local.set $t3 (i64.const 7))");
  });

  test("load offset: null omits, 0 prints, 8 prints", () => {
    expect(emit(loadRaw("i64.load", null, p))).toBe("(i64.load (local.get $p))");
    expect(emit(loadRaw("i64.load", 0, p))).toBe("(i64.load offset=0 (local.get $p))");
    expect(emit(loadRaw("i64.load", 8, p))).toBe("(i64.load offset=8 (local.get $p))");
  });

  test("store offset: null omits, 8 prints", () => {
    expect(emit(storeRaw("i64.store", null, p, v))).toBe("(i64.store (local.get $p) (local.get $v))");
    expect(emit(storeRaw("i64.store", 8, p, v))).toBe("(i64.store offset=8 (local.get $p) (local.get $v))");
  });

  test("generic op", () => {
    expect(emit(op("i64.add", v, i64c(1)))).toBe("(i64.add (local.get $v) (i64.const 1))");
    expect(emit(op("i64.eqz", v))).toBe("(i64.eqz (local.get $v))");
    expect(emit(op("i64.ne", i64c(0), v))).toBe("(i64.ne (i64.const 0) (local.get $v))");
  });

  test("call: zero-arg has no trailing space", () => {
    expect(emit(call("$self_id"))).toBe("(call $self_id)");
    expect(emit(call("$copyMem", p, getL("q", "i32"), i32c(16))))
      .toBe("(call $copyMem (local.get $p) (local.get $q) (i32.const 16))");
  });

  test("raw is verbatim", () => {
    expect(emit(raw("(i64.extend_i32_u (if (result i32) X (then (i32.const 1)) (else Y)))", "i64", "short-circuit"))
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
    expect(emit(storeScalar(p, 4, v))).toBe("(i32.store (local.get $p) (i32.wrap_i64 (local.get $v)))");
    expect(emit(storeScalar(p, 2, v))).toBe("(i32.store16 (local.get $p) (i32.wrap_i64 (local.get $v)))");
    expect(emit(storeScalar(p, 1, v))).toBe("(i32.store8 (local.get $p) (i32.wrap_i64 (local.get $v)))");
    expect(emit(storeScalar(p, 16, v))).toBe("(i64.store (local.get $p) (local.get $v))");
  });

  test("addr0 mirrors addrOf: offset 0 is the base node itself", () => {
    expect(addr0(p, 0)).toBe(p);
    expect(emit(addr0(p, 24))).toBe("(i32.add (local.get $p) (i32.const 24))");
  });

  test("narrowCast shapes", () => {
    expect(emit(op("i64.and", v, i64c("0xff")))).toBe("(i64.and (local.get $v) (i64.const 0xff))");
    expect(emit(op("i64.extend16_s", v))).toBe("(i64.extend16_s (local.get $v))");
    expect(emit(op("i64.extend_i32_u", op("i64.ne", i64c(0), v))))
      .toBe("(i64.extend_i32_u (i64.ne (i64.const 0) (local.get $v)))");
  });

  test("math-call shapes", () => {
    expect(emit(call("$m_div_s", v, i64c(3)))).toBe("(call $m_div_s (local.get $v) (i64.const 3))");
    expect(emit(call("$m_abs", v))).toBe("(call $m_abs (local.get $v))");
  });
});

describe("type assertions catch the silent-divergence class", () => {
  test("wrong operand width throws with the offending WAT", () => {
    expect(() => op("i64.add", v, i32c(1))).toThrow(/expected i64, got i32.*\(i32\.const 1\)/);
    expect(() => op("i32.add", p, v)).toThrow(/expected i32, got i64/);
  });

  test("wrong arity throws", () => {
    expect(() => op("i64.add", v)).toThrow(/expects 2 operand/);
    expect(() => op("i64.eqz", v, v)).toThrow(/expects 1 operand/);
  });

  test("unknown opcode / call target throws", () => {
    expect(() => op("i64.bogus", v)).toThrow(/unknown opcode/);
    expect(() => call("$no_such_helper")).toThrow(/unknown call target/);
  });

  test("void call in value position throws", () => {
    const c = call("$copyMem", p, p, i32c(8));
    expect(() => assertTy(c, "val", "assignment RHS")).toThrow(/expected val, got void/);
    expect(() => setL("t", c)).toThrow(/expected val, got void/);
  });

  test("call arg width checked against the registry", () => {
    expect(() => call("$u128_set", p, v, p)).toThrow(/call \$u128_set arg 2.*expected i64, got i32/);
    expect(() => call("$copyMem", p, p)).toThrow(/expects 3 arg/);
  });

  test("callSig covers dynamic targets", () => {
    const helper = callSig({ params: ["i32", "i64"], res: "i64" }, "$lib0_probe", p, v);
    expect(emit(helper)).toBe("(call $lib0_probe (local.get $p) (local.get $v))");
    expect(() => callSig({ params: ["i32"], res: "void" }, "$fn_x", v)).toThrow(/expected i32, got i64/);
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
    expect(emit(op("drop", v))).toBe("(drop (local.get $v))");
    expect(emit(op("drop", p))).toBe("(drop (local.get $p))");
    expect(() => op("drop", call("$copyMem", p, p, i32c(1)))).toThrow(/expected val, got void/);
  });

  test("raw's declared type is trusted", () => {
    const r = raw("(call $mystery)", "i64");
    expect(assertTy(r, "i64")).toBe(r);
    expect(emit(op("i64.add", r, v))).toBe("(i64.add (call $mystery) (local.get $v))");
  });
});

describe("escape-hatch ratchet", () => {
  // ir.raw is the sanctioned bridge for not-yet-typed subtrees (lvalue address strings, dynamic-label
  // calls, control-flow forms). The count must only go DOWN as conversion proceeds — lower the ceiling
  // when you remove hatches; never raise it without a structural reason recorded here.
  test("raw() count in codegen.ts does not grow", () => {
    const codegen = readFileSync(join(import.meta.dir, "../src/codegen.ts"), "utf8");
    const count = (codegen.match(/ir\.raw\(/g) ?? []).length;
    expect(count).toBeLessThanOrEqual(32);
  });
});

describe("CALL_SIG agrees with framework.ts", () => {
  test("every registry entry matches the framework definition", () => {
    const framework = readFileSync(join(import.meta.dir, "../src/framework.ts"), "utf8");
    const defined = new Map<string, { params: string[]; res: string }>();
    const re = /\(func (\$[a-zA-Z0-9_]+)((?:\s*\(param(?:\s+\$[a-zA-Z0-9_.]+)?(?:\s+(?:i32|i64))+\))*)\s*(?:\(result (i32|i64)\))?/g;
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
    for (const t of ["$copyMem", "$setMem", "$qpiAllocLocals", "$u128_set", "$hm_elem", "$m_div_u", "$memeq", "$self_id"]) {
      expect(CALL_SIG[t]).toBeDefined();
    }
    expect(OP_SIG["i64.extend_i32_u"]).toBeDefined();
    expect(OP_SIG["i32.wrap_i64"]).toBeDefined();
  });
});
