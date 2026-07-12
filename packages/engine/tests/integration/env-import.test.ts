// A contract can declare `env.*` imports (--allow-undefined) for symbols the wasm build didn't compile in. The
// engine used to stub every such import with `() => 0`; for an i64-return helper (e.g. QPI::smul) that 0 became a
// cryptic "Invalid argument type in ToBigInt operation" trap deep in execution, hiding the real cause. The stub
// now fails loud WHEN CALLED, naming the missing symbol — except the known assert helper, which stays a no-op.
import { test, expect } from "bun:test";
import { envImportStub } from "../../src/runtime";

test("an unprovided env import throws on call, naming the symbol", () => {
  const fn = envImportStub("_ZN3QPIL4smulEyy");
  expect(typeof fn).toBe("function");
  expect(() => (fn as () => unknown)()).toThrow(/missing host import 'env\._ZN3QPIL4smulEyy'/);
});

test("the known assert/diagnostic helper stays a silent no-op (returns 0)", () => {
  const fn = envImportStub("addDebugMessageAssert");
  expect((fn as () => unknown)()).toBe(0);
});

test("a non-string property access never throws (instantiation probing)", () => {
  // Proxy get can receive a symbol/odd key; it must yield a harmless no-op, not a thrower.
  const fn = envImportStub(Symbol.toPrimitive as unknown as string);
  expect((fn as () => unknown)()).toBe(0);
});
