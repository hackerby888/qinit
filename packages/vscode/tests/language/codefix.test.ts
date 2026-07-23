import { test, expect } from "bun:test";
import {
  analyzeContract,
  type SourceEdit,
  type SourceFix,
} from "@qinit/compile/analyzer";

function fixFor(source: string, code: string): SourceFix | null {
  const diagnostic = analyzeContract({ source }).diagnostics.find(
    (item) => item.origin === "qpi" && item.code === code && item.fixes?.length,
  );
  return diagnostic?.fixes?.[0] ?? null;
}

function applyEdits(source: string, edits: SourceEdit[]): string {
  let output = source;
  for (const edit of [...edits].sort(
    (left, right) => right.span.start - left.span.start,
  )) {
    output =
      output.slice(0, edit.span.start) +
      edit.newText +
      output.slice(edit.span.end);
  }
  return output;
}

function applyFix(source: string, code: string): string | null {
  const fix = fixFor(source, code);
  return fix ? applyEdits(source, fix.edits) : null;
}

function qpiCodes(source: string): string[] {
  return analyzeContract({ source }).diagnostics
    .filter((item) => item.origin === "qpi")
    .map((item) => item.code);
}

const wrap = (
  body: string,
  macro = "PUBLIC_PROCEDURE(Inc)",
  extra = "",
) => `using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
    struct Inc_input {}; struct Inc_output {};
${extra}    ${macro}
    {
${body}
    }
};`;

test("rewrites a member array declaration to Array<T, N>", () => {
  expect(applyFix("  uint64 cells[8];", "qpi/no-brackets")).toBe(
    "  Array<uint64, 8> cells;",
  );
  expect(applyFix("id owners[CAP];", "qpi/no-brackets")).toBe(
    "Array<id, CAP> owners;",
  );
});

test("preserves a trailing comment", () => {
  expect(
    applyFix("uint64 a[4]; // count", "qpi/no-brackets"),
  ).toBe("Array<uint64, 4> a; // count");
});

test("declines unsafe array shapes", () => {
  expect(fixFor("uint64 a, b[4];", "qpi/no-brackets")).toBeNull();
  expect(fixFor("doSomething(arr[i]);", "qpi/no-brackets")).toBeNull();
  expect(fixFor("Array<uint64, 8> ok;", "qpi/no-brackets")).toBeNull();
});

test("rewrites simple division and modulo", () => {
  expect(applyFix("locals.r = a / b;", "qpi/no-division")).toBe(
    "locals.r = div(a, b);",
  );
  expect(applyFix("output.x = total % 10;", "qpi/no-modulo")).toBe(
    "output.x = mod(total, 10);",
  );
  expect(applyFix("locals.v = input.amt / 100;", "qpi/no-division")).toBe(
    "locals.v = div(input.amt, 100);",
  );
  expect(
    applyFix("locals.v = locals.x / locals.y;", "qpi/no-division"),
  ).toBe("locals.v = div(locals.x, locals.y);");
});

test("division fix rewrites only the immediate operands", () => {
  expect(applyFix("locals.r = a + b / c;", "qpi/no-division")).toBe(
    "locals.r = a + div(b, c);",
  );
  expect(applyFix("locals.r = a / b + c;", "qpi/no-division")).toBe(
    "locals.r = div(a, b) + c;",
  );
});

test("division fix declines unsafe shapes", () => {
  expect(fixFor("a /= b;", "qpi/no-division")).toBeNull();
  expect(fixFor("x = f(y) / 2;", "qpi/no-division")).toBeNull();
  expect(fixFor("x = a / g(z);", "qpi/no-division")).toBeNull();
  expect(fixFor("x = state.get().n / 2;", "qpi/no-division")).toBeNull();
});

test("moves a local into a new _WITH_LOCALS struct", () => {
  const source = wrap(
    "        uint64 x;\n        x = input.amount;\n        state.mut().total += x;",
  );
  const output = applyFix(source, "qpi/stack-local")!;

  expect(output).toContain("PUBLIC_PROCEDURE_WITH_LOCALS(Inc)");
  expect(output).not.toContain("PUBLIC_PROCEDURE(Inc)");
  expect(output).toContain("struct Inc_locals { uint64 x; };");
  expect(output).toContain("locals.x = input.amount;");
  expect(output).toContain("state.mut().total += locals.x;");
  expect(qpiCodes(output)).not.toContain("qpi/stack-local");
  expect(qpiCodes(output)).not.toContain("qpi/needs-with-locals");
});

test("keeps a local initializer", () => {
  const source = wrap(
    "        uint64 sum = input.amount;\n        state.mut().total = sum;",
  );
  const output = applyFix(source, "qpi/stack-local")!;

  expect(output).toContain("struct Inc_locals { uint64 sum; };");
  expect(output).toContain("locals.sum = input.amount;");
  expect(output).toContain("state.mut().total = locals.sum;");
  expect(qpiCodes(output)).not.toContain("qpi/stack-local");
});

test("extends an existing locals struct", () => {
  const source = wrap(
    "        uint64 x;\n        x = 1;\n        locals.y = x;",
    "PUBLIC_PROCEDURE_WITH_LOCALS(Inc)",
    "    struct Inc_locals { uint64 y; };\n",
  );
  const output = applyFix(source, "qpi/stack-local")!;

  expect(output).toContain("uint64 x;");
  expect(output).toContain("uint64 y;");
  expect(output).not.toContain("_WITH_LOCALS_WITH_LOCALS");
  expect(output).toContain("locals.x = 1;");
  expect(output).toContain("locals.y = locals.x;");
  expect(qpiCodes(output)).not.toContain("qpi/stack-local");
});

test("declines multi-declarators and for-loop initializers", () => {
  const multi = wrap("        uint64 a, b;\n        a = 1;");
  expect(fixFor(multi, "qpi/stack-local")).toBeNull();

  const loop = wrap(
    "        for (uint64 i = 0; i < 4; i = i + 1) { state.mut().total += i; }",
  );
  expect(qpiCodes(loop)).toContain("qpi/stack-local");
  expect(fixFor(loop, "qpi/stack-local")).toBeNull();
});

test("declines locals whose type cannot become a writable field", () => {
  const source = wrap("        const uint64 value = 1;");
  expect(qpiCodes(source)).toContain("qpi/stack-local");
  expect(fixFor(source, "qpi/stack-local")).toBeNull();
});
