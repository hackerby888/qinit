import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { ExplorerData } from "@qinit/core";
import { SectionHeader, Sparkline, Spinner, Table, TileRow, fmtCompact, theme, type Column } from "../../../ui";
import { SectionBody, errText, fmtTime, sectionTableWidth, windowOf, type ViewProps } from "./chrome";

// ---- overview -----------------------------------------------------------------------------------

const TICK_COLS: Column[] = [
  { header: "tick", align: "right", max: 12 },
  { header: "leader", max: 18 },
  { header: "txs", align: "right", max: 5 },
  { header: "timestamp", max: 20 },
  { header: "", max: 8 },
];

export function OverviewView({
  rpc,
  refreshToken,
  selected,
  push,
  rowCount,
  openRow,
  bodyRows,
  columns,
}: ViewProps) {
  const [data, setData] = useState<ExplorerData | null>(null);
  const [err, setErr] = useState("");

  // The overview is the only live view — the rest are snapshots fetched on entry.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const next = await rpc.explorerData();
        if (alive) {
          setData(next);
          setErr("");
        }
      } catch (e) {
        // Keep the last good frame on screen and keep polling; a node restart recovers on its own.
        if (alive) setErr(errText(e));
      }
    };

    void load();
    const poll = setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(poll);
    };
  }, [refreshToken]);

  const ticks = data ? [...data.recentTicks].reverse() : [];
  rowCount.current = ticks.length;
  openRow.current = (index) => {
    const row = ticks[index];
    if (row) push({ kind: "tick", tick: row.tick });
  };

  if (!data) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.brand}>
          <Spinner label="reading the chain" />
        </Text>
        {err ? <Text color={theme.err}>{err}</Text> : null}
      </Box>
    );
  }

  const { header, mempool, network, spectrum } = data;
  const pending = mempool.perTick.filter((entry) => entry.count > 0).slice(0, 4);

  // Tile rows are 3 lines each and wrap by terminal width; the mempool block only exists when it has rows.
  const tiles = [
    { title: "tick", value: String(header.tick) },
    { title: "epoch", value: `${header.epoch} · +${header.ticksInCurrentEpoch}` },
    // header carries alignedVotes with no committee size, so this is a count, not a ratio.
    { title: "aligned", value: String(header.alignedVotes), color: theme.ok },
    { title: "supply", value: fmtCompact(spectrum.circulatingSupply) },
    { title: "entities", value: String(spectrum.activeAddresses) },
    {
      title: "peers",
      value: `${network.connectedPeers} ↑${network.outgoing} ↓${network.incoming}`,
    },
  ];
  // Fixed rows this view owns: tile block (its margin + 3 per wrapped row), the mempool section header
  // (margin + line) and its body, then the ticks header and the table's own column row.
  const tileRows = 1 + 3 * Math.ceil(tiles.length / Math.max(1, Math.floor(columns / 19)));
  const mempoolRows = 2 + Math.max(1, pending.length);
  const { win, offset } = windowOf(ticks, selected, bodyRows - tileRows - mempoolRows - 3);

  return (
    <Box flexDirection="column">
      <Box marginTop={1}>
        <TileRow tiles={tiles} columns={columns} />
      </Box>
      <SectionHeader
        title="mempool"
        detail={
          mempool.totalPending > 0 ? `${mempool.totalPending} pending` : undefined
        }
        width={columns}
      />
      <SectionBody>
        {pending.length > 0 ? (
          <Sparkline
            rows={pending.map((entry) => ({ label: String(entry.tick), value: entry.count }))}
          />
        ) : (
          <Text dimColor>no pending transactions</Text>
        )}
      </SectionBody>
      <SectionHeader
        title="recent ticks"
        detail={`${ticks.length} newest first`}
        badge={err ? "OFFLINE" : undefined}
        error={err}
        width={columns}
      />
      <SectionBody>
        <Table
          columns={TICK_COLS}
          rows={win.map((t) => [
            String(t.tick),
            t.leader,
            String(t.txCount),
            fmtTime(t.timestamp),
            t.empty ? "empty" : "filled",
          ])}
          selected={selected - offset}
          rowColor={(i) => (win[i].empty ? theme.mute : undefined)}
          width={sectionTableWidth(columns)}
        />
      </SectionBody>
    </Box>
  );
}
