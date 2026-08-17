// Interactive chain explorer — a TUI port of core-lite's web explorer; this file is the navigation/
// key-handling shell around the views.
import { useEffect, useRef, useState } from "react";
import { Box, useApp, useInput } from "ink";
import { DEFAULT_RPC_BASE, LiteRpc } from "@qinit/core";
import { loadConfig, savedTheme, setSavedTheme } from "../../../config";
import { loadContractIdls, type ContractIdls } from "../../../contracts/idl-lookup";
import { Header, THEME_NAMES, applyTheme, useTerminalSize } from "../../../ui";
import { invalidArgs, output, type CommandArguments } from "../../../args";
import { Breadcrumb, CHROME_ROWS, ControlBar, controlBarRows, type Frame, type View } from "./chrome";
import { FindView, parseFindQuery } from "./find";
import { OverviewView } from "./overview";
import { TickView, TxView } from "./tick";
import { IdentityView } from "./identity";
import { ContractView, ContractsView } from "./contracts";
import { WalletView } from "./wallet";

export type { View } from "./chrome";
export { parseFindQuery };

const frameOf = (view: View): Frame => ({ view, selected: 0 });

// The argument is resolved by shape, exactly as the `/` prompt resolves what is typed in.
export function initialView(commandArgs: CommandArguments): View {
    const query = commandArgs.positionals[0];
    if (!query) {
        return { kind: "overview" };
    }

    const target = parseFindQuery(query);
    if (!target) {
        invalidArgs(`not a tick number, identity, or transaction hash: ${query}`);
    }

    return target;
}

export function Explorer({ commandArgs }: { commandArgs: CommandArguments }) {
    // The explorer is a live keyboard UI; there is no meaningful piped or structured form of it.
    if (output.json || !process.stdin.isTTY) {
        throw new Error("explorer is interactive — run it in a terminal (it has no --json or piped output)");
    }

    // Before the first hook, so an unresolvable argument is refused rather than half-rendered.
    const opening = initialView(commandArgs);

    const rpcBaseUrl = commandArgs.get("rpc") || loadConfig().rpc || DEFAULT_RPC_BASE;
    const { exit } = useApp();
    const rpc = useRef(new LiteRpc(rpcBaseUrl)).current;
    const { columns, rows } = useTerminalSize();

    const [stack, setStack] = useState<Frame[]>(() => [frameOf(opening)]);
    const [themeName, setThemeName] = useState(() => savedTheme() ?? "default");
    const [refreshToken, setRefreshToken] = useState(0);

    const top = stack[stack.length - 1];
    const view = top.view;
    // Derived, not state: the find view and the identity view without an id *are* prompts. Tracking this in
    // an effect instead would leave the first frame advertising keys the prompt has already taken.
    const searching = view.kind === "find" || (view.kind === "identity" && !view.id);

    // Contract names and IDLs, loaded once and reused across every view to label contract addresses and to
    // name and decode the calls made to them. Either can be missing without costing the other.
    const [contractNames, setContractNames] = useState<Map<number, string>>(new Map());
    const [contractIdls, setContractIdls] = useState<ContractIdls>(new Map());
    useEffect(() => {
        let alive = true;
        void (async () => {
            const [names, idls] = await Promise.allSettled([rpc.getContracts(), loadContractIdls(rpc)]);
            if (!alive) return;

            if (names.status === "fulfilled") {
                setContractNames(new Map(names.value.contracts.map((c) => [c.index, c.name])));
            }
            if (idls.status === "fulfilled") {
                setContractIdls(idls.value);
            }
        })();
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
            // The wallet is a multi-field form with its own esc, so the shell binds nothing there — and q/r are
            // legal seed characters that must not quit or refresh mid-typing.
            if (view.kind === "wallet") {
                return;
            }

            // esc is the only way out of the search; ink blanks `input` for escape, so the prompt never sees
            // this keypress.
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
            } else if (input === "4") {
                replaceRoot({ kind: "wallet" });
            } else if (input === "s" && view.kind === "identity" && view.id) {
                // Pushed, so esc returns to the identity the user was reading rather than to the overview.
                push({ kind: "wallet", to: view.id });
            } else if (input === "/") {
                // Pushed, not a new root: the prompt replaces itself with the hit, so esc lands back where / was
                // pressed rather than on the overview.
                push({ kind: "find" });
            } else if (input === "t") {
                const next = THEME_NAMES[(THEME_NAMES.indexOf(themeName) + 1) % THEME_NAMES.length];
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
                    setStack((s) => [...s.slice(0, -1), frameOf({ kind: "tick", tick: Math.max(0, view.tick + step) })]);
                } else if (view.kind === "contracts") {
                    setStack((s) => [...s.slice(0, -1), frameOf({ kind: "contracts", page: Math.max(0, view.page + step) })]);
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
        contractIdls,
        push,
        rowCount,
        openRow,
        bodyRows: Math.max(4, rows - 1 - CHROME_ROWS - controlBarRows(view, stack.length, columns, searching)),
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
                ) : view.kind === "find" ? (
                    <FindView {...shared} onSubmit={(target) => setStack((s) => [...s.slice(0, -1), frameOf(target)])} />
                ) : view.kind === "tick" ? (
                    <TickView {...shared} tick={view.tick} />
                ) : view.kind === "tx" ? (
                    <TxView {...shared} hash={view.hash} tick={view.tick} />
                ) : view.kind === "identity" ? (
                    <IdentityView {...shared} id={view.id} onSubmit={(id) => setStack((s) => [...s.slice(0, -1), frameOf({ kind: "identity", id })])} />
                ) : view.kind === "contracts" ? (
                    <ContractsView {...shared} page={view.page} />
                ) : view.kind === "wallet" ? (
                    <WalletView {...shared} rpcBaseUrl={rpcBaseUrl} to={view.to} onExit={pop} />
                ) : (
                    <ContractView {...shared} index={view.index} />
                )}
            </Box>
            <ControlBar
                view={view}
                rootView={stack[0].view}
                depth={stack.length}
                themeName={themeName}
                rpcBaseUrl={rpcBaseUrl}
                columns={columns}
                searching={searching}
            />
        </Box>
    );
}
