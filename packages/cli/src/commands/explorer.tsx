// Interactive chain explorer — a TUI port of core-lite's web explorer. Drills overview → tick → transaction,
// plus identity lookup and the contract catalog, against either a core node or the simulator.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  DEFAULT_RPC_BASE,
  LiteRpc,
  contractIndexFromIdentity,
  type ContractCall,
  type ContractListEntry,
  type EntityInfo,
  type ExplorerData,
  type ExplorerTickData,
  type ExplorerTx,
  type IdentityTransfer,
} from "@qinit/core";
import { loadConfig, savedTheme, setSavedTheme } from "../config";
import {
  Badge,
  Grad,
  Header,
  KV,
  SectionHeader,
  Sparkline,
  Spinner,
  Table,
  THEME_NAMES,
  TileRow,
  applyTheme,
  fmtCompact,
  theme,
  truncMid,
  useTerminalSize,
  type Column,
} from "../ui";
import { output } from "../args";
import { TextPrompt } from "./call-interactive";
import type { CommandArguments } from "../args";

// The web explorer scans the last 500 ticks for contract calls; the same window keeps a page cheap here.
const CONTRACT_CALL_WINDOW = 500;
const CONTRACT_PAGE_SIZE = 50;

type View =
  | { kind: "overview" }
  | { kind: "tick"; tick: number }
  | { kind: "tx"; hash: string; tick?: number }
  | { kind: "identity"; id?: string }
  | { kind: "contracts"; page: number }
  | { kind: "contract"; index: number };

// One stack frame per drill-down level. `selected` is kept per frame so popping back to a list restores
// the row the user came from instead of resetting to the top.
interface Frame {
  view: View;
  selected: number;
}

const frameOf = (view: View): Frame => ({ view, selected: 0 });

function initialView(commandArgs: CommandArguments): View {
  const tick = commandArgs.get("tick");
  if (tick != null && tick !== "") {
    return { kind: "tick", tick: Number(tick) };
  }

  const hash = commandArgs.get("tx");
  if (hash) {
    return { kind: "tx", hash };
  }

  const id = commandArgs.get("id");
  if (id) {
    return { kind: "identity", id };
  }

  return { kind: "overview" };
}

const fmtTime = (timestamp: string): string => {
  const seconds = Number(timestamp);
  if (!timestamp || !Number.isFinite(seconds) || seconds <= 0) {
    return "—";
  }
  return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 19);
};

// Amounts arrive as decimal strings and can exceed 2^53 — group digits without ever widening to Number.
const fmtAmount = (amount: string): string => {
  const negative = amount.startsWith("-");
  const digits = negative ? amount.slice(1) : amount;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return negative ? `-${grouped}` : grouped;
};

const errText = (e: unknown): string => String((e as Error)?.message ?? e);

// A destination that is really a contract address, labelled by slot.
const contractLabel = (identity: string, names: Map<number, string>): string | null => {
  const index = contractIndexFromIdentity(identity);
  if (index == null) {
    return null;
  }
  return `${names.get(index) ?? "contract"} #${index}`;
};

// Rows the shell owns above the body: the header with its margin, plus the breadcrumb.
const CHROME_ROWS = 3;

export function Explorer({ commandArgs }: { commandArgs: CommandArguments }) {
  // The explorer is a live keyboard UI; there is no meaningful piped or structured form of it.
  if (output.json || !process.stdin.isTTY) {
    throw new Error(
      "explorer is interactive — run it in a terminal (it has no --json or piped output)",
    );
  }

  const rpcBaseUrl = commandArgs.get("rpc") || loadConfig().rpc || DEFAULT_RPC_BASE;
  const { exit } = useApp();
  const rpc = useRef(new LiteRpc(rpcBaseUrl)).current;
  const { columns, rows } = useTerminalSize();

  const [stack, setStack] = useState<Frame[]>(() => [frameOf(initialView(commandArgs))]);
  const [themeName, setThemeName] = useState(() => savedTheme() ?? "default");
  const [refreshToken, setRefreshToken] = useState(0);

  const top = stack[stack.length - 1];
  const view = top.view;
  // Derived, not state: the identity view without an id *is* the search prompt. Tracking it in an effect
  // instead would leave the first frame advertising keys the prompt has already taken.
  const searching = view.kind === "identity" && !view.id;

  // Contract names, loaded once and reused to label contract addresses across every view.
  const [contractNames, setContractNames] = useState<Map<number, string>>(new Map());
  useEffect(() => {
    let alive = true;
    rpc
      .getContracts()
      .then(({ contracts }) => {
        if (alive) {
          setContractNames(new Map(contracts.map((c) => [c.index, c.name])));
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const push = (next: View) => setStack((s) => [...s, frameOf(next)]);
  const replaceRoot = (next: View) => setStack([frameOf(next)]);
  // esc always means "back". From a drilled-in view that is the previous frame; from a section root it is
  // the overview, which is the explorer's home. Only esc on the overview itself leaves — as does q, always.
  const pop = () =>
    setStack((s) => {
      if (s.length > 1) {
        return s.slice(0, -1);
      }
      if (s[0].view.kind !== "overview") {
        return [frameOf({ kind: "overview" })];
      }
      exit();
      return s;
    });
  const moveSelection = (delta: number, count: number) =>
    setStack((s) => {
      const frame = s[s.length - 1];
      const next = Math.max(0, Math.min(count - 1, frame.selected + delta));
      if (next === frame.selected) {
        return s;
      }
      return [...s.slice(0, -1), { ...frame, selected: next }];
    });

  // Row count of whatever list the current view shows — set by the view, read by the key handler.
  const rowCount = useRef(0);
  const openRow = useRef<(index: number) => void>(() => {});

  useInput(
    (input, key) => {
      // While the identity prompt owns the keyboard, esc still has to mean "back" — it is the only way
      // out of the search. Every other key belongs to the prompt so it can be typed into the field.
      // ink blanks `input` for escape, so the prompt never sees this keypress itself.
      if (searching) {
        if (key.escape) {
          pop();
        }
        return;
      }

      if (input === "q") {
        exit();
      } else if (key.escape) {
        pop();
      } else if (input === "1") {
        replaceRoot({ kind: "overview" });
      } else if (input === "2") {
        replaceRoot({ kind: "contracts", page: 0 });
      } else if (input === "3") {
        replaceRoot({ kind: "identity" });
      } else if (input === "t") {
        const next =
          THEME_NAMES[(THEME_NAMES.indexOf(themeName) + 1) % THEME_NAMES.length];
        applyTheme(next);
        setSavedTheme(next);
        setThemeName(next); // the palette is a mutated singleton — this is what forces the repaint
      } else if (input === "r") {
        setRefreshToken((n) => n + 1);
      } else if (key.upArrow) {
        moveSelection(-1, rowCount.current);
      } else if (key.downArrow) {
        moveSelection(1, rowCount.current);
      } else if (key.return) {
        openRow.current(top.selected);
      } else if (key.leftArrow || key.rightArrow) {
        const step = key.rightArrow ? 1 : -1;
        if (view.kind === "tick") {
          setStack((s) => [
            ...s.slice(0, -1),
            frameOf({ kind: "tick", tick: Math.max(0, view.tick + step) }),
          ]);
        } else if (view.kind === "contracts") {
          setStack((s) => [
            ...s.slice(0, -1),
            frameOf({ kind: "contracts", page: Math.max(0, view.page + step) }),
          ]);
        }
      }
    },
    { isActive: Boolean(process.stdin.isTTY) },
  );

  const shared = {
    rpc,
    refreshToken,
    selected: top.selected,
    contractNames,
    push,
    rowCount,
    openRow,
    bodyRows: Math.max(
      4,
      rows - 1 - CHROME_ROWS - controlBarRows(view, stack.length, columns, searching),
    ),
    columns,
  };

  // Fixed height + a growing body is what pins the control bar to the last rows. Sizing the shell to
  // exactly `rows` makes the terminal scroll by one line and the pin breaks, hence rows - 1.
  return (
    <Box flexDirection="column" height={rows - 1}>
      <Header cmd="explorer" />
      <Breadcrumb stack={stack} />
      <Box flexDirection="column" flexGrow={1}>
      {view.kind === "overview" ? (
        <OverviewView {...shared} />
      ) : view.kind === "tick" ? (
        <TickView {...shared} tick={view.tick} />
      ) : view.kind === "tx" ? (
        <TxView {...shared} hash={view.hash} tick={view.tick} />
      ) : view.kind === "identity" ? (
        <IdentityView
          {...shared}
          id={view.id}
          onSubmit={(id) => setStack((s) => [...s.slice(0, -1), frameOf({ kind: "identity", id })])}
        />
      ) : view.kind === "contracts" ? (
        <ContractsView {...shared} page={view.page} />
      ) : (
        <ContractView {...shared} index={view.index} />
      )}
      </Box>
      <ControlBar
        view={view}
        depth={stack.length}
        themeName={themeName}
        rpcBaseUrl={rpcBaseUrl}
        columns={columns}
        searching={searching}
      />
    </Box>
  );
}

// ---- chrome -------------------------------------------------------------------------------------

const crumbOf = (view: View): string => {
  switch (view.kind) {
    case "overview":
      return "overview";
    case "tick":
      return `tick ${view.tick}`;
    case "tx":
      return `tx ${truncMid(view.hash, 12)}`;
    case "identity":
      return view.id ? `id ${truncMid(view.id, 12)}` : "identity";
    case "contracts":
      return view.page > 0 ? `contracts p${view.page + 1}` : "contracts";
    case "contract":
      return `contract #${view.index}`;
  }
};

// Section contents sit under the header's title rather than flush with its ▌ marker, so each block reads
// as belonging to its heading.
const SECTION_INDENT = 2;

// Table budget inside a section: the indent plus one spare column, so a full-width row can never land on
// the terminal's last cell and wrap.
const sectionTableWidth = (columns: number) => columns - SECTION_INDENT - 1;

function SectionBody({ children }: { children: ReactNode }) {
  return (
    <Box paddingLeft={SECTION_INDENT} flexDirection="column">
      {children}
    </Box>
  );
}

function Breadcrumb({ stack }: { stack: Frame[] }) {
  return (
    <Text>
      {stack.map((frame, index) => (
        <Text key={index}>
          {index > 0 ? <Text dimColor> › </Text> : null}
          {index === stack.length - 1 ? (
            <Text color={theme.brand} bold>
              {crumbOf(frame.view)}
            </Text>
          ) : (
            <Text dimColor>{crumbOf(frame.view)}</Text>
          )}
        </Text>
      ))}
    </Text>
  );
}

// Only advertise keys the current view actually binds — stale hints are what make a TUI feel confusing.
// The key glyph carries the color and the label stays at normal weight; dimming the whole line is what
// made this bar disappear into the data above it.
type KeyHint = [key: string, label: string];

function keysFor(view: View, depth: number, searching: boolean): KeyHint[] {
  // The prompt owns every key except esc, so advertising the rest would be a lie.
  if (searching) {
    return [
      ["↵", "look up"],
      ["esc", "back"],
    ];
  }

  const keys: KeyHint[] = [
    ["1", "overview"],
    ["2", "contracts"],
    ["3", "identity"],
  ];

  const hasList =
    view.kind === "overview" ||
    view.kind === "tick" ||
    view.kind === "contracts" ||
    view.kind === "contract" ||
    (view.kind === "identity" && Boolean(view.id));
  if (hasList) {
    keys.push(["↑↓", "select"], ["↵", "open"]);
  }
  if (view.kind === "tick") {
    keys.push(["←→", "tick"]);
  } else if (view.kind === "contracts") {
    keys.push(["←→", "page"]);
  }
  // esc leads back to the overview from any section root, so it is only meaningless on the overview itself.
  if (depth > 1 || view.kind !== "overview") {
    keys.push(["esc", "back"]);
  }
  keys.push(["r", "refresh"], ["t", "theme"], ["q", "quit"]);
  return keys;
}

const HINT_SEPARATOR = "  ·  ";

// Wrap hints into lines that fit the terminal. Labels are never dropped — a row of bare glyphs is harder
// to use than the bar this replaced. The shell asks for the line count so it can budget the rows.
export function hintLines(keys: KeyHint[], columns: number): KeyHint[][] {
  const lines: KeyHint[][] = [[]];
  let used = 0;

  for (const hint of keys) {
    const size = hint[0].length + 1 + hint[1].length;
    const withSeparator = lines[lines.length - 1].length > 0 ? size + HINT_SEPARATOR.length : size;
    if (used + withSeparator > columns - 1 && lines[lines.length - 1].length > 0) {
      lines.push([hint]);
      used = size;
      continue;
    }
    lines[lines.length - 1].push(hint);
    used += withSeparator;
  }

  return lines;
}

// Rule + wrapped hint lines + the status line.
const controlBarRows = (
  view: View,
  depth: number,
  columns: number,
  searching: boolean,
): number => 2 + hintLines(keysFor(view, depth, searching), columns).length;

function ControlBar({
  view,
  depth,
  themeName,
  rpcBaseUrl,
  columns,
  searching,
}: {
  view: View;
  depth: number;
  themeName: string;
  rpcBaseUrl: string;
  columns: number;
  searching: boolean;
}) {
  const lines = hintLines(keysFor(view, depth, searching), columns);

  return (
    <Box flexDirection="column">
      <Text dimColor>{"─".repeat(Math.max(0, columns - 1))}</Text>
      {lines.map((line, lineIndex) => (
        <Text key={lineIndex}>
          {line.map(([key, label], index) => (
            <Text key={key}>
              {index > 0 ? <Text dimColor>{HINT_SEPARATOR}</Text> : null}
              <Text bold color={theme.brand}>
                {key}
              </Text>
              <Text>{` ${label}`}</Text>
            </Text>
          ))}
        </Text>
      ))}
      <Text>
        <Text color={theme.ok}>●</Text> <Text dimColor>{rpcBaseUrl}</Text>
        <Text dimColor>{`   theme ${themeName}`}</Text>
      </Text>
    </Box>
  );
}

interface ViewProps {
  rpc: LiteRpc;
  refreshToken: number;
  selected: number;
  contractNames: Map<number, string>;
  push: (view: View) => void;
  rowCount: { current: number };
  openRow: { current: (index: number) => void };
  bodyRows: number;
  columns: number;
}

// Slice a list around the selected row. `budget` is the rows left after the view's own fixed block, so a
// long list can never grow past the shell and push the control bar off-screen.
function windowOf<T>(
  rows: T[],
  selected: number,
  budget: number,
): { win: T[]; offset: number } {
  const size = Math.max(1, budget);
  const offset = Math.max(0, Math.min(selected - Math.floor(size / 2), rows.length - size));
  return { win: rows.slice(offset, offset + size), offset: Math.max(0, offset) };
}

// ---- overview -----------------------------------------------------------------------------------

const TICK_COLS: Column[] = [
  { header: "tick", align: "right", max: 12 },
  { header: "leader", max: 18 },
  { header: "txs", align: "right", max: 5 },
  { header: "timestamp", max: 20 },
  { header: "", max: 8 },
];

function OverviewView({
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

// ---- tick ---------------------------------------------------------------------------------------

const TX_COLS: Column[] = [
  { header: "hash", max: 16 },
  { header: "source", max: 16 },
  { header: "destination", max: 26 },
  { header: "amount", align: "right", max: 16 },
  { header: "in", align: "right", max: 4 },
  { header: "size", align: "right", max: 6 },
];

const txRow = (tx: ExplorerTx, names: Map<number, string>): string[] => {
  const label = contractLabel(tx.destination, names);
  return [
    tx.hash,
    tx.source,
    label ? `${truncMid(tx.destination, 10)} ${label}` : tx.destination,
    fmtAmount(tx.amount),
    String(tx.inputType),
    String(tx.inputSize),
  ];
};

function TickView({
  rpc,
  refreshToken,
  selected,
  contractNames,
  push,
  rowCount,
  openRow,
  bodyRows,
  columns,
  tick,
}: ViewProps & { tick: number }) {
  const [tickData, setTickData] = useState<ExplorerTickData | null>(null);
  const [txs, setTxs] = useState<ExplorerTx[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr("");
    // The header and the transaction list are fetched independently — an empty tick has no header but can
    // still be rendered, and a node missing one route must not blank out the other.
    void (async () => {
      const [header, list] = await Promise.allSettled([
        rpc.getTickData(tick),
        rpc.explorerTickTransactions(tick),
      ]);
      if (!alive) return;

      setTickData(header.status === "fulfilled" ? header.value : null);
      setTxs(list.status === "fulfilled" ? list.value : []);
      setErr(
        header.status === "rejected"
          ? errText(header.reason)
          : list.status === "rejected"
            ? errText(list.reason)
            : "",
      );
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [tick, refreshToken]);

  rowCount.current = txs.length;
  openRow.current = (index) => {
    const tx = txs[index];
    if (tx) push({ kind: "tx", hash: tx.hash, tick });
  };

  // Title, the 6-row KV (or its one-line fallback), and the section header.
  const { win, offset } = windowOf(txs, selected, bodyRows - (tickData ? 12 : 7));

  return (
    <Box flexDirection="column">
      <Box marginTop={1}>
        <Text>
          <Grad text={`TICK ${tick}`} />
        </Text>
      </Box>
      {loading ? (
        <Box marginTop={1}>
          <Text color={theme.brand}>
            <Spinner label="reading the tick" />
          </Text>
        </Box>
      ) : tickData ? (
        <Box marginTop={1}>
          <KV
            rows={[
              ["epoch", String(tickData.epoch)],
              ["leader", `computor #${tickData.computorIndex}`],
              ["timestamp", fmtTime(tickData.timestamp)],
              ["digests", String(tickData.transactionDigests.length)],
              ["timelock", truncMid(tickData.timelock, 44)],
              ["signature", truncMid(tickData.signature, 44)],
            ]}
          />
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={theme.warn}>this tick is empty or outside the node's history</Text>
        </Box>
      )}
      <SectionHeader
        title="transactions"
        detail={String(txs.length)}
        error={err}
        width={columns}
      />
      <SectionBody>
        {txs.length === 0 ? (
          <Text dimColor>no transactions in this tick</Text>
        ) : (
          <Table
            columns={TX_COLS}
            rows={win.map((tx) => txRow(tx, contractNames))}
            selected={selected - offset}
            width={sectionTableWidth(columns)}
          />
        )}
      </SectionBody>
    </Box>
  );
}

// ---- transaction --------------------------------------------------------------------------------

function TxView({
  rpc,
  refreshToken,
  contractNames,
  push,
  rowCount,
  openRow,
  bodyRows,
  columns,
  hash,
  tick,
}: ViewProps & { hash: string; tick?: number }) {
  const [tx, setTx] = useState<ExplorerTx | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    rpc
      .getTransactionByHash(hash, tick)
      .then((found) => {
        if (!alive) return;
        setTx(found);
        setErr("");
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setErr(errText(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [hash, tick, refreshToken]);

  // ↵ walks from a transaction to the identities it touches.
  const targets = tx ? [tx.source, tx.destination] : [];
  rowCount.current = 0;
  openRow.current = () => {
    if (targets[0]) push({ kind: "identity", id: targets[0] });
  };

  if (loading) {
    return (
      <Box marginTop={1}>
        <Text color={theme.brand}>
          <Spinner label="reading the transaction" />
        </Text>
      </Box>
    );
  }

  if (!tx) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.warn}>no transaction with this hash on the node</Text>
        <Text dimColor>{hash}</Text>
        {err ? <Text color={theme.err}>{err}</Text> : null}
      </Box>
    );
  }

  const label = contractLabel(tx.destination, contractNames);
  const inputBytes = tx.inputData ? Buffer.from(tx.inputData, "base64") : Buffer.alloc(0);
  // 15 rows are fixed here: the title block with its from/to band (5), the 7-row KV with its margin (8),
  // and the trailing hint (2). The dump then costs its own margin + section header + an overflow line, so
  // it only appears once everything else fits — a short terminal drops dump rows, never the control bar.
  const hexBudget = Math.max(0, Math.min(8, bodyRows - 19));
  const hexRows: string[] = [];
  for (let offset = 0; offset < inputBytes.length && hexRows.length < hexBudget; offset += 32) {
    hexRows.push(inputBytes.subarray(offset, offset + 32).toString("hex"));
  }
  const shownBytes = hexRows.length * 32;

  return (
    <Box flexDirection="column">
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Grad text="TRANSACTION" />
          <Text dimColor>{`  ${tx.hash}`}</Text>
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color={theme.info}>from </Text>
            <Text>{tx.source}</Text>
          </Text>
          <Text>
            <Text color={theme.info}>  to </Text>
            <Text>{tx.destination}</Text>
            {label ? (
              <Text>
                {"  "}
                <Badge text={label} color={theme.info} />
              </Text>
            ) : null}
          </Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <KV
          rows={[
            ["amount", fmtAmount(tx.amount)],
            ["tick", String(tx.tickNumber)],
            ["timestamp", fmtTime(tx.timestamp)],
            ["input type", String(tx.inputType)],
            ["input size", `${tx.inputSize} bytes`],
            ["money flew", tx.moneyFlew ? "✓ yes" : "◌ no"],
            ["signature", tx.signature ? truncMid(tx.signature, 60) : "—"],
          ]}
        />
      </Box>
      {hexRows.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <SectionHeader
            title="input data"
            detail={`${inputBytes.length} bytes`}
            width={columns}
          />
          <SectionBody>
            {hexRows.map((row, index) => (
              <Text key={index} dimColor>
                {row}
              </Text>
            ))}
            {inputBytes.length > shownBytes ? (
              <Text dimColor>{`… ${inputBytes.length - shownBytes} more bytes`}</Text>
            ) : null}
          </SectionBody>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>↵ opens the sender's identity</Text>
      </Box>
    </Box>
  );
}

// ---- identity -----------------------------------------------------------------------------------

const TRANSFER_COLS: Column[] = [
  { header: "tick", align: "right", max: 12 },
  { header: "dir", max: 4 },
  { header: "hash", max: 16 },
  { header: "peer", max: 22 },
  { header: "amount", align: "right", max: 18 },
  { header: "timestamp", max: 20 },
];

function IdentityView({
  rpc,
  refreshToken,
  selected,
  contractNames,
  push,
  rowCount,
  openRow,
  bodyRows,
  columns,
  id,
  onSubmit,
}: ViewProps & {
  id?: string;
  onSubmit: (id: string) => void;
}) {
  const [entity, setEntity] = useState<EntityInfo | null>(null);
  const [transfers, setTransfers] = useState<IdentityTransfer[]>([]);
  const [balanceErr, setBalanceErr] = useState("");
  const [transferErr, setTransferErr] = useState("");
  const [loading, setLoading] = useState(Boolean(id));

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setLoading(true);

    // Balance and transfers are fetched independently so a node without the transfers route still
    // renders a balance.
    void (async () => {
      const [balance, transferList] = await Promise.allSettled([
        rpc.balance(id),
        rpc.getTransfersForIdentity(id, 50),
      ]);
      if (!alive) return;

      setEntity(balance.status === "fulfilled" ? balance.value : null);
      setBalanceErr(balance.status === "rejected" ? errText(balance.reason) : "");
      setTransfers(transferList.status === "fulfilled" ? transferList.value.transactions : []);
      setTransferErr(
        transferList.status === "rejected" ? errText(transferList.reason) : "",
      );
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [id, refreshToken]);

  rowCount.current = transfers.length;
  openRow.current = (index) => {
    const transfer = transfers[index];
    if (transfer) push({ kind: "tx", hash: transfer.hash, tick: transfer.tickNumber });
  };

  if (!id) {
    return (
      <Box marginTop={1} flexDirection="column">
        <SectionHeader
          title="identity lookup"
          detail="60-character identity"
          width={columns}
        />
        <TextPrompt
          label="identity"
          onSubmit={(value) => {
            const trimmed = value.trim().toUpperCase();
            if (trimmed.length === 60) onSubmit(trimmed);
          }}
          placeholder={"A".repeat(60)}
        />
      </Box>
    );
  }

  if (loading) {
    return (
      <Box marginTop={1}>
        <Text color={theme.brand}>
          <Spinner label="reading the identity" />
        </Text>
      </Box>
    );
  }

  // The web explorer derives the displayed balance from the transfer totals rather than the stored field.
  const balance = entity
    ? BigInt(entity.incomingAmount) - BigInt(entity.outgoingAmount)
    : 0n;
  // Balance hero (3), the 4-row KV or its fallback, and the section header.
  const { win, offset } = windowOf(transfers, selected, bodyRows - (entity ? 11 : 8));

  return (
    <Box flexDirection="column">
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Grad text={fmtAmount(balance.toString())} />
          <Text dimColor>{"  qu"}</Text>
        </Text>
        <Text dimColor>{id}</Text>
      </Box>
      {entity ? (
        <Box marginTop={1}>
          <KV
            rows={[
              ["incoming", `${fmtAmount(entity.incomingAmount)}  (${entity.numberOfIncomingTransfers} transfers)`],
              ["outgoing", `${fmtAmount(entity.outgoingAmount)}  (${entity.numberOfOutgoingTransfers} transfers)`],
              ["latest in", String(entity.latestIncomingTransferTick)],
              ["latest out", String(entity.latestOutgoingTransferTick)],
            ]}
          />
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={theme.warn}>
            no spectrum entry — this address has never been seen on chain
          </Text>
        </Box>
      )}
      {balanceErr ? <Text color={theme.err}>{balanceErr}</Text> : null}
      <SectionHeader
        title="transfers"
        detail={`${transfers.length} in the node's recent window`}
        error={transferErr}
        width={columns}
      />
      <SectionBody>
        {transfers.length === 0 ? (
          <Text dimColor>no transfers in the retained window</Text>
        ) : (
          <Table
            columns={TRANSFER_COLS}
            rows={win.map((t) => {
              const peer = t.direction === "in" ? t.source : t.destination;
              const label = contractLabel(peer, contractNames);
              // A zero-amount call is neither a credit nor a debit — don't sign it.
              const sign = t.amount === "0" ? "" : t.direction === "in" ? "+" : "-";
              return [
                String(t.tickNumber),
                t.direction === "in" ? "IN" : "OUT",
                t.hash,
                label ?? peer,
                `${sign}${fmtAmount(t.amount)}`,
                fmtTime(t.timestamp),
              ];
            })}
            selected={selected - offset}
            rowColor={(i) => (win[i].direction === "in" ? theme.ok : theme.warn)}
            width={sectionTableWidth(columns)}
          />
        )}
      </SectionBody>
    </Box>
  );
}

// ---- contracts ----------------------------------------------------------------------------------

const CONTRACT_COLS: Column[] = [
  { header: "#", align: "right", max: 5 },
  { header: "name", max: 24 },
  { header: "state", align: "right", max: 10 },
  { header: "calls", align: "right", max: 8 },
];

function ContractsView({
  rpc,
  refreshToken,
  selected,
  push,
  rowCount,
  openRow,
  bodyRows,
  columns,
  page,
}: ViewProps & { page: number }) {
  const [contracts, setContracts] = useState<ContractListEntry[]>([]);
  const [calls, setCalls] = useState<Map<number, number>>(new Map());
  const [window, setWindow] = useState<{ from: number; to: number } | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const [{ contracts: list }, data] = await Promise.all([
          rpc.getContracts(),
          rpc.explorerData(),
        ]);
        if (!alive) return;
        setContracts(list);

        const toTick = data.header.tick;
        const fromTick = Math.max(data.header.initialTick, toTick - CONTRACT_CALL_WINDOW + 1);
        setWindow({ from: fromTick, to: toTick });

        const callPage = await rpc.getContractCalls({
          fromTick,
          toTick,
          page,
          pageSize: CONTRACT_PAGE_SIZE,
        });
        if (!alive) return;

        const counts = new Map<number, number>();
        for (const call of callPage.transactions) {
          counts.set(call.contractIndex, (counts.get(call.contractIndex) ?? 0) + 1);
        }
        setCalls(counts);
        setErr("");
      } catch (e) {
        if (alive) setErr(errText(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [page, refreshToken]);

  rowCount.current = contracts.length;
  openRow.current = (index) => {
    const contract = contracts[index];
    if (contract) push({ kind: "contract", index: contract.index });
  };

  const { win, offset } = windowOf(contracts, selected, bodyRows - 4);

  return (
    <Box flexDirection="column">
      <SectionHeader
        title="contracts"
        detail={
          window
            ? `${contracts.length} deployed · calls counted over ticks ${window.from}–${window.to}`
            : `${contracts.length} deployed`
        }
        error={err}
        width={columns}
      />
      <SectionBody>
      {loading && contracts.length === 0 ? (
        <Text color={theme.brand}>
          <Spinner label="reading the contract catalog" />
        </Text>
      ) : contracts.length === 0 ? (
        <Text dimColor>no contracts deployed on this node</Text>
      ) : (
        <Table
          columns={CONTRACT_COLS}
          rows={win.map((c) => [
            String(c.index),
            c.name || "—",
            `${c.stateSize} B`,
            String(calls.get(c.index) ?? 0),
          ])}
          selected={selected - offset}
          width={sectionTableWidth(columns)}
        />
      )}
      </SectionBody>
    </Box>
  );
}

const CALL_COLS: Column[] = [
  { header: "tick", align: "right", max: 12 },
  { header: "hash", max: 16 },
  { header: "caller", max: 22 },
  { header: "amount", align: "right", max: 16 },
  { header: "in", align: "right", max: 4 },
  { header: "timestamp", max: 20 },
];

function ContractView({
  rpc,
  refreshToken,
  selected,
  push,
  rowCount,
  openRow,
  bodyRows,
  columns,
  index,
}: ViewProps & { index: number }) {
  const [meta, setMeta] = useState<ContractListEntry | null>(null);
  const [calls, setCalls] = useState<ContractCall[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const [{ contracts }, data] = await Promise.all([
          rpc.getContracts(),
          rpc.explorerData(),
        ]);
        if (!alive) return;
        setMeta(contracts.find((c) => c.index === index) ?? null);

        const toTick = data.header.tick;
        const page = await rpc.getContractCalls({
          fromTick: Math.max(data.header.initialTick, toTick - CONTRACT_CALL_WINDOW + 1),
          toTick,
          contractIndex: index,
          pageSize: 100,
        });
        if (!alive) return;
        setCalls(page.transactions);
        setErr("");
      } catch (e) {
        if (alive) setErr(errText(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [index, refreshToken]);

  rowCount.current = calls.length;
  openRow.current = (row) => {
    const call = calls[row];
    if (call) push({ kind: "tx", hash: call.hash, tick: call.tickNumber });
  };

  // Title, the 3-row KV when present, and the section header.
  const { win, offset } = windowOf(calls, selected, bodyRows - (meta ? 10 : 6));

  return (
    <Box flexDirection="column">
      <Box marginTop={1}>
        <Text>
          <Grad text={meta?.name || `contract #${index}`} />
          <Text dimColor>{`  #${index}`}</Text>
        </Text>
      </Box>
      {meta ? (
        <Box marginTop={1}>
          <KV
            rows={[
              ["state size", `${meta.stateSize} bytes`],
              ["construction", String(meta.constructionEpoch)],
              ["destruction", String(meta.destructionEpoch)],
            ]}
          />
        </Box>
      ) : null}
      <SectionHeader
        title="calls"
        detail={`${calls.length} in the recent window`}
        error={err}
        width={columns}
      />
      <SectionBody>
        {loading && calls.length === 0 ? (
          <Text color={theme.brand}>
            <Spinner label="reading contract calls" />
          </Text>
        ) : calls.length === 0 ? (
          <Text dimColor>no calls to this contract in the recent window</Text>
        ) : (
          <Table
            columns={CALL_COLS}
            rows={win.map((call) => [
              String(call.tickNumber),
              call.hash,
              call.source,
              fmtAmount(call.amount),
              String(call.inputType),
              fmtTime(call.timestamp),
            ])}
            selected={selected - offset}
            width={sectionTableWidth(columns)}
          />
        )}
      </SectionBody>
    </Box>
  );
}
