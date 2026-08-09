import { expect, test } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { QubicSimulator } from "../../src/qubic-simulator";
import { DIFF_WINDOW, diffRegions, TraceRecorder } from "../../src/logging/trace";

function recordOne(
  recorder: TraceRecorder,
  stateBefore: Uint8Array,
  stateAfter: Uint8Array,
  stateSize = stateBefore.length,
) {
  const entry = recorder.begin({
    tick: 0,
    index: 2,
    entry: 0,
    kind: 2,
    invocator: undefined,
    invocationReward: 0n,
    input: new Uint8Array(0),
    stateSize,
    stateBefore,
  });
  recorder.end(entry, {
    output: new Uint8Array(0),
    ok: true,
    stateBefore,
    stateAfter,
    execNs: 1,
  });

  return recorder.trace().entries[recorder.trace().entries.length - 1];
}

// Snapshots cover the whole state now, so truncation means one genuinely came up short — not that the
// contract happens to be large.
test("truncation follows the snapshot length, not the state size", () => {
  const recorder = new TraceRecorder();
  recorder.setEnabled(true);
  const before = new Uint8Array(512);
  const after = before.slice();
  after[511] = 1;

  const short = recordOne(recorder, before, after, 923_559_560);
  expect(short.stateSize).toBe(923_559_560);
  expect(short.stateTruncated).toBe(true);
  expect(short.stateDiff).toEqual([
    {
      off: 256,
      before: "00".repeat(256),
      after: "00".repeat(255) + "01",
    },
  ]);

  expect(recordOne(recorder, before, after).stateTruncated).toBe(false);
});

// The ring used to hold 256 calls, which a node recording from boot burns through in minutes.
test("the ring keeps far more than the old 256 entries", () => {
  const recorder = new TraceRecorder();
  recorder.setEnabled(true);
  const before = new Uint8Array(8);
  const after = before.slice();
  after[0] = 1;

  for (let i = 0; i < 300; i++) {
    recordOne(recorder, before, after);
  }

  const entries = recorder.trace().entries;
  expect(entries.length).toBe(300);
  expect(entries[0].seq).toBe(1); // the first call is still reachable
});

// A two-byte write is not a value; the window around it is what lets the reader decode the element.
test("diffRegions reports aligned windows and merges adjacent ones", () => {
  const before = new Uint8Array(4 * DIFF_WINDOW);
  const after = before.slice();

  after[10] = 1; // window 0
  after[DIFF_WINDOW + 5] = 1; // window 1 — adjacent, merges with window 0
  after[3 * DIFF_WINDOW + 9] = 1; // window 3 — a gap, so its own region

  expect(diffRegions(before, after).map((r) => [r.off, r.before.length / 2])).toEqual([
    [0, 2 * DIFF_WINDOW],
    [3 * DIFF_WINDOW, DIFF_WINDOW],
  ]);

  // The last window is clamped to the image rather than running past it.
  const short = new Uint8Array(DIFF_WINDOW + 8);
  const shortAfter = short.slice();
  shortAfter[DIFF_WINDOW + 2] = 1;
  expect(diffRegions(short, shortAfter)).toEqual([
    {
      off: DIFF_WINDOW,
      before: "00".repeat(8),
      after: "0000" + "01" + "00".repeat(5),
    },
  ]);
});

// A poller passes back the last seq it saw, so `since` has to exclude it.
test("trace(since) yields only newer entries, and 1-based seq keeps the first one", () => {
  const recorder = new TraceRecorder();
  recorder.setEnabled(true);
  const record = () =>
    recorder.end(
      recorder.begin({
        tick: 0,
        index: 2,
        entry: 0,
        kind: 2,
        invocator: undefined,
        invocationReward: 0n,
        input: new Uint8Array(0),
        stateSize: 0,
        stateBefore: new Uint8Array(0),
      }),
      {
        output: new Uint8Array(0),
        ok: true,
        stateBefore: new Uint8Array(0),
        stateAfter: new Uint8Array(0),
        execNs: 1,
      },
    );

  for (let i = 0; i < 3; i++) {
    record();
  }

  expect(recorder.trace().entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  expect(recorder.trace(1).entries.map((entry) => entry.seq)).toEqual([2, 3]);
  expect(recorder.trace(3).entries).toEqual([]);

  // The limit keeps the newest entries, and a non-positive one means the whole ring.
  expect(recorder.trace(0, 2).entries.map((entry) => entry.seq)).toEqual([2, 3]);
  expect(recorder.trace(0, 0).entries).toHaveLength(3);
});

// A write past a fixed prefix used to vanish from the diff; the trace now snapshots the whole state.
test("unmetered runtime tracing snapshots the whole state", async () => {
  const sim = new QubicSimulator({ fees: "off" });
  const contract = sim.deploy(28, await wasm("Counter"));
  const traced = contract as unknown as {
    stateSnapshot: (limit: number) => Uint8Array;
    stateSize: number;
  };
  const snapshot = traced.stateSnapshot.bind(contract);
  const limits: number[] = [];
  traced.stateSnapshot = (limit: number) => {
    limits.push(limit);
    return snapshot(limit);
  };

  sim.setDebug(true);
  sim.procedure(28, 1);

  expect(limits).toEqual([traced.stateSize, traced.stateSize]);
});

// The old 256 KiB prefix snapshot hid every write past it; BigState writes at 0 and at 60 MB.
test("a write far past the old snapshot cap still reaches the diff", async () => {
  const sim = new QubicSimulator({ fees: "off" });
  sim.deploy(28, await wasm("BigState"));
  sim.setDebug(true);
  sim.procedure(28, 1, new Uint8Array([7, 1, 0, 0, 0, 0, 0, 0])); // Set writes both bytes of v

  const entry = sim.getTrace().entries.at(-1)!;
  expect(entry.stateTruncated).toBe(false);
  expect(entry.stateDiff.map((region) => region.off)).toEqual([0, 60_000_000]);
});
