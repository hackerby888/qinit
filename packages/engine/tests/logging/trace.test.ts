import { expect, test } from "bun:test";
import { Sim } from "../../src/sim";
import { TRACE_STATE_CAP, TraceRecorder } from "../../src/trace";

const FIX = import.meta.dir + "/../fixtures";

async function wasm(name: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(`${FIX}/${name}.wasm`).arrayBuffer());
}

test("trace metadata keeps the full state size while snapshots stay capped", () => {
  const recorder = new TraceRecorder();
  recorder.setEnabled(true);
  const stateSize = 923_559_560;
  const before = new Uint8Array(TRACE_STATE_CAP);
  const after = before.slice();
  after[TRACE_STATE_CAP - 1] = 1;

  const entry = recorder.begin({
    tick: 0,
    index: 2,
    entry: 0,
    kind: 2,
    invocator: undefined,
    invocationReward: 0n,
    input: new Uint8Array(0),
    stateSize,
    stateBefore: before,
  });
  recorder.end(entry, {
    output: new Uint8Array(0),
    ok: true,
    stateBefore: before,
    stateAfter: after,
    execNs: 1,
  });

  const trace = recorder.trace().entries[0];
  expect(trace.stateSize).toBe(stateSize);
  expect(trace.stateTruncated).toBe(true);
  expect(trace.stateDiff).toEqual([
    {
      off: TRACE_STATE_CAP - 1,
      before: "00",
      after: "01",
    },
  ]);
});

test("unmetered runtime tracing snapshots only the trace window", async () => {
  const sim = new Sim({ fees: "off" });
  const contract = sim.deploy(28, await wasm("Counter"));
  const traced = contract as unknown as { stateSnapshot: (limit: number) => Uint8Array };
  const snapshot = traced.stateSnapshot.bind(contract);
  const limits: number[] = [];
  traced.stateSnapshot = (limit: number) => {
    limits.push(limit);
    return snapshot(limit);
  };

  sim.setDebug(true);
  sim.procedure(28, 1);

  expect(limits).toEqual([TRACE_STATE_CAP, TRACE_STATE_CAP]);
});
