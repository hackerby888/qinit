import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp } from "ink";
import { DEFAULT_RPC_BASE, LiteRpc, RpcTimeoutError } from "@qinit/core";
import { loadConfig } from "../../config";
import { describeFault, readFault } from "../../ops/fault";
import { Header, Spinner, Bar, KV, theme } from "../../ui";
import { output, type CommandArguments } from "../../args";

// `qinit tick` shows the current-epoch tick window; `qinit tick advance <n>` drives system.tick toward a target via bounded advance-tick calls.
export async function advanceTo(rpc: LiteRpc, target: number, from: number, onProgress: (cur: number) => void): Promise<{ cur: number; capped: boolean }> {
    let cur = from,
        stalls = 0,
        capped = false,
        chunk = FIRST_CHUNK_TICKS;
    while (cur < target) {
        const startedAt = Date.now();
        const r = await advanceChunk(rpc, Math.min(chunk, target - cur), cur);
        chunk = nextChunk(chunk, Date.now() - startedAt);
        capped = r.cappedAtEpochEnd;
        if (r.reached <= cur) {
            if (++stalls >= 3) break;
        } else stalls = 0;
        cur = r.reached;
        onProgress(cur);
        if (capped && cur >= r.epochLastTick) break;
    }
    return { cur, capped };
}

// A tick costs whatever the deployed contracts make it cost, so the span is sized from the last round trip: inside the client's timeout, but not a crawl.
const FIRST_CHUNK_TICKS = 32;
const CHUNK_TARGET_MS = 3000;

function nextChunk(chunk: number, elapsedMs: number): number {
    const scaled = elapsedMs > 0 ? (chunk * CHUNK_TARGET_MS) / elapsedMs : chunk * 2;

    return Math.max(1, Math.min(2048, Math.round(scaled)));
}

// A halted node answers the advance route with 503, or on core never at all, and the tick number alone says nothing — so the fault route is asked first.
export async function advanceChunk(rpc: LiteRpc, span: number, from = 0) {
    try {
        return await rpc.advanceTick(span);
    } catch (error) {
        const halted = await haltedNodeError(rpc);
        if (halted) throw halted;
        if (error instanceof RpcTimeoutError) return settleAfterTimeout(rpc, from, span);
        throw error;
    }
}

const SETTLE_POLL_MS = 500;
const SETTLE_BUDGET_MS = 20_000;

// A timed-out advance usually ran anyway: follow the tick until it reaches the target or stops moving.
export async function settleAfterTimeout(rpc: LiteRpc, from: number, span: number, pollMs = SETTLE_POLL_MS, budgetMs = SETTLE_BUDGET_MS) {
    const target = from + span;
    const deadline = Date.now() + budgetMs;
    let last = from;
    let stable = 0;
    for (;;) {
        const tick = (await rpc.tickInfo()).tick;
        stable = tick === last ? stable + 1 : 0;
        last = Math.max(last, tick);
        if (last >= target || (last > from && stable >= 2) || Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, pollMs));
    }
    const epoch = await rpc.epochInfo();
    return { from, requested: span, target, reached: last, epochLastTick: epoch.epochLastTick, cappedAtEpochEnd: last >= epoch.epochLastTick };
}

export async function haltedNodeError(rpc: LiteRpc): Promise<Error | null> {
    try {
        const fault = await readFault(rpc);
        return fault ? new Error(await describeFault(rpc, fault)) : null;
    } catch {
        return null;
    }
}

// The rendered rows are display strings (tick reads 120 → 145 after an advance), so --json reports the numbers each sub-path actually saw.
export type TickFacts = {
    epoch: number | null;
    tick: number | null;
    fromTick: number | null;
    advanced: number | null;
    capped: boolean | null;
    epochLastTick: number | null;
    ticksLeft: number | null;
    duration: number | null;
    tickMs: number | null;
};

export function tickJsonResult(action: string, facts: TickFacts | null, error: string) {
    return {
        ok: !error,
        action,
        epoch: facts?.epoch ?? null,
        tick: facts?.tick ?? null,
        fromTick: facts?.fromTick ?? null,
        advanced: facts?.advanced ?? null,
        capped: facts?.capped ?? null,
        epochLastTick: facts?.epochLastTick ?? null,
        ticksLeft: facts?.ticksLeft ?? null,
        duration: facts?.duration ?? null,
        tickMs: facts?.tickMs ?? null,
        error: error || null,
    };
}

const NO_TICK_FACTS: TickFacts = {
    epoch: null,
    tick: null,
    fromTick: null,
    advanced: null,
    capped: null,
    epochLastTick: null,
    ticksLeft: null,
    duration: null,
    tickMs: null,
};

export function Tick({ commandArgs }: { commandArgs: CommandArguments }) {
    const o = {
        rpc: commandArgs.get("rpc"),
        sub: commandArgs.positionals[0] ?? "",
        arg: commandArgs.positionals[1] ?? "",
    };
    const rpcBaseUrl = o.rpc || loadConfig().rpc || DEFAULT_RPC_BASE;
    const { exit } = useApp();
    const [rows, setRows] = useState<[string, string][] | null>(null);
    const [prog, setProg] = useState<{
        from: number;
        cur: number;
        target: number;
        label: string;
    } | null>(null);
    const [busy, setBusy] = useState("");
    const [err, setErr] = useState("");
    // A ref, not state: these never render, and the emit below must not read a batched-stale null.
    const factsRef = useRef<TickFacts | null>(null);
    const action = o.sub === "last" ? "advance-to-last" : o.sub || "show";

    useEffect(() => {
        (async () => {
            const rpc = new LiteRpc(rpcBaseUrl);
            try {
                if (o.sub === "rate") {
                    // The simulator can change its tick rate without restarting.
                    // no argument reports; `Number("")` is 0, so without this a read-shaped command wrote.
                    if (!o.arg) {
                        const current = await rpc.tickInfo();
                        const tickMs = Number((current as { tickMs?: unknown }).tickMs ?? NaN);
                        factsRef.current = { ...NO_TICK_FACTS, tickMs: Number.isFinite(tickMs) ? tickMs : null };
                        setRows([["tick rate", Number.isFinite(tickMs) ? `${tickMs} ms/tick${tickMs === 0 ? "  (fastest)" : ""}` : "not reported by this node"]]);
                        setProg(null);
                        setBusy("");
                        return;
                    }
                    const ms = Number(o.arg);
                    if (!Number.isInteger(ms) || ms < 0) throw new Error(`rate <ms>: '${o.arg}' is not a non-negative integer`);
                    const r = await rpc.setTickMs(ms);
                    factsRef.current = { ...NO_TICK_FACTS, tickMs: r.tickMs };
                    setRows([["tick rate", `${r.tickMs} ms/tick${r.tickMs === 0 ? "  (fastest)" : ""}`]]);
                    setProg(null);
                    setBusy("");
                    return;
                }
                const e = await rpc.epochInfo();
                if (o.sub === "advance") {
                    const n = Number(o.arg || "1");
                    if (!Number.isInteger(n) || n < 1) throw new Error(`advance <n>: '${o.arg}' is not a positive integer`);
                    const target = Math.min(e.tick + n, e.epochLastTick);
                    setProg({
                        from: e.tick,
                        cur: e.tick,
                        target,
                        label: `advancing ${n} tick${n === 1 ? "" : "s"}`,
                    });
                    const { cur, capped } = await advanceTo(rpc, target, e.tick, (c) => setProg((p) => p && { ...p, cur: c }));
                    factsRef.current = {
                        ...NO_TICK_FACTS,
                        epoch: e.epoch,
                        tick: cur,
                        fromTick: e.tick,
                        advanced: cur - e.tick,
                        capped,
                        epochLastTick: e.epochLastTick,
                    };
                    setRows([
                        ["tick", `${e.tick} → ${cur}`],
                        ["advanced", String(cur - e.tick)],
                        ...(capped ? [["note", `capped at epoch last tick ${e.epochLastTick} — use 'qinit epoch advance' to cross`] as [string, string]] : []),
                    ]);
                } else if (o.sub === "advance-to-last" || o.sub === "last") {
                    // A gap that does not parse used to clamp to 0 and report success without advancing.
                    const gap = Number(o.arg || "3");
                    if (!Number.isInteger(gap) || gap < 0) throw new Error(`advance-to-last [gap]: '${o.arg}' is not a non-negative integer`);
                    const target = Math.max(e.tick, e.epochLastTick - gap);
                    setProg({
                        from: e.tick,
                        cur: e.tick,
                        target,
                        label: `advancing to last tick − ${gap}`,
                    });
                    const { cur, capped } = await advanceTo(rpc, target, e.tick, (c) => setProg((p) => p && { ...p, cur: c }));
                    factsRef.current = {
                        ...NO_TICK_FACTS,
                        epoch: e.epoch,
                        tick: cur,
                        fromTick: e.tick,
                        advanced: cur - e.tick,
                        capped,
                        epochLastTick: e.epochLastTick,
                    };
                    setRows([
                        ["tick", `${e.tick} → ${cur}`],
                        ["epoch last tick", String(e.epochLastTick)],
                        ["epoch", String(e.epoch)],
                    ]);
                } else if (o.sub) {
                    throw new Error(`unknown subcommand '${o.sub}' (use: advance <n> | advance-to-last [gap] | rate <ms>)`);
                } else {
                    factsRef.current = {
                        ...NO_TICK_FACTS,
                        epoch: e.epoch,
                        tick: e.tick,
                        epochLastTick: e.epochLastTick,
                        ticksLeft: e.ticksLeft,
                        duration: e.duration,
                    };
                    setRows([
                        ["epoch", String(e.epoch)],
                        ["tick", String(e.tick)],
                        ["epoch last tick", String(e.epochLastTick)],
                        ["ticks left", String(e.ticksLeft)],
                        ["epoch length", `${e.duration} ticks`],
                    ]);
                }
            } catch (e: any) {
                setErr(String(e?.message ?? e));
            }
            setProg(null);
            setBusy("");
        })();
    }, []);
    useEffect(() => {
        if (rows || err) {
            if (output.json) process.stdout.write(JSON.stringify(tickJsonResult(action, factsRef.current, err)) + "\n");
            process.exitCode = err ? 1 : 0;
            const t = setTimeout(() => exit(), 30);
            return () => clearTimeout(t);
        }
    }, [rows, err]);

    if (output.json) return null;

    const pct = prog && prog.target > prog.from ? (prog.cur - prog.from) / (prog.target - prog.from) : 1;
    return (
        <Box flexDirection="column">
            <Header cmd="tick" />
            {prog && (
                <Box flexDirection="column">
                    <Text dimColor>{prog.label}</Text>
                    <Text>
                        <Bar pct={pct} />{" "}
                        <Text dimColor>
                            tick {prog.cur} / {prog.target}
                        </Text>
                    </Text>
                </Box>
            )}
            {busy && !prog && <Spinner label={busy} />}
            {err && <Text color={theme.err}>ERROR: {err}</Text>}
            {rows && (
                <Box marginTop={1}>
                    <KV rows={rows} />
                </Box>
            )}
        </Box>
    );
}
