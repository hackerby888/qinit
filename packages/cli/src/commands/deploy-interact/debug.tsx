import { useEffect, useState, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_RPC_BASE,
  LiteRpc,
  resolveTrapBacktrace,
  formatTrapBacktrace,
  type DebugEntry,
  type DynamicContractRegistryEntry,
} from "@qinit/core";
import { describeTrace, type DecodedTrace } from "../../trace/format";
import { TraceView, shownStateLines } from "../../trace/views";
import { activeNodeScratchDir } from "../../ops/node";
import { loadConfig, loadConfiguredQpiHeader } from "../../config";
import { contractIdlForSlot, loadContractIdlFile } from "../../contracts/idl-file";
import {
  Header,
  Table,
  Spinner,
  theme,
  termRows,
  useFrame,
  type Column,
} from "../../ui";
import type { CommandArguments } from "../../args";

const TRACE_LIST_LIMIT = 500;
const TRACE_POLL_MS = 1200;
const TICK_TIME_ATTEMPTS = 2;
const kindName = (k: number) => (k === 0 ? "fn" : k === 1 ? "proc" : "sys");
const LIST_COLS: Column[] = [
  { header: "time", max: 10, dim: true },
  { header: "tick", align: "right", max: 10 },
  { header: "contract", max: 14 },
  { header: "entry", max: 9 },
  { header: "", max: 1 },
  { header: "exec", align: "right", max: 8, dim: true },
];

type TickClock = { tick: number; chainMs: number; resolvedAt: number };

function latestTickClock(tickTimes: Iterable<TickClock>): TickClock | undefined {
  let latest: TickClock | undefined;
  for (const tickTime of tickTimes) {
    if (
      !latest ||
      tickTime.chainMs > latest.chainMs ||
      (tickTime.chainMs === latest.chainMs && tickTime.tick > latest.tick)
    ) {
      latest = tickTime;
    }
  }
  return latest;
}

export function mergeTraceEntries<T extends { seq: number }>(
  previous: readonly T[],
  incoming: readonly T[],
  hidden: ReadonlySet<number>,
): T[] {
  const bySequence = new Map(
    previous.filter((entry) => !hidden.has(entry.seq)).map((entry) => [entry.seq, entry]),
  );
  for (const entry of incoming) {
    if (!hidden.has(entry.seq)) {
      bySequence.set(entry.seq, entry);
    }
  }
  return [...bySequence.values()]
    .sort((left, right) => right.seq - left.seq)
    .slice(0, TRACE_LIST_LIMIT);
}

export function traceSelectionIndex<T extends { seq: number }>(
  entries: readonly T[],
  selectedSeq: number | null,
): number {
  if (!entries.length) {
    return 0;
  }
  if (selectedSeq == null) {
    return 0;
  }
  const index = entries.findIndex((entry) => entry.seq === selectedSeq);
  return index < 0 ? entries.length - 1 : index;
}

export function formatTraceAge(tickMs?: number, chainNowMs?: number): string {
  if (tickMs == null || chainNowMs == null) {
    return "—";
  }

  const seconds = Math.max(0, Math.floor((chainNowMs - tickMs) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds} sec ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function Debug({ commandArgs }: { commandArgs: CommandArguments }) {
  const target = commandArgs.get("contract") ?? commandArgs.positionals[0];
  const rpcBaseUrl = commandArgs.get("rpc") || loadConfig().rpc || DEFAULT_RPC_BASE;
  const { exit } = useApp();
  const rpc = useRef(new LiteRpc(rpcBaseUrl)).current;
  const [qpiHeader] = useState(() => {
    try {
      return loadConfiguredQpiHeader();
    } catch {
      return undefined;
    }
  });
  const [entries, setEntries] = useState<DebugEntry[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [err, setErr] = useState("");
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [tickTimes, setTickTimes] = useState<Map<number, TickClock>>(() => new Map());
  const [tickTimeRetry, setTickTimeRetry] = useState(0);
  const [fullState, setFullState] = useState(false);
  const selectedSeqRef = useRef<number | null>(null);
  const visibleEntriesRef = useRef<DebugEntry[]>([]);
  const hiddenSeqs = useRef(new Set<number>());
  const tickTimeAttempts = useRef(new Map<number, number>());
  const mounted = useRef(true);
  const since = useRef(0);
  const reg = useRef<DynamicContractRegistryEntry[]>([]);
  const nameOf = (idx: number) => reg.current.find((c) => c.index === idx)?.name || String(idx);
  useFrame(1000);

  const select = (seq: number | null) => {
    selectedSeqRef.current = seq;
    setSelectedSeq(seq);
  };

  useEffect(() => {
    mounted.current = true;
    let alive = true;
    rpc
      .setDebug(true)
      .then((r) => alive && setEnabled(r.enabled))
      .catch((e) => setErr(String(e?.message ?? e)));
    const poll = setInterval(async () => {
      try {
        reg.current = (await rpc.dynRegistry()).contracts ?? [];
        const t = await rpc.debugTrace(since.current, 200);
        if (!alive || !t.entries.length) return;
        since.current = t.entries.reduce(
          (latest, entry) => Math.max(latest, entry.seq),
          since.current,
        );
        setEntries((previous) =>
          mergeTraceEntries(previous, t.entries, hiddenSeqs.current),
        );
      } catch (e: any) {
        setErr(String(e?.message ?? e));
      }
    }, TRACE_POLL_MS);
    return () => {
      mounted.current = false;
      alive = false;
      clearInterval(poll);
      rpc.setDebug(false).catch(() => {});
    };
  }, []);

  const list = target
    ? entries.filter(
        (entry) =>
          nameOf(entry.index).toLowerCase() === target.toLowerCase() ||
          String(entry.index) === target,
      )
    : entries;
  visibleEntriesRef.current = list;

  const selectedIndex = traceSelectionIndex(list, selectedSeq);
  const cur = list[selectedIndex];
  const start = Math.max(0, selectedIndex - 9);
  const win = list.slice(start, start + 18);

  const timestampTicks = [
    ...new Set([entries[0]?.tick, ...win.map((entry) => entry.tick)]),
  ].filter(
    (tick): tick is number =>
      tick != null &&
      !tickTimes.has(tick) &&
      (tickTimeAttempts.current.get(tick) ?? 0) < TICK_TIME_ATTEMPTS,
  );
  const timestampKey = timestampTicks.join(",");

  useEffect(() => {
    if (!timestampTicks.length) {
      return;
    }

    for (const tick of timestampTicks) {
      tickTimeAttempts.current.set(
        tick,
        (tickTimeAttempts.current.get(tick) ?? 0) + 1,
      );
    }
    Promise.all(
      timestampTicks.map(async (tick) => {
        try {
          const timestamp = (await rpc.getTickData(tick))?.timestamp;
          const seconds = Number(timestamp);
          return [
            tick,
            timestamp && Number.isFinite(seconds) && seconds > 0
              ? { tick, chainMs: seconds * 1000, resolvedAt: performance.now() }
              : null,
          ] as const;
        } catch {
          return [tick, null] as const;
        }
      }),
    ).then((resolved) => {
      if (!mounted.current) return;
      const found = resolved.filter(
        (result): result is readonly [number, TickClock] => result[1] != null,
      );
      if (found.length) {
        setTickTimes((previous) => {
          const next = new Map(previous);
          for (const [tick, tickTime] of found) next.set(tick, tickTime);
          return next;
        });
      }
      if (
        resolved.some(
          ([tick, tickTime]) =>
            !tickTime &&
            (tickTimeAttempts.current.get(tick) ?? 0) < TICK_TIME_ATTEMPTS,
        )
      ) {
        setTimeout(() => {
          if (mounted.current) setTickTimeRetry((retry) => retry + 1);
        }, TRACE_POLL_MS);
      }
    });
  }, [timestampKey, tickTimeRetry]);

  useEffect(() => {
    const activeTicks = new Set(entries.map((entry) => entry.tick));
    for (const tick of tickTimeAttempts.current.keys()) {
      if (!activeTicks.has(tick)) tickTimeAttempts.current.delete(tick);
    }
    setTickTimes((previous) => {
      const anchor = latestTickClock(previous.values());
      if (
        [...previous.keys()].every(
          (tick) => activeTicks.has(tick) || tick === anchor?.tick,
        )
      ) {
        return previous;
      }
      return new Map(
        [...previous].filter(
          ([tick]) => activeTicks.has(tick) || tick === anchor?.tick,
        ),
      );
    });
  }, [entries]);

  const clockAnchor = latestTickClock(tickTimes.values());
  const chainNowMs = clockAnchor
    ? clockAnchor.chainMs + Math.max(0, performance.now() - clockAnchor.resolvedAt)
    : undefined;

  // isActive=false in a non-TTY (CI/pipe) → Ink skips raw mode instead of throwing; still renders + polls.
  useInput(
    (input, key) => {
      if (input === "q" || key.escape) {
        rpc.setDebug(false).catch(() => {});
        exit();
      } else if (key.ctrl && input === "t") {
        setFullState((on) => !on);
      } else if (key.upArrow) {
        const visible = visibleEntriesRef.current;
        const index = traceSelectionIndex(visible, selectedSeqRef.current);
        const next = Math.max(0, index - 1);
        select(next === 0 ? null : visible[next]?.seq ?? null);
      } else if (key.downArrow) {
        const visible = visibleEntriesRef.current;
        const index = traceSelectionIndex(visible, selectedSeqRef.current);
        const next = Math.min(visible.length - 1, index + 1);
        select(next <= 0 ? null : visible[next]?.seq ?? null);
      } else if (input === "x") {
        const visible = visibleEntriesRef.current;
        const index = traceSelectionIndex(visible, selectedSeqRef.current);
        const entry = visible[index];
        if (!entry) return;

        hiddenSeqs.current.add(entry.seq);
        const remaining = visible.filter((candidate) => candidate.seq !== entry.seq);
        visibleEntriesRef.current = remaining;
        setEntries((previous) =>
          previous.filter((candidate) => candidate.seq !== entry.seq),
        );
        const nextIndex = Math.min(index, remaining.length - 1);
        select(nextIndex <= 0 ? null : remaining[nextIndex]?.seq ?? null);
      }
    },
    { isActive: Boolean(process.stdin.isTTY) },
  );

  return (
    <Box flexDirection="column">
      <Header cmd="debug" />
      <Text dimColor>
        {enabled ? "● capturing" : "toggle off"} · {list.length} calls · ↑/↓ select · x hide
        · ctrl+t {fullState ? "brief" : "full"} state · q quit
        {err ? "   err: " + err : ""}
      </Text>
      {list.length === 0 ? (
        <Box marginTop={1} flexDirection="column">
          {enabled ? (
            <Text color={theme.brand}>
              <Spinner label="waiting for a contract invocation" />
            </Text>
          ) : (
            <Text color={theme.warn}>capture is off — no traces will appear</Text>
          )}
          <Text dimColor>
            {" "}
            invoke a contract from another terminal: <Text color={theme.info}>
              qinit call
            </Text> (or <Text color={theme.info}>qinit deploy</Text>)
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Box flexDirection="column" width={48} marginRight={2}>
            <Table
              columns={LIST_COLS}
              rows={win.map((e) => [
                formatTraceAge(tickTimes.get(e.tick)?.chainMs, chainNowMs),
                String(e.tick),
                nameOf(e.index),
                kindName(e.kind) + "#" + e.entry,
                e.ok ? "✓" : "✗",
                ((e.execNs / 1000) | 0) + "µs",
              ])}
              selected={selectedIndex - start}
              rowColor={(i) => (!win[i].ok ? theme.err : undefined)}
              width={48}
            />
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {cur ? (
              <Detail
                e={cur}
                name={nameOf(cur.index)}
                source={reg.current.find((c) => c.index === cur.index)?.source}
                codeHash={reg.current.find((c) => c.index === cur.index)?.codeHash}
                rpc={rpc}
                qpiHeader={qpiHeader}
                fullState={fullState}
              />
            ) : (
              <Text dimColor>—</Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}

function Detail({
  e,
  name,
  source,
  codeHash,
  rpc,
  qpiHeader,
  fullState,
}: {
  e: DebugEntry;
  name: string;
  source?: string;
  codeHash?: string;
  rpc: LiteRpc;
  qpiHeader?: string;
  fullState: boolean;
}) {
  const [v, setV] = useState<DecodedTrace | null>(null);
  const [bt, setBt] = useState<string>("");
  const [stateOffset, setStateOffset] = useState(0);
  useEffect(() => {
    let alive = true;
    describeTrace(e, qpiHeader ? source : undefined, name, rpc, qpiHeader)
      .then((view) => {
        if (alive) setV(view);
      })
      .catch(() => {});
    setBt("");
    if (!e.ok) {
      // trapped call: source-mapped backtrace from node.log + the slot's line map
      try {
        const idl = loadContractIdlFile();
        const contractIdl = contractIdlForSlot(idl, e.index, codeHash);
        const log = join(activeNodeScratchDir(), "node.log");
        if (existsSync(log)) {
          const b = resolveTrapBacktrace(readFileSync(log, "utf8"), {
            lineMapPath: contractIdl?.linesJson,
          });
          if (b?.frames.length && alive) setBt(formatTrapBacktrace(b));
        }
      } catch (error: any) {
        if (alive) setBt(String(error?.message ?? error));
      }
    }
    return () => {
      alive = false;
    };
  }, [e.seq, codeHash]);

  useEffect(() => setStateOffset(0), [e.seq, fullState]);

  // The whole frame has to fit the terminal, so the state block gets what is left after the rows around
  // it. Ink cannot erase a frame taller than the screen; an overflowing block leaves stale rows behind.
  const otherRows = (v?.containers.length ?? 0) + (v?.logs.length ?? 0) + e.hostCalls.length;
  const chrome = 16; // headers, the call rows, the tail, and slack for whatever the shell left on screen
  const stateRows = Math.max(
    4,
    termRows() - chrome - otherRows - (bt ? bt.split("\n").length : 0),
  );
  const changed = v ? shownStateLines(v.stateDiff, fullState).length : 0;

  useInput(
    (_, key) => {
      if (key.pageDown) {
        setStateOffset((offset) => Math.min(offset + stateRows, Math.max(0, changed - stateRows)));
      } else if (key.pageUp) {
        setStateOffset((offset) => Math.max(0, offset - stateRows));
      }
    },
    { isActive: Boolean(process.stdin.isTTY) },
  );

  return (
    <Box flexDirection="column">
      {v ? (
        <TraceView
          e={e}
          name={name}
          view={v}
          fullState={fullState}
          stateHint="ctrl+t"
          maxStateRows={stateRows}
          stateOffset={stateOffset}
        />
      ) : (
        <Text dimColor>decoding…</Text>
      )}
      {bt ? (
        <Box marginTop={1} flexDirection="column">
          {bt.split("\n").map((l, i) => (
            <Text key={i} color={theme.err}>
              {l}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
