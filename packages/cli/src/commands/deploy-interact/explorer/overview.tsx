import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { ExplorerData } from "@qinit/core";
import { SectionHeader, Sparkline, Spinner, Table, TileRow, darken, fmtCompact, theme, type Column } from "../../../ui";
import { SectionBody, errText, fmtClock, sectionTableWidth, windowOf, type ViewProps } from "./chrome";

// ---- overview -----------------------------------------------------------------------------------

// What a tick row always spends, plus the gap Table puts between columns.
const TICK_WIDTH = 9;
const TXS_WIDTH = 4;
const TIME_WIDTH = 8;
const LEADER_MIN_WIDTH = 18;
const LEADER_MAX_WIDTH = 60;
const RAIL_MIN_WIDTH = 6;
const RAIL_MAX_WIDTH = 28;
const MEMPOOL_BAR_MAX_WIDTH = 36;
const COLUMN_GAP = 2;

// How far the oldest visible row's rail is blended toward black.
const RAIL_FADE = 0.75;

// The leader identity is 60 characters and takes what it can; the recency rail then fills the exact
// remainder. Both are sized here rather than left to Table, whose overflow loop shrinks the widest column
// and truncates with truncMid — on a rail that would render as `───…───`.
function tickLayout(
  tableWidth: number,
  railColor: (rowIndex: number) => string,
): { columns: Column[]; railWidth: number } {
  const fixedWidth = TICK_WIDTH + TXS_WIDTH + TIME_WIDTH;
  const flexWithRail = tableWidth - fixedWidth - COLUMN_GAP * 4;
  const leaderWithRail = Math.min(
    LEADER_MAX_WIDTH,
    Math.max(LEADER_MIN_WIDTH, flexWithRail - RAIL_MIN_WIDTH),
  );
  const railWidth = Math.min(RAIL_MAX_WIDTH, flexWithRail - leaderWithRail);
  // Too narrow for a rail worth drawing: drop the column and let the leader have its width.
  const leaderWidth =
    railWidth >= RAIL_MIN_WIDTH
      ? leaderWithRail
      : Math.min(
          LEADER_MAX_WIDTH,
          Math.max(LEADER_MIN_WIDTH, tableWidth - fixedWidth - COLUMN_GAP * 3),
        );

  const columns: Column[] = [
    { header: "tick", align: "right", max: TICK_WIDTH },
    { header: "leader", max: leaderWidth },
    { header: "txs", align: "right", max: TXS_WIDTH },
    { header: "time", max: TIME_WIDTH },
  ];
  if (railWidth >= RAIL_MIN_WIDTH) {
    columns.push({ header: "", max: railWidth, color: railColor });
  }

  return { columns, railWidth: railWidth >= RAIL_MIN_WIDTH ? railWidth : 0 };
}

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

  // The rail fades down the window, so the newest tick reads as the live end of the list.
  const railColor = (rowIndex: number): string =>
    darken(theme.gradFrom, (rowIndex / Math.max(1, win.length - 1)) * RAIL_FADE);
  const { columns: tickColumns, railWidth } = tickLayout(sectionTableWidth(columns), railColor);
  const rail = "─".repeat(railWidth);

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
            width={Math.max(16, Math.min(MEMPOOL_BAR_MAX_WIDTH, sectionTableWidth(columns) - 24))}
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
          columns={tickColumns}
          rows={win.map((t) => {
            const cells = [
              String(t.tick),
              t.leader,
              String(t.txCount),
              fmtClock(t.timestamp),
            ];
            if (railWidth > 0) {
              cells.push(rail);
            }
            return cells;
          })}
          selected={selected - offset}
          rowColor={(i) => (win[i].empty ? theme.mute : undefined)}
          width={sectionTableWidth(columns)}
        />
      </SectionBody>
    </Box>
  );
}
