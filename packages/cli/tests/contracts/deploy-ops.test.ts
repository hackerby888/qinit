// Deploy failure classification must name the ACTUAL cause, not mislead. These pin the loud messages so a
// regression (e.g. reporting "slot empty" when the registry was just unreadable) reds CI.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LITE_TX, UploadBegin } from "@qinit/proto";
import { VirtualNode } from "@qinit/engine";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { deployContract, tickFailureMessage, classifyConfirm } from "../../src/deploy-ops";

test("tickFailureMessage: unreachable is distinct from not-ticking", () => {
  expect(tickFailureMessage(true, "http://x")).toBe("node not ticking");
  const m = tickFailureMessage(false, "http://127.0.0.1:41841");
  expect(m).toContain("unreachable");
  expect(m).toContain("http://127.0.0.1:41841");
  expect(m).toContain("qinit node run");
});

test("classifyConfirm: registry-unreadable vs slot-empty vs wrong-code", () => {
  expect(classifyConfirm({ present: false, regOk: false, onNode: "", want: "ab" }).reason).toBe(
    "registry-unreadable",
  );
  expect(classifyConfirm({ present: false, regOk: true, onNode: "", want: "ab" }).reason).toBe(
    "empty",
  );
  const wc = classifyConfirm({
    present: true,
    regOk: true,
    onNode: "deadbeef0000",
    want: "cafebabe0000",
  });
  expect(wc.reason).toBe("wrong-code");
  expect(wc.note).toContain("deadbeef");
  expect(wc.note).toContain("cafebabe");
  // the key fix: a registry that never read back is NOT reported as "slot empty"
  expect(
    classifyConfirm({ present: false, regOk: false, onNode: "", want: "x" }).detail,
  ).not.toContain("slot empty");
});

const envPrev = process.env.QINIT_NO_UPDATE;
const dirs: string[] = [];
afterEach(() => {
  if (envPrev === undefined) delete process.env.QINIT_NO_UPDATE;
  else process.env.QINIT_NO_UPDATE = envPrev;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("deployContract: an unreachable node yields a loud 'unreachable' error (not 'not ticking')", async () => {
  process.env.QINIT_NO_UPDATE = "1"; // skip the verify-tool auto-update network call
  const core = mkdtempSync(join(tmpdir(), "qinit-dep-"));
  dirs.push(core);
  const rpc: any = {
    tickInfo: async () => {
      throw new Error("ECONNREFUSED");
    },
    fundedSeed: async () => undefined,
  };
  const r = await deployContract(
    { contractPath: join(core, "none.h"), name: "X", core, rpcBase: "http://127.0.0.1:1", rpc },
    () => {},
  );
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/unreachable/);
}, 25000);

test("deployContract: an active upload fails before tick waiting, slot resolution, or build", async () => {
  const core = mkdtempSync(join(tmpdir(), "qinit-dep-"));
  dirs.push(core);
  let tickCalls = 0;
  let registryCalls = 0;
  const rpc: any = {
    dynUpload: async () => ({
      active: true,
      sessionId: "77",
      receivedCount: 3,
      chunkCount: 9,
    }),
    tickInfo: async () => {
      tickCalls++;
      return { tick: 1 };
    },
    dynRegistry: async () => {
      registryCalls++;
      return { contracts: [], slotBase: 28, slotCount: 4 };
    },
  };
  const events: any[] = [];

  const r = await deployContract(
    { contractPath: join(core, "missing.h"), name: "Busy", core, rpcBase: "http://unused", rpc },
    (event) => events.push(event),
  );

  const error =
    "another contract upload is active (session 77, 3/9 chunks); wait for it to complete";
  expect(r).toEqual({ ok: false, error });
  expect(tickCalls).toBe(0);
  expect(registryCalls).toBe(0);
  expect(events).toContainEqual({ step: "upload", state: "fail", detail: error });
});

test("deployContract: racing deployments send chunks only for the winner; the loser works after completion", async () => {
  process.env.QINIT_NO_UPDATE = "1";
  const core = mkdtempSync(join(tmpdir(), "qinit-dep-"));
  dirs.push(core);
  const contractPath = join(core, "Race.h");
  await Bun.write(contractPath, "struct Race {};");
  const node = await VirtualNode.create({ mempool: false, fees: "off" });
  let preflights = 0;
  let releasePreflights!: () => void;
  const preflightBarrier = new Promise<void>((resolve) => (releasePreflights = resolve));
  let releaseWinner!: () => void;
  const loserSawWinner = new Promise<void>((resolve) => (releaseWinner = resolve));

  const createRpc = () => {
    let tick = 0;
    const stats = { sessionId: null as bigint | null, chunks: 0 };
    const rpc: any = {
      stats,
      dynUpload: async () => {
        if (stats.sessionId === null && preflights < 2) {
          preflights++;
          if (preflights === 2) releasePreflights();
          await preflightBarrier;
        }
        const state = await node.dynUpload();
        if (state.active && stats.sessionId !== null && state.sessionId !== String(stats.sessionId))
          releaseWinner();
        return state;
      },
      tickInfo: async () => ({ tick: (tick += 10), epoch: 1 }),
      fundedSeed: async () => undefined,
      dynRegistry: () => node.dynRegistry(),
      directDeploy: async () => null,
      putContractSource: (slot: number, source: string) => node.putContractSource(slot, source),
      broadcastTx: async (bytes: Uint8Array) => {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const inputType = view.getUint16(76, true);
        const inputSize = view.getUint16(78, true);
        const payload = bytes.subarray(80, 80 + inputSize);
        if (inputType === LITE_TX.UPLOAD_BEGIN) {
          stats.sessionId = UploadBegin.wrap(payload).sessionId;
        } else if (inputType === LITE_TX.UPLOAD_CHUNK) {
          stats.chunks++;
        } else if (inputType === LITE_TX.DEPLOY) {
          await loserSawWinner;
        }
        return node.broadcastTx(bytes);
      },
    };
    return rpc;
  };

  const artifact = { wasm: await wasm("Counter") };
  const rpcA = createRpc();
  const rpcB = createRpc();
  const opts = (name: string, rpc: any) => ({
    contractPath,
    name,
    core,
    rpcBase: "http://unused",
    seed: "a".repeat(55),
    slotOverride: 28,
    artifact,
    rpc,
  });

  const first = await Promise.all([
    deployContract(opts("RaceA", rpcA), () => {}),
    deployContract(opts("RaceB", rpcB), () => {}),
  ]);
  const winner = first.findIndex((r) => r.ok);
  const loser = 1 - winner;
  expect(winner).toBeGreaterThanOrEqual(0);
  expect(first[loser].error).toMatch(
    /^another contract upload is active \(session \d+, \d+\/\d+ chunks\); wait for it to complete$/,
  );
  const rpcs = [rpcA, rpcB];
  expect(rpcs[winner].stats.chunks).toBeGreaterThan(0);
  expect(rpcs[loser].stats.chunks).toBe(0);

  const retry = await deployContract(opts(loser === 0 ? "RaceA" : "RaceB", rpcs[loser]), () => {});
  expect(retry.ok).toBe(true);
  expect(rpcs[loser].stats.chunks).toBeGreaterThan(0);
}, 20000);
