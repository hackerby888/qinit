import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calleesFromRegistry, dynCalleesFromNode, findCalleeRefs, unresolvedCalleeRefs } from "../src/callees";

const PROC = (calls: string) => `using namespace QPI;
struct M : public ContractBase {
  PUBLIC_PROCEDURE(Do) { ${calls} }
};`;

// a dyn-registry DynContract row
const row = (name: string, index: number, source?: string) => ({
  index, name, armed: true, constructed: true, version: 1, codeHash: "x",
  functions: [], procedures: [], source,
});

test("calleesFromRegistry: matches called names, writes their sources, returns {header,index}", () => {
  const dir = mkdtempSync(join(tmpdir(), "qpi-callee-"));
  try {
    const src = PROC("CALL_OTHER_CONTRACT_FUNCTION(QX, in, out); INVOKE_OTHER_CONTRACT_PROCEDURE(Foo, i, o, 0);");
    const reg = [
      row("QX", 1, "struct QX : public ContractBase { /* qx */ };"),
      row("Foo", 5, "struct Foo : public ContractBase { /* foo */ };"),
      row("Unrelated", 9, "struct Unrelated {};"), // not called -> skipped
    ];
    const dyn = calleesFromRegistry(src, reg as any, dir);
    expect(Object.keys(dyn).sort()).toEqual(["Foo", "QX"]);
    expect(dyn.QX.index).toBe(1);
    expect(dyn.Foo.index).toBe(5);
    expect(existsSync(dyn.QX.header)).toBe(true);
    expect(readFileSync(dyn.QX.header, "utf8")).toContain("/* qx */");
    expect(existsSync(join(dir, "Unrelated.h"))).toBe(false); // uncalled contract not materialized
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("calleesFromRegistry: no inter-contract calls -> {} (no files written)", () => {
  const dir = mkdtempSync(join(tmpdir(), "qpi-callee-"));
  try {
    const dyn = calleesFromRegistry(PROC("state.mut().n += 1;"), [row("QX", 1, "x")] as any, dir);
    expect(dyn).toEqual({});
    expect(existsSync(join(dir, "QX.h"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("calleesFromRegistry: a called contract the node has no source for is skipped (no crash)", () => {
  const dir = mkdtempSync(join(tmpdir(), "qpi-callee-"));
  try {
    const src = PROC("CALL_OTHER_CONTRACT_FUNCTION(QX, i, o);");
    expect(calleesFromRegistry(src, [row("QX", 1, undefined)] as any, dir)).toEqual({}); // source missing
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dynCalleesFromNode: no callees -> {} without touching the network", async () => {
  // rpc is a closed port; with no callees the fetch must be skipped entirely -> instant {}
  expect(await dynCalleesFromNode("http://127.0.0.1:9", PROC("state.mut().n += 1;"), join(tmpdir(), "nope"))).toEqual({});
});

test("dynCalleesFromNode: node unreachable -> {} (best-effort, fast-fail, no 30s retry)", async () => {
  const src = PROC("CALL_OTHER_CONTRACT_FUNCTION(QX, i, o);");
  const t0 = Date.now();
  expect(await dynCalleesFromNode("http://127.0.0.1:9", src, join(tmpdir(), "nope"))).toEqual({});
  expect(Date.now() - t0).toBeLessThan(3000);
});

test("findCalleeRefs locates callee-name tokens and ignores commented-out calls", () => {
  const src = `PUBLIC_FUNCTION_WITH_LOCALS(R) {
    CALL_OTHER_CONTRACT_FUNCTION(QX, gi, go);
    // CALL_OTHER_CONTRACT_FUNCTION(Ghost, x, y);
    INVOKE_OTHER_CONTRACT_PROCEDURE(Foo, i, o, 0);
  }`;
  const refs = findCalleeRefs(src);
  expect(refs.map((r) => r.name).sort()).toEqual(["Foo", "QX"]); // Ghost is commented out
  for (const r of refs) expect(src.slice(r.offset, r.offset + r.length)).toBe(r.name); // offsets land on the token
});

test("unresolvedCalleeRefs flags only callees absent from the known set", () => {
  const src = "CALL_OTHER_CONTRACT_FUNCTION(QX, a, b); INVOKE_OTHER_CONTRACT_PROCEDURE(Mystery, c, d, 0);";
  expect(unresolvedCalleeRefs(src, new Set(["QX", "QUOTTERY"])).map((r) => r.name)).toEqual(["Mystery"]);
  expect(unresolvedCalleeRefs(src, new Set(["QX", "Mystery"]))).toEqual([]);
});
