import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp } from "ink";
import { DEFAULT_RPC_BASE, LiteRpc } from "@qinit/core";
import { loadConfig } from "../../config";
import { advanceTo, haltedNodeError } from "./tick";
import { Header, Spinner, Bar, KV, theme } from "../../ui";
import { output, type CommandArguments } from "../../args";

// The rendered rows fuse a transition into one string ("3 → 4"), so --json keeps both ends as numbers.
export type EpochFacts = {
    epoch: number | null;
    fromEpoch: number | null;
    toEpoch: number | null;
    fromTick: number | null;
    tick: number | null;
    initialTick: number | null;
    epochLastTick: number | null;
    ticksLeft: number | null;
    duration: number | null;
};

export function epochJsonResult(action: string, facts: EpochFacts | null, error: string) {
    return {
        ok: !error,
        action,
        epoch: facts?.epoch ?? null,
        fromEpoch: facts?.fromEpoch ?? null,
        toEpoch: facts?.toEpoch ?? null,
        fromTick: facts?.fromTick ?? null,
        tick: facts?.tick ?? null,
        initialTick: facts?.initialTick ?? null,
        epochLastTick: facts?.epochLastTick ?? null,
        ticksLeft: facts?.ticksLeft ?? null,
        duration: facts?.duration ?? null,
        error: error || null,
    };
}

// The boundary transition fails the same way the tick advance does on a halted node.
async function advanceEpochOrFault(rpc: LiteRpc) {
    try {
        return await rpc.advanceEpoch();
    } catch (error) {
        throw (await haltedNodeError(rpc)) ?? error;
    }
}

const NO_EPOCH_FACTS: EpochFacts = {
    epoch: null,
    fromEpoch: null,
    toEpoch: null,
    fromTick: null,
    tick: null,
    initialTick: null,
    epochLastTick: null,
    ticksLeft: null,
    duration: null,
};

export function Epoch({ commandArgs }: { commandArgs: CommandArguments }) {
    const o = {
        rpc: commandArgs.get("rpc"),
        sub: commandArgs.positionals[0] ?? "",
    };
    const rpcBaseUrl = o.rpc || loadConfig().rpc || DEFAULT_RPC_BASE;
    const { exit } = useApp();
    const [rows, setRows] = useState<[string, string][] | null>(null);
    const [prog, setProg] = useState<{ from: number; cur: number; target: number } | null>(null);
    const [busy, setBusy] = useState("");
    const [err, setErr] = useState("");
    // A ref, not state: these never render, and the emit below must not read a batched-stale null.
    const factsRef = useRef<EpochFacts | null>(null);
    const action = o.sub || "show";

    useEffect(() => {
        (async () => {
            const rpc = new LiteRpc(rpcBaseUrl);
            try {
                const e = await rpc.epochInfo();
                if (o.sub === "advance") {
                    // 1) fast-tick to the last tick (progress); 2) let the node run its seamless transition.
                    const target = e.epochLastTick;
                    setProg({ from: e.tick, cur: e.tick, target });
                    await advanceTo(rpc, target, e.tick, (c) => setProg((p) => p && { ...p, cur: c }));
                    setProg(null);
                    setBusy("transitioning to the next epoch");
                    let r = await advanceEpochOrFault(rpc);
                    for (let i = 0; i < 3 && !r.switched; i++) r = await advanceEpochOrFault(rpc); // a few nudges if the boundary needs more ticks
                    if (!r.switched) throw new Error(`epoch did not switch (still ${r.toEpoch}, tick ${r.tick}) — node may have timed out`);
                    factsRef.current = {
                        ...NO_EPOCH_FACTS,
                        epoch: r.toEpoch,
                        fromEpoch: r.fromEpoch,
                        toEpoch: r.toEpoch,
                        fromTick: e.tick,
                        tick: r.tick,
                        initialTick: r.initialTick,
                    };
                    setRows([
                        ["epoch", `${r.fromEpoch} → ${r.toEpoch}`],
                        ["tick", `${e.tick} → ${r.tick}`],
                        ["new epoch start tick", String(r.initialTick)],
                    ]);
                } else if (o.sub) {
                    throw new Error(`unknown subcommand '${o.sub}' (use: advance)`);
                } else {
                    factsRef.current = {
                        ...NO_EPOCH_FACTS,
                        epoch: e.epoch,
                        tick: e.tick,
                        initialTick: e.initialTick,
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
            if (output.json) process.stdout.write(JSON.stringify(epochJsonResult(action, factsRef.current, err)) + "\n");
            process.exitCode = err ? 1 : 0;
            const t = setTimeout(() => exit(), 30);
            return () => clearTimeout(t);
        }
    }, [rows, err]);

    if (output.json) return null;

    const pct = prog && prog.target > prog.from ? (prog.cur - prog.from) / (prog.target - prog.from) : 1;
    return (
        <Box flexDirection="column">
            <Header cmd="epoch" />
            {prog && (
                <Box flexDirection="column">
                    <Text dimColor>fast-ticking to the epoch boundary</Text>
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
