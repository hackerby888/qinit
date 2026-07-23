import { test, expect } from "bun:test";
import {
  arrayFixForLine,
  divModFixForLine,
  moveLocalToWithLocalsEdits,
  type SourceEdit,
} from "../../src/codefix";
import { scanLocals, scanLocalsForm } from "../../src/lint/qpi-rules";

function applyDivMod(line: string, op: "/" | "%"): string | null {
  const fix = divModFixForLine(line, line.indexOf(op), op);
  return fix ? line.slice(0, fix.start) + fix.text + line.slice(fix.end) : null;
}

function applyEdits(src: string, edits: SourceEdit[]): string {
  let out = src;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.newText + out.slice(edit.end);
  }
  return out;
}
function moveFirstLocal(src: string): string | null {
  const f = scanLocals(src)[0];
  if (!f) throw new Error("no stack local found in fixture");
  const edits = moveLocalToWithLocalsEdits(src, f.offset, f.length);
  return edits ? applyEdits(src, edits) : null;
}
const wrap = (body: string, macro = "PUBLIC_PROCEDURE(Inc)", extra = "") => `using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
    struct Inc_input {}; struct Inc_output {};
${extra}    ${macro}
    {
${body}
    }
};`;

test("rewrites a member array declaration to Array<T, N>", () => {
  expect(arrayFixForLine("  uint64 cells[8];")).toBe("  Array<uint64, 8> cells;");
  expect(arrayFixForLine("id owners[CAP];")).toBe("Array<id, CAP> owners;");
});

test("preserves a trailing comment", () => {
  expect(arrayFixForLine("uint64 a[4]; // count")).toBe("Array<uint64, 4> a; // count");
});

test("bails on shapes it can't safely rewrite", () => {
  expect(arrayFixForLine("uint64 a, b[4];")).toBeNull();
  expect(arrayFixForLine("doSomething(arr[i]);")).toBeNull();
  expect(arrayFixForLine("Array<uint64, 8> ok;")).toBeNull();
});

test("rewrites simple division/modulo to div()/mod()", () => {
  expect(applyDivMod("locals.r = a / b;", "/")).toBe("locals.r = div(a, b);");
  expect(applyDivMod("output.x = total % 10;", "%")).toBe("output.x = mod(total, 10);");
  expect(applyDivMod("locals.v = input.amt / 100;", "/")).toBe("locals.v = div(input.amt, 100);");
  expect(applyDivMod("locals.v = locals.x / locals.y;", "/")).toBe(
    "locals.v = div(locals.x, locals.y);",
  );
});

test("div/mod fix preserves precedence — rewrites only the immediate operands", () => {
  expect(applyDivMod("locals.r = a + b / c;", "/")).toBe("locals.r = a + div(b, c);");
  expect(applyDivMod("locals.r = a / b + c;", "/")).toBe("locals.r = div(a, b) + c;");
});

test("div/mod fix declines unsafe shapes (null = no action offered)", () => {
  const at = (l: string, op: "/" | "%") => divModFixForLine(l, l.indexOf(op), op);
  expect(at("a /= b;", "/")).toBeNull();
  expect(at("x = f(y) / 2;", "/")).toBeNull();
  expect(at("x = a / g(z);", "/")).toBeNull();
  expect(at("x = state.get().n / 2;", "/")).toBeNull();
});

test("move-to-_WITH_LOCALS: rewrites the macro, creates the struct, moves the decl + uses", () => {
  const out = moveFirstLocal(
    wrap("        uint64 x;\n        x = input.amount;\n        state.mut().total += x;"),
  )!;
  expect(out).toContain("PUBLIC_PROCEDURE_WITH_LOCALS(Inc)");
  expect(out).not.toContain("PUBLIC_PROCEDURE(Inc)");
  expect(out).toContain("struct Inc_locals { uint64 x; };");
  expect(out).toContain("locals.x = input.amount;");
  expect(out).toContain("state.mut().total += locals.x;");
  expect(scanLocals(out)).toEqual([]);
  expect(scanLocalsForm(out)).toEqual([]);
});

test("move-to-_WITH_LOCALS: keeps an initializer as `locals.<v> = …`", () => {
  const out = moveFirstLocal(
    wrap("        uint64 sum = input.amount;\n        state.mut().total = sum;"),
  )!;
  expect(out).toContain("struct Inc_locals { uint64 sum; };");
  expect(out).toContain("locals.sum = input.amount;");
  expect(out).toContain("state.mut().total = locals.sum;");
  expect(scanLocals(out)).toEqual([]);
});

test("move-to-_WITH_LOCALS: extends an existing <fn>_locals struct; no double _WITH_LOCALS", () => {
  const src = wrap(
    "        uint64 x;\n        x = 1;\n        locals.y = x;",
    "PUBLIC_PROCEDURE_WITH_LOCALS(Inc)",
    "    struct Inc_locals { uint64 y; };\n",
  );
  const out = moveFirstLocal(src)!;
  expect(out).toContain("uint64 x;");
  expect(out).toContain("uint64 y;");
  expect(out).not.toContain("_WITH_LOCALS_WITH_LOCALS");
  expect(out).toContain("locals.x = 1;");
  expect(out).toContain("locals.y = locals.x;");
  expect(scanLocals(out)).toEqual([]);
});

test("move-to-_WITH_LOCALS: declines multi-declarator + for-init", () => {
  const multi = wrap("        uint64 a, b;\n        a = 1;");
  expect(moveLocalToWithLocalsEdits(multi, multi.indexOf("a, b"), 1)).toBeNull();
  const loop = wrap("        for (uint64 i = 0; i < 4; i = i + 1) { state.mut().total += i; }");
  const f = scanLocals(loop)[0];
  expect(f).toBeDefined();
  expect(moveLocalToWithLocalsEdits(loop, f.offset, f.length)).toBeNull();
});
