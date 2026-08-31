import { useEffect, useState } from "react";
import { Box, useApp } from "ink";
import { Header, Spinner, Panel, KV, Status, theme } from "../../ui";
import { DEFAULT_RPC_BASE, readCurrent, LiteRpc } from "@qinit/core";
import { ensureNodeBinary, killNode, nodeAlive, nodeStatus } from "../../ops/node";
import { output, type CommandArguments } from "../../args";
const dlLabel = (recv: number, total: number) =>
    total ? `downloading node ${(recv / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB` : `downloading node ${(recv / 1e6).toFixed(0)} MB`;

type Line = { t: string; ok?: boolean };
// The rendered rows fuse values into display strings — `epoch last tick` carries `ticksLeft` in
// parentheses and `contracts` is joined — so --json reports the facts each sub-path actually saw.
type NodeFacts = Record<string, unknown>;
type State = { phase: "run"; spin: string } | { phase: "done"; title: string; color: string; lines: Line[]; rows?: [string, string][]; facts?: NodeFacts };

// Absent keys mean "this sub-path never looked", the way a call without --trace omits its trace keys.
export function nodeJsonResult(action: string, lines: Line[], facts: NodeFacts | undefined) {
    const failed = lines.find((line) => line.ok === false);
    return {
        ok: !failed,
        action,
        lines: lines.map((line) => ({ text: line.t, ok: line.ok ?? null })),
        ...(facts ?? {}),
        error: failed ? failed.t : null,
    };
}

export function Node({ commandArgs, subcommand }: { commandArgs: CommandArguments; subcommand?: string }) {
    const { exit } = useApp();
    const sub = subcommand ?? commandArgs.positionals[0] ?? "status";
    const rpcBaseUrl = commandArgs.get("rpc") || DEFAULT_RPC_BASE;
    const [s, setS] = useState<State>({ phase: "run", spin: sub });

    useEffect(() => {
        (async () => {
            const lines: Line[] = [];
            const add = (text: string, ok?: boolean) => lines.push({ t: text, ok });
            try {
                if (sub === "status") {
                    const st = await nodeStatus(rpcBaseUrl);
                    if (!st.up) {
                        add("rpc: down (node not reachable)", false);
                        setS({ phase: "done", title: "node down", color: theme.err, lines, facts: { up: false } });
                        return;
                    }
                    add(st.ticking ? "rpc: up, ticking" : "rpc: up, not yet ticking", st.ticking);
                    const rows: [string, string][] = [
                        ["tick", String(st.tick)],
                        ["epoch", String(st.epoch)],
                        ["dyn slots", `${st.armed} armed / ${st.slotCount}`],
                    ];
                    let epochLastTick: number | null = null;
                    let ticksLeft: number | null = null;
                    try {
                        const ei = await new LiteRpc(rpcBaseUrl).epochInfo();
                        epochLastTick = ei.epochLastTick;
                        ticksLeft = ei.ticksLeft;
                        rows.splice(2, 0, ["epoch last tick", `${ei.epochLastTick}  (${ei.ticksLeft} left)`]);
                    } catch {}
                    if (st.contracts.length) rows.push(["contracts", st.contracts.join(", ")]);
                    const cur = readCurrent();
                    if (cur?.headersVersion || cur?.nodeVersion)
                        rows.push(["synced", `headers ${cur?.headersVersion ?? "—"} · node ${cur?.nodeVersion ?? "—"}`]);
                    if (cur?.headersVersion && cur?.nodeVersion && cur.headersVersion !== cur.nodeVersion)
                        add("⚠ headers/node version drift — run `qinit setup`", false);
                    setS({
                        phase: "done",
                        title: st.ticking ? "node up ✓" : "node up (idle)",
                        color: st.ticking ? theme.ok : theme.warn,
                        lines,
                        rows,
                        facts: {
                            up: true,
                            ticking: st.ticking,
                            tick: st.tick,
                            epoch: st.epoch,
                            epochLastTick,
                            ticksLeft,
                            armed: st.armed,
                            slotCount: st.slotCount,
                            contracts: st.contracts,
                            headersVersion: cur?.headersVersion ?? null,
                            nodeVersion: cur?.nodeVersion ?? null,
                            versionDrift: Boolean(cur?.headersVersion && cur?.nodeVersion && cur.headersVersion !== cur.nodeVersion),
                        },
                    });
                    return;
                }

                if (sub === "stop") {
                    if (!nodeAlive()) {
                        add("no node running", true);
                        setS({ phase: "done", title: "stopped", color: theme.info, lines, facts: { stopped: true, wasRunning: false } });
                        return;
                    }
                    await killNode();
                    const dead = !nodeAlive();
                    add(dead ? "node stopped" : "node still alive (pkill failed)", dead);
                    setS({
                        phase: "done",
                        title: dead ? "stopped ✓" : "stop failed",
                        color: dead ? theme.ok : theme.err,
                        lines,
                        facts: { stopped: dead, wasRunning: true },
                    });
                    return;
                }

                if (sub === "get") {
                    const ref = commandArgs.get("ref");
                    setS({ phase: "run", spin: ref ? `fetching node ${ref}` : "resolving node" });
                    const { nodeBinaryPath, version, cached } = await ensureNodeBinary(ref, (rc, tt) => setS({ phase: "run", spin: dlLabel(rc, tt) }));
                    add(`node ${version} ${cached ? "reused" : "cached"}`, true);
                    setS({
                        phase: "done",
                        title: "node ready ✓",
                        color: theme.ok,
                        lines,
                        rows: [
                            ["version", version],
                            ["binary", nodeBinaryPath],
                        ],
                        facts: { version, binary: nodeBinaryPath, cached },
                    });
                    return;
                }

                add(`unknown: node ${sub} (run|status|stop|get)`, false);
                setS({ phase: "done", title: "node", color: theme.warn, lines });
            } catch (e: any) {
                add("ERROR: " + String(e?.message ?? e), false);
                setS({ phase: "done", title: "node " + sub + " failed", color: theme.err, lines });
            }
        })();
    }, []);
    useEffect(() => {
        if (s.phase === "done") {
            if (output.json) process.stdout.write(JSON.stringify(nodeJsonResult(sub, s.lines, s.facts)) + "\n");
            process.exitCode = s.lines.some((l) => l.ok === false) ? 1 : 0;
            exit();
        }
    }, [s, exit]);

    if (output.json) return null;

    return (
        <Box flexDirection="column">
            <Header cmd={`node ${sub}`} />
            {s.phase === "run" && <Spinner label={s.spin} />}
            {s.phase === "done" && (
                <Panel title={s.title} color={s.color}>
                    {s.lines.map((l, i) => (
                        <Status key={i} ok={l.ok} label={l.t} pad={0} />
                    ))}
                    {s.rows && s.rows.length > 0 && (
                        <Box marginTop={1}>
                            <KV rows={s.rows} />
                        </Box>
                    )}
                </Panel>
            )}
        </Box>
    );
}
