import { useEffect, useState } from "react";
import { Box, useApp } from "ink";
import { closeSync, existsSync, openSync, readFileSync, readSync, unwatchFile, watchFile } from "node:fs";
import { resolve } from "node:path";
import { Header, Spinner, Panel, KV, Status, theme } from "../../ui";
import { readCurrent, LiteRpc } from "@qinit/core";
import { DEFAULT_RUNTIME, assertLoopbackRpc, loadConfig, resolveRpc, savedRuntime } from "../../config";
import {
    activeNodeScratchDir,
    ensureNodeBinary,
    killNode,
    liveNodePid,
    logFile,
    nodeAlive,
    nodeStatus,
    runtimeLabel,
    scratchForRpc,
    versionDrift,
} from "../../ops/node";
import { describeFault } from "../../ops/fault";
import { invalidArgs, output, type CommandArguments } from "../../args";
const dlLabel = (recv: number, total: number) =>
    total ? `downloading node ${(recv / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB` : `downloading node ${(recv / 1e6).toFixed(0)} MB`;

type Line = { t: string; ok?: boolean };
// The rendered rows fuse values into display strings, so --json reports the facts each sub-path actually saw rather than reparsing them back out.
type NodeFacts = Record<string, unknown>;
// `raw` marks a result already written to stdout as plain text, which a panel around it would only corrupt.
type State =
    | { phase: "run"; spin: string }
    | { phase: "done"; title: string; color: string; lines: Line[]; rows?: [string, string][]; facts?: NodeFacts; raw?: boolean };

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

/** the last `count` lines of a log, and how many bytes were read so a follower knows where to resume. */
export function logTail(path: string, count: number): { lines: string[]; bytes: number } {
    const data = readFileSync(path);
    // core's node ends its lines in CRLF
    const all = data.toString("utf8").split(/\r?\n/);
    // a log ends in a newline, which split reports as one empty line more than was written
    if (all.at(-1) === "") all.pop();
    return { lines: count > 0 ? all.slice(-count) : [], bytes: data.length };
}

export function Node({ commandArgs, subcommand }: { commandArgs: CommandArguments; subcommand?: string }) {
    const { exit } = useApp();
    const sub = subcommand ?? commandArgs.positionals[0] ?? "status";
    const rpcBaseUrl = resolveRpc(commandArgs.get("rpc"), loadConfig());
    const [s, setS] = useState<State>({ phase: "run", spin: sub });

    useEffect(() => {
        (async () => {
            const lines: Line[] = [];
            const add = (text: string, ok?: boolean) => lines.push({ t: text, ok });
            try {
                // the node this command names: --scratch-dir wins, then the launch index for --rpc, and
                // only a node this machine never launched falls back to the global pointer.
                const target = commandArgs.get("scratch-dir") ? resolve(commandArgs.get("scratch-dir")!) : (scratchForRpc(rpcBaseUrl) ?? activeNodeScratchDir());
                const log = logFile(target);

                if (sub === "status") {
                    const st = await nodeStatus(rpcBaseUrl);
                    const pid = liveNodePid(target) ?? null;
                    const where: [string, string][] = [
                        ["rpc", rpcBaseUrl],
                        ["pid", pid === null ? "untracked" : String(pid)],
                    ];
                    if (existsSync(log)) where.push(["log", log]);
                    const whereFacts = { rpc: rpcBaseUrl, pid, log: existsSync(log) ? log : null };
                    if (!st.up) {
                        add("rpc: down (node not reachable)", false);
                        const saved = savedRuntime();
                        const runtime = saved ?? DEFAULT_RUNTIME;
                        setS({
                            phase: "done",
                            title: "node down",
                            color: theme.err,
                            lines,
                            rows: [["runtime", `${runtime} (${saved ? "saved" : "default"}, not running)`], ...where],
                            facts: { up: false, runtime, ...whereFacts },
                        });
                        return;
                    }
                    const runtime = (await new LiteRpc(rpcBaseUrl).whoami()).backend;
                    if (st.fault) {
                        add(await describeFault(new LiteRpc(rpcBaseUrl), st.fault), false);
                    } else {
                        add(st.ticking ? "rpc: up, ticking" : "rpc: up, not yet ticking", st.ticking);
                    }
                    const rows: [string, string][] = [
                        ["runtime", runtimeLabel(runtime)],
                        ...where,
                        ["tick", String(st.tick)],
                        ["epoch", String(st.epoch)],
                        ["contract slots", `${st.armed} armed / ${st.slotCount}`],
                    ];
                    let epochLastTick: number | null = null;
                    let ticksLeft: number | null = null;
                    try {
                        const ei = await new LiteRpc(rpcBaseUrl).epochInfo();
                        epochLastTick = ei.epochLastTick;
                        ticksLeft = ei.ticksLeft;
                        rows.splice(rows.length - 1, 0, ["epoch last tick", `${ei.epochLastTick}  (${ei.ticksLeft} left)`]);
                    } catch {}
                    if (st.contracts.length) rows.push(["contracts", st.contracts.join(", ")]);
                    const cur = readCurrent();
                    if (cur?.headersVersion || cur?.nodeVersion)
                        rows.push(["synced", `headers ${cur?.headersVersion ?? "—"} · node ${cur?.nodeVersion ?? "—"}`]);
                    if (versionDrift(cur)) add("⚠ headers/node version drift — run `qinit setup`", false);
                    setS({
                        phase: "done",
                        title: st.ticking ? "node up ✓" : "node up (idle)",
                        color: st.ticking ? theme.ok : theme.warn,
                        lines,
                        rows,
                        facts: {
                            up: true,
                            runtime,
                            ...whereFacts,
                            ticking: st.ticking,
                            fault: st.fault,
                            tick: st.tick,
                            epoch: st.epoch,
                            epochLastTick,
                            ticksLeft,
                            armed: st.armed,
                            slotCount: st.slotCount,
                            contracts: st.contracts,
                            headersVersion: cur?.headersVersion ?? null,
                            nodeVersion: cur?.nodeVersion ?? null,
                            versionDrift: versionDrift(cur),
                        },
                    });
                    return;
                }

                if (sub === "stop") {
                    assertLoopbackRpc(rpcBaseUrl);
                    if (!nodeAlive(target)) {
                        add("no node running", true);
                        setS({ phase: "done", title: "stopped", color: theme.info, lines, facts: { stopped: true, wasRunning: false } });
                        return;
                    }
                    // Trust the pid outcome: a rescan by image name still lists the process mid-teardown on Windows.
                    const dead = await killNode(target);
                    add(dead ? "node stopped" : "node still alive (kill failed)", dead);
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

                if (sub === "logs") {
                    const follow = commandArgs.has("follow");
                    const count = Number(commandArgs.get("lines") ?? 50);
                    if (!Number.isInteger(count) || count < 0) invalidArgs("--lines must be a whole number, 0 or more");
                    if (follow && output.json) invalidArgs("--follow streams text and cannot be combined with --json");
                    if (!existsSync(log)) {
                        add(`no node log at ${log} (a node started here writes it; --scratch-dir names another node's directory)`, false);
                        setS({ phase: "done", title: "node logs", color: theme.err, lines, facts: { log } });
                        return;
                    }
                    const tail = logTail(log, count);
                    if (output.json) {
                        setS({ phase: "done", title: "", color: "", lines, facts: { log, logLines: tail.lines } });
                        return;
                    }
                    // a reader that closes the pipe (`| head`) has what it asked for
                    process.stdout.on("error", (error: NodeJS.ErrnoException) => process.exit(error.code === "EPIPE" ? 0 : 1));
                    if (tail.lines.length) process.stdout.write(tail.lines.join("\n") + "\n");
                    if (!follow) {
                        setS({ phase: "done", title: "", color: "", lines, raw: true });
                        return;
                    }
                    let offset = tail.bytes;
                    watchFile(log, { interval: 250 }, (current) => {
                        if (current.nlink === 0) {
                            unwatchFile(log);
                            process.stderr.write(`qinit: ${log} was removed (the node's directory was cleared)\n`);
                            setS({ phase: "done", title: "", color: "", lines, raw: true });
                            return;
                        }
                        // a restarted node starts its log over, so a shorter file is read from the top
                        if (current.size < offset) offset = 0;
                        if (current.size === offset) return;
                        const chunk = Buffer.alloc(current.size - offset);
                        // opened per read: a handle held across polls blocks windows from clearing the directory
                        const file = openSync(log, "r");
                        try {
                            offset += readSync(file, chunk, 0, chunk.length, offset);
                        } finally {
                            closeSync(file);
                        }
                        process.stdout.write(chunk);
                    });
                    return;
                }

                add(`unknown: node ${sub} (run|status|stop|get|logs)`, false);
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

    // logs writes plain text itself, so it draws nothing unless it has a failure to explain
    if (output.json || (sub === "logs" && (s.phase === "run" || s.raw))) return null;

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
