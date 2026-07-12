// Deploy failure classification must name the ACTUAL cause, not mislead. These pin the loud messages so a
// regression (e.g. reporting "slot empty" when the registry was just unreadable) reds CI.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployContract, tickFailureMessage, classifyConfirm } from "../../src/deploy-ops";

test("tickFailureMessage: unreachable is distinct from not-ticking", () => {
  expect(tickFailureMessage(true, "http://x")).toBe("node not ticking");
  const m = tickFailureMessage(false, "http://127.0.0.1:41841");
  expect(m).toContain("unreachable");
  expect(m).toContain("http://127.0.0.1:41841");
  expect(m).toContain("qinit node run");
});

test("classifyConfirm: registry-unreadable vs slot-empty vs wrong-code", () => {
  expect(classifyConfirm({ present: false, regOk: false, onNode: "", want: "ab" }).reason).toBe("registry-unreadable");
  expect(classifyConfirm({ present: false, regOk: true, onNode: "", want: "ab" }).reason).toBe("empty");
  const wc = classifyConfirm({ present: true, regOk: true, onNode: "deadbeef0000", want: "cafebabe0000" });
  expect(wc.reason).toBe("wrong-code");
  expect(wc.note).toContain("deadbeef");
  expect(wc.note).toContain("cafebabe");
  // the key fix: a registry that never read back is NOT reported as "slot empty"
  expect(classifyConfirm({ present: false, regOk: false, onNode: "", want: "x" }).detail).not.toContain("slot empty");
});

const envPrev = process.env.QINIT_NO_UPDATE;
const dirs: string[] = [];
afterEach(() => {
  if (envPrev === undefined) delete process.env.QINIT_NO_UPDATE; else process.env.QINIT_NO_UPDATE = envPrev;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("deployContract: an unreachable node yields a loud 'unreachable' error (not 'not ticking')", async () => {
  process.env.QINIT_NO_UPDATE = "1";                       // skip the verify-tool auto-update network call
  const core = mkdtempSync(join(tmpdir(), "qinit-dep-")); dirs.push(core);
  const rpc: any = { tickInfo: async () => { throw new Error("ECONNREFUSED"); }, fundedSeed: async () => undefined };
  const r = await deployContract(
    { contractPath: join(core, "none.h"), name: "X", core, rpcBase: "http://127.0.0.1:1", rpc },
    () => {},
  );
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/unreachable/);
}, 25000);
