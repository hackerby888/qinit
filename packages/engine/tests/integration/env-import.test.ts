// Unresolved env imports throw when called; the known assert helper remains a no-op.
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
