import { useEffect, useState, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { resolve, basename } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { loadConfig, resolveCoreDir, resolveCompilerBackend } from "../../config";
import { STEPS, updateDeploymentSteps, type DeploymentEvent, type DeploymentStepState } from "../../ops/deploy";
import { deployProjectContracts, type ProjectDeployResult } from "../../ops/project-deploy";
import { nodeContracts } from "../../ops/node";
import { DEFAULT_RPC_BASE, LiteRpc } from "@qinit/core";
import { Header, StepRow, type StepState, Panel, theme } from "../../ui";
import type { CommandArguments } from "../../args";
import { parseCallees } from "../../contracts/callees";
import { parseContractSlot } from "../../contracts/registry";

export function Dev({ commandArgs }: { commandArgs: CommandArguments }) {
    const { exit } = useApp();
    const cfg = loadConfig();
    const rpcBaseUrl = commandArgs.get("rpc") ?? cfg.rpc ?? DEFAULT_RPC_BASE;
    const contractPath = resolve(commandArgs.get("contract") ?? commandArgs.positionals[0] ?? cfg.contract ?? "fixtures/Counter.h");
    const contractName = commandArgs.get("contract-name") ?? cfg.contractName ?? basename(contractPath).replace(/\.[^.]+$/, "");
    const dynCallees = parseCallees(commandArgs.getAll("callee"));
    const seed = commandArgs.get("seed");
    const skipVerify = commandArgs.has("skip-verify");
    const compiler = resolveCompilerBackend(commandArgs.get("compiler"));
    const requestedSlot = commandArgs.get("slot") ?? cfg.slot;
    const slotOverride = requestedSlot === undefined ? undefined : parseContractSlot(requestedSlot);
    let core = "",
        coreErr = "";
    try {
        core = resolveCoreDir(commandArgs.get("core-dir"), cfg.coreDir);
    } catch (e: any) {
        coreErr = String(e?.message ?? e);
    }

    const [steps, setSteps] = useState<Record<string, DeploymentStepState>>({});
    const [notes, setNotes] = useState<string[]>([]);
    const [result, setResult] = useState<ProjectDeployResult | null>(null);
    const [contracts, setContracts] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [runs, setRuns] = useState(0);
    const [tick, setTick] = useState<number | null>(null);
    const busyRef = useRef(false);
    const pending = useRef(false);

    const emit = (e: DeploymentEvent) => {
        if ("note" in e) {
            setNotes((n) => [...n, e.note]);
            return;
        }
        setSteps((steps) => updateDeploymentSteps(steps, e));
    };

    const redeploy = async () => {
        if (busyRef.current) {
            pending.current = true;
            return;
        }
        busyRef.current = true;
        setBusy(true);
        setSteps({});
        setNotes([]);
        setResult(null);
        try {
            setResult(
                await deployProjectContracts(
                    {
                        projectRoot: process.cwd(),
                        contractPath,
                        name: contractName,
                        core,
                        rpcBaseUrl: rpcBaseUrl,
                        seed,
                        explicitCallees: dynCallees,
                        slotOverride,
                        skipVerify,
                        compiler,
                    },
                    emit,
                ),
            );
        } catch (e: any) {
            setNotes((n) => [...n, "ERROR: " + String(e?.message ?? e)]);
            setResult({ ok: false, deployments: [], error: String(e?.message ?? e) });
        }
        try {
            setContracts(await nodeContracts(rpcBaseUrl));
        } catch {}
        setRuns((n) => n + 1);
        busyRef.current = false;
        setBusy(false);
        if (pending.current) {
            pending.current = false;
            redeploy();
        }
    };

    useEffect(() => {
        if (coreErr) return;
        redeploy();
        // Poll mtimes (fs.watch doesn't fire in the --compile binary; a timer does).
        const contractHeaders = (directory: string): string[] => {
            try {
                return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
                    const path = resolve(directory, entry.name);
                    if (entry.isDirectory()) {
                        return contractHeaders(path);
                    }
                    return entry.isFile() && entry.name.endsWith(".h") ? [path] : [];
                });
            } catch {
                return [];
            }
        };
        const watchedFiles = () => [
            ...new Set([contractPath, ...contractHeaders(resolve("contracts")), ...Object.values(dynCallees).map((callee) => callee.header)]),
        ];
        const mtime = (f: string) => {
            try {
                return statSync(f).mtimeMs;
            } catch {
                return 0;
            }
        };
        const seen = new Map(watchedFiles().map((file) => [file, mtime(file)]));
        let t: ReturnType<typeof setTimeout>;
        const iv = setInterval(() => {
            const current = new Map(watchedFiles().map((file) => [file, mtime(file)]));
            const changed = current.size !== seen.size || [...current].some(([file, modifiedAt]) => seen.get(file) !== modifiedAt);
            if (changed) {
                seen.clear();
                for (const [file, modifiedAt] of current) {
                    seen.set(file, modifiedAt);
                }
                clearTimeout(t);
                t = setTimeout(redeploy, 300);
            }
        }, 700);
        return () => {
            clearInterval(iv);
            clearTimeout(t);
        };
    }, []);
    // Live node heartbeat — drives the tick counter + up/down dot in the status card.
    useEffect(() => {
        const rpc = new LiteRpc(rpcBaseUrl);
        const ping = async () => {
            try {
                const tickInfo = await rpc.tickInfo();
                setTick(tickInfo.tick);
            } catch {
                setTick(null);
            }
        };
        ping();
        const iv = setInterval(ping, 1500);
        return () => clearInterval(iv);
    }, []);
    useInput(
        (input, key) => {
            if (input === "q" || (key.ctrl && input === "c")) exit();
        },
        { isActive: !!process.stdin.isTTY },
    );
    // A missing core checkout is fatal, so the watch session reports failure when it ends.
    useEffect(() => {
        if (coreErr) process.exitCode = 1;
    }, [coreErr]);
    // The session reports its last redeploy. `result` is null only mid-rebuild, which holds the
    // previous outcome rather than flickering to success.
    useEffect(() => {
        if (result) process.exitCode = result.ok ? 0 : 1;
    }, [result]);

    if (coreErr)
        return (
            <Box flexDirection="column">
                <Header cmd="dev" />
                <Panel title="no core headers" color={theme.err}>
                    <Text>{coreErr}</Text>
                </Panel>
            </Box>
        );

    const ok = result?.ok;
    const runNo = busy ? runs + 1 : runs;
    const lastText = result ? (ok ? "armed ✓" : `failed: ${result.reason ?? result.error ?? "?"}`) : busy ? "deploying…" : "idle";
    const lastColor = ok ? theme.ok : result ? theme.err : busy ? theme.info : theme.mute;
    const live = tick != null;
    const pipeColor = busy ? theme.info : ok ? theme.ok : result ? theme.err : theme.info;
    const isErr = (n: string) => /^(✗|⚠|ERROR)/.test(n);

    return (
        <Box flexDirection="column">
            <Header cmd="dev" />

            <Panel title="watch" color={theme.brand}>
                <Text>
                    <Text bold color={theme.accent}>
                        ◆ {contractName}
                    </Text>
                    {"   "}
                    <Text dimColor>{basename(contractPath)}</Text>
                </Text>
                <Box>
                    <Text>
                        run <Text bold>#{runNo}</Text>
                        {"   "}
                    </Text>
                    <Text bold color={lastColor}>
                        {lastText}
                    </Text>
                    <Text dimColor>{"   ·   "}</Text>
                    <Text color={live ? theme.ok : theme.err}>{live ? "●" : "○"}</Text>
                    <Text dimColor> {live ? `tick ${tick}` : "node down"}</Text>
                </Box>
                <Text dimColor>
                    rpc {rpcBaseUrl.replace(/^https?:\/\//, "")}
                    {"   ·   "}
                    <Text bold color={theme.accent}>
                        q
                    </Text>{" "}
                    quit
                </Text>
            </Panel>

            <Box marginTop={1}>
                <Panel title={busy ? `run #${runNo}  …` : "pipeline"} color={pipeColor}>
                    {STEPS.map(({ key, label }) => {
                        const s = steps[key] ?? { state: "pending" as StepState };
                        return <StepRow key={key} state={s.state} label={label} detail={s.detail} pct={s.pct} elapsedMs={s.elapsedMs} />;
                    })}
                </Panel>
            </Box>

            {notes.length > 0 && (
                <Box marginTop={1}>
                    <Panel title="notes" color={theme.warn}>
                        {notes.slice(-4).map((n, i) => (
                            <Text key={i} color={isErr(n) ? theme.err : undefined} dimColor={!isErr(n)}>
                                {n}
                            </Text>
                        ))}
                    </Panel>
                </Box>
            )}

            <Box marginTop={1}>
                <Panel title={`armed (${contracts.length})`} color={theme.info}>
                    {contracts.length ? (
                        contracts.map((c, i) => (
                            <Text key={i}>
                                <Text color={theme.ok}>●</Text> {c}
                            </Text>
                        ))
                    ) : (
                        <Text dimColor>none yet — deploy to arm</Text>
                    )}
                </Panel>
            </Box>
        </Box>
    );
}
