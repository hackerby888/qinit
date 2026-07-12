// Headless completion probe: drives clangd over stdio LSP against the generated compile DB to prove
// the completion behavior the user cares about — the PUBLIC QPI surface completes (state./Array./qpi.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCore, wasiSdkPaths } from "@qinit/core/project";
import { generateClangdConfig } from "../src/clangd-config";

const CLANGD = process.env.CLANGD ?? "clangd";
const core = resolveCore(process.env.QINIT_CORE);
const sdk = wasiSdkPaths();
const wasiClang = process.env.WASM_CLANG ?? sdk?.clang;
const wasiSysroot = process.env.WASI_SYSROOT ?? sdk?.sysroot;
if (!wasiClang) { console.error("no wasi-sdk — run `qinit node run` (or set WASM_CLANG/WASI_SYSROOT)"); process.exit(2); }

const ws = mkdtempSync(join(tmpdir(), "qpi-complete-"));
const PROBE = `#include "contracts/qpi.h"
using namespace QPI;
struct Probe2 {};
struct Probe : public ContractBase {
  struct StateData { uint64 counter; Array<uint64, 8> nums; };
  struct Go_input {}; struct Go_output {};
  struct Go_locals { uint64 x; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Go) {
    state.mut().counter = 0;
    locals.x = state.get().nums.get(0);
    qpi.invocator();
    locals.x = 0;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};
`;
const file = join(ws, "Probe.h");
writeFileSync(file, PROBE);
const cfg = generateClangdConfig({ contractPath: file, corePath: core, wasiClang, wasiSysroot, workspaceRoot: ws, name: "Probe" });
const uri = pathToFileURL(cfg.contractFile).href;

const posAt = (off: number) => {
  const pre = PROBE.slice(0, off);
  const line = pre.split("\n").length - 1;
  return { line, character: off - (pre.lastIndexOf("\n") + 1) };
};
// position right after the dot of `<find>` (member completion), e.g. find="qpi.invocator", dot="qpi."
const afterDot = (find: string, dot: string) => posAt(PROBE.indexOf(find) + dot.length);

const proc = Bun.spawn(
  [CLANGD, `--compile-commands-dir=${cfg.dir}`, `--query-driver=${wasiClang}`, "--background-index=false", "--log=error"],
  { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
);

let seq = 0;
const pending = new Map<number, (v: any) => void>();
function send(method: string, params: any, isNotification = false) {
  const msg: any = { jsonrpc: "2.0", method, params };
  let p: Promise<any> | undefined;
  if (!isNotification) { const id = ++seq; msg.id = id; p = new Promise((res) => pending.set(id, res)); }
  const body = JSON.stringify(msg);
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  proc.stdin.flush();
  return p;
}

// frame reader
(async () => {
  let buf = Buffer.alloc(0);
  for await (const chunk of proc.stdout as any) {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) break;
      const header = buf.subarray(0, sep).toString();
      const m = header.match(/Content-Length: (\d+)/i);
      if (!m) { buf = buf.subarray(sep + 4); continue; }
      const len = Number(m[1]);
      if (buf.length < sep + 4 + len) break;
      const body = buf.subarray(sep + 4, sep + 4 + len).toString();
      buf = buf.subarray(sep + 4 + len);
      try { const msg = JSON.parse(body); if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)!(msg.result); pending.delete(msg.id); } } catch {}
    }
  }
})();

const labelsAt = async (pos: { line: number; character: number }): Promise<string[]> => {
  const r = await send("textDocument/completion", { textDocument: { uri }, position: pos });
  const items = Array.isArray(r) ? r : (r?.items ?? []);
  return items.map((i: any) => i.label.trim());
};

const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); return cond; };
let failures = 0;
try {
  await send("initialize", { processId: process.pid, rootUri: pathToFileURL(ws).href, capabilities: { textDocument: { completion: { completionItem: { snippetSupport: false } } } } });
  send("initialized", {}, true);
  send("textDocument/didOpen", { textDocument: { uri, languageId: "cpp", version: 1, text: PROBE } }, true);
  await new Promise((r) => setTimeout(r, 4000)); // let clangd build the preamble

  const stateMembers = await labelsAt(afterDot("state.mut().counter", "state.mut()."));
  const arrMembers = await labelsAt(afterDot("nums.get(0)", "nums."));
  const qpiMembers = await labelsAt(afterDot("qpi.invocator", "qpi."));
  const valScope = await labelsAt(posAt(PROBE.lastIndexOf("locals.x = ") + "locals.x = ".length)); // value/statement scope

  const starts = (arr: string[], p: string) => arr.some((l) => l.startsWith(p));
  console.log(`state.mut(). -> ${stateMembers.length} items: ${stateMembers.slice(0, 8).join(", ")}`);
  console.log(`Array .      -> ${arrMembers.length} items: ${arrMembers.slice(0, 8).join(", ")}`);
  console.log(`qpi.         -> ${qpiMembers.length} items; __reserved=${qpiMembers.filter((l) => l.startsWith("__")).length}; public e.g. ${qpiMembers.filter((l) => !l.startsWith("__")).slice(0, 8).join(", ")}`);
  console.log(`value scope  -> ${valScope.length} items; std:: labels=${valScope.filter((l) => l.startsWith("std::")).length}; e.g. ${valScope.slice(0, 10).join(", ")}\n`);

  // POSITIVE — the public API must complete (the user's hard requirement)
  if (!ok(stateMembers.includes("counter") && stateMembers.includes("nums"), "state.mut(). completes StateData members (counter, nums)")) failures++;
  if (!ok(starts(arrMembers, "get") && starts(arrMembers, "capacity"), "Array member access completes (get, capacity)")) failures++;
  if (!ok(qpiMembers.some((l) => /^(invocator|invocationReward|numberOfTickTransactions|transfer|burn)\b/.test(l)), "qpi. completes public API members")) failures++;
  // NEGATIVE — Completion.AllScopes:No removes the cross-namespace std:: flood
  if (!ok(!valScope.some((l) => l.startsWith("std::")), "value scope has no cross-scope std:: flood")) failures++;
} finally {
  proc.kill();
  rmSync(ws, { recursive: true, force: true });
}
console.log(`\n${failures === 0 ? "COMPLETION PROBE: PASS — public QPI surface completes" : `COMPLETION PROBE: FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
