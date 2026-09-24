import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { resolve, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { loadConfig, projectContractName, projectContractPath, resolveCompilerBackend, resolveCoreDir, resolveRuntime, resolveRpc } from "../../config";
import type { DeploymentEvent } from "../../ops/deploy";
import { deployProjectContracts } from "../../ops/project-deploy";
import { activeNodeScratchDir, ensureNodeBinary, killNode, launchNode, scratchForRpc, waitTicking } from "../../ops/node";
import { portFromRpc } from "../../ops/serve";
import { ensureSpecProject, installSpecTypes } from "../../ops/spec-project";
import { DEFAULT_FUNDED_SEED, LiteRpc } from "@qinit/core";
import { loadCoreWasmSlotLayout } from "@qinit/core/wasm/slot-layout-node";
import { testRuntimeSource, generateClient, extractIdl } from "@qinit/build";
import { loadQpiHeader } from "@qinit/compiler";
import { EngineServer } from "@qinit/engine/server";
import { testRunLogSink } from "../../ops/test-log";
import { VirtualNode } from "@qinit/engine";
import { Header, Spinner, Panel, KV, Status, theme } from "../../ui";
import { parseCallees } from "../../contracts/callees";
import { parseContractSlot } from "../../contracts/registry";
import { output, type CommandArguments } from "../../args";
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STEP_LABEL: Record<string, string> = {
    tick: "node",
    slot: "slot",
    build: "build",
    upload: "upload",
    deploy: "deploy",
    confirm: "confirm",
};

// Two tick samples => is a node already advancing at this rpc?
async function isTicking(rpcBaseUrl: string): Promise<boolean> {
    const rpc = new LiteRpc(rpcBaseUrl);
    try {
        const a = (await rpc.tickInfo()).tick;
        await sleep(2500);
        const b = (await rpc.tickInfo()).tick;
        return b > a;
    } catch {
        return false;
    }
}

interface Line {
    label: string;
    ok?: boolean | null;
    detail?: string;
}
type State =
    | { phase: "setup"; spin: string; lines: Line[] }
    | { phase: "testing"; lines: Line[] }
    | { phase: "done"; lines: Line[]; ok: boolean; output: string; rows: [string, string][] };

export function Test({ commandArgs }: { commandArgs: CommandArguments }) {
    const { exit } = useApp();
    const cfg = loadConfig();
    const root = process.cwd();
    const rpcBaseUrl = resolveRpc(commandArgs.get("rpc"), cfg);
    // resolved at render for the names below; a missing contract is reported as the first step rather than a crash.
    let contractPath = "",
        contractName = "",
        contractErr = "";
    try {
        const requested = commandArgs.get("contract") ?? commandArgs.positionals[0];
        contractPath = projectContractPath("test", requested, cfg);
        contractName = projectContractName(contractPath, { contractName: commandArgs.get("contract-name") }, cfg, !requested);
    } catch (e: any) {
        contractErr = String(e?.message ?? e);
    }
    const requestedCompiler = commandArgs.get("compiler");
    const requestedSlot = commandArgs.get("slot") ?? cfg.slot;
    const explicitCallees = parseCallees(commandArgs.getAll("callee"));
    const seed = commandArgs.get("seed");
    const filter = commandArgs.get("filter");
    const timeout = commandArgs.get("timeout") || "60000";
    const skipVerify = commandArgs.has("skip-verify");
    const keepNode = commandArgs.has("keep-node");
    const [s, setS] = useState<State>({ phase: "setup", spin: "starting", lines: [] });

    useEffect(() => {
        let ownNode = false;
        let activeRpc = rpcBaseUrl;
        let engineSrv: EngineServer | null = null;
        const lines: Line[] = [];
        const add = (label: string, ok?: boolean | null, detail?: string) => {
            lines.push({ label, ok, detail });
        };
        const spin = (spin: string) => setS({ phase: "setup", spin, lines: [...lines] });

        (async () => {
            try {
                if (contractErr) {
                    add("contract", false, contractErr);
                    setS({ phase: "done", lines, ok: false, output: "", rows: [] });
                    return;
                }
                const core = resolveCoreDir(commandArgs.get("core-dir"), cfg.coreDir);
                if (!existsSync(contractPath)) {
                    add("contract", false, contractPath + " not found");
                    setS({ phase: "done", lines, ok: false, output: "", rows: [] });
                    return;
                }

                const useSimulator = resolveRuntime(commandArgs.get("runtime")) === "simulator";
                if (useSimulator) {
                    // an explicit --rpc names the simulator to run against; reuse one already serving it
                    // rather than starting an in-process engine and ignoring the flag.
                    const explicitRpc = commandArgs.get("rpc");
                    const reusable = explicitRpc && (await isTicking(explicitRpc)) ? await new LiteRpc(explicitRpc).whoami().catch(() => undefined) : undefined;
                    if (explicitRpc && reusable?.backend === "simulator") {
                        activeRpc = explicitRpc;
                        add("node", true, `simulator @ ${activeRpc} (reused)`);
                    } else if (explicitRpc && reusable) {
                        add("node", false, `${explicitRpc} is served by a ${reusable.backend} node, not a simulator`);
                        setS({ phase: "done", lines, ok: false, output: "", rows: [] });
                        return;
                    } else {
                        spin("starting in-process simulator");
                        // same window the node runs, so a slot a test exercises is the slot production gets.
                        engineSrv = new EngineServer(new VirtualNode(loadCoreWasmSlotLayout(core)));
                        engineSrv.engine.onLog = testRunLogSink((line) => add("node", null, line));
                        activeRpc = (await engineSrv.start()).rpcBaseUrl;
                        // A test run reads assertions, not traces — skip the per-call state snapshot a node keeps.
                        engineSrv.engine.setDebug(false);
                        add("node", true, `simulator @ ${activeRpc}`);
                    }
                } else {
                    spin("checking node");
                    const ticking = await isTicking(activeRpc);
                    const runningBackend = ticking ? (await new LiteRpc(activeRpc).whoami()).backend : undefined;
                    if (!ticking || runningBackend !== "core") {
                        spin("starting core node");
                        // Reuse a compatible ticking Core node; otherwise launch the selected binary.
                        const requestedNodeBinary = commandArgs.get("node-bin");
                        let nodeBinary = requestedNodeBinary ? resolve(requestedNodeBinary) : "";
                        let nodeNote = "";
                        if (!nodeBinary) {
                            spin("resolving node");
                            const r = await ensureNodeBinary(commandArgs.get("ref"), (rc, tt) =>
                                spin(tt ? `node ${(rc / 1e6) | 0}/${(tt / 1e6) | 0} MB` : `node ${(rc / 1e6) | 0} MB`),
                            );
                            nodeBinary = r.nodeBinaryPath;
                            if (r.cached) nodeNote = ` · cached ${r.version}`;
                        }
                        if (keepNode) {
                            add("node", false, `${activeRpc} is not a ticking core node and --keep-node forbids replacing it`);
                            setS({ phase: "done", lines, ok: false, output: "", rows: [] });
                            return;
                        }
                        await killNode(scratchForRpc(activeRpc) ?? activeNodeScratchDir());
                        if (runningBackend && runningBackend !== "core" && (await isTicking(activeRpc))) {
                            add("node", false, `${activeRpc} is served by an untracked ${runningBackend} node`);
                            setS({ phase: "done", lines, ok: false, output: "", rows: [] });
                            return;
                        }
                        launchNode({
                            nodeBinary,
                            nodeMode: commandArgs.get("node-mode"),
                            peers: commandArgs.get("peers"),
                            rpcBaseUrl: activeRpc,
                            httpPort: portFromRpc(activeRpc),
                        });
                        ownNode = true;
                        spin("waiting for ticking");
                        const w = await waitTicking(activeRpc, Number(commandArgs.get("wait") || 60));
                        if (!w.ticking) {
                            add("node", false, w.exited ? "exited early — see log" : "not ticking");
                            setS({ phase: "done", lines, ok: false, output: "", rows: [] });
                            return;
                        }
                        add("node", true, `launched core node · ticking at ${w.tick}${nodeNote}`);
                    } else {
                        add("node", true, "reused running node");
                    }
                }

                spin("deploying contract");
                let depDetail = "";
                const dep = await deployProjectContracts(
                    {
                        projectRoot: root,
                        contractPath,
                        name: contractName,
                        core,
                        rpcBaseUrl: activeRpc,
                        seed,
                        explicitCallees,
                        slotOverride: requestedSlot === undefined ? undefined : parseContractSlot(requestedSlot),
                        skipVerify,
                        compiler: resolveCompilerBackend(requestedCompiler),
                    },
                    (e: DeploymentEvent) => {
                        if ("note" in e) return;
                        if (e.state === "active" && e.detail) spin(`deploy · ${STEP_LABEL[e.step] ?? e.step}: ${e.detail}`);
                        if (e.step === "build" && e.state === "fail") depDetail = e.detail ?? "build failed";
                    },
                );
                if (!dep.ok || dep.slot === undefined) {
                    add("deploy", false, dep.error || depDetail || "failed");
                    setS({ phase: "done", lines, ok: false, output: "", rows: [] });
                    return;
                }
                // A reused slot keeps the previous deployment's state, which is why a green suite can turn red on core.
                const reuseNote = dep.reused ? " (reuse — state carried over from the previous deployment; `qinit node run --restart` for a clean run)" : "";
                add("deploy", true, `${contractName} @ slot ${dep.slot}${reuseNote}`);
                const synchronized = dep.deployments.filter((deployment) => deployment.kind !== "main");
                if (synchronized.length) {
                    add("dependencies", true, synchronized.map((deployment) => `${deployment.name}@${deployment.slot} ${deployment.action}`).join(" · "));
                }

                spin("generating test SDK");
                const idl =
                    dep.idl ??
                    extractIdl(readFileSync(contractPath, "utf8"), contractName, {
                        slot: dep.slot,
                        qpiHeader: loadQpiHeader(core),
                    });
                const sdkDir = join(root, "tests", ".qinit");
                mkdirSync(sdkDir, { recursive: true });
                writeFileSync(join(sdkDir, "runtime.ts"), testRuntimeSource);
                writeFileSync(join(sdkDir, `${contractName}.ts`), generateClient(idl, dep.slot, { runtimeImport: "./runtime" }));
                // A client per deployed callee too, so a spec can drive the token it just deployed alongside the market.
                const calleeClients = dep.deployments.filter((deployment) => deployment.kind === "custom" && deployment.idl);
                for (const deployment of calleeClients) {
                    writeFileSync(join(sdkDir, `${deployment.name}.ts`), generateClient(deployment.idl!, deployment.slot, { runtimeImport: "./runtime" }));
                }
                const clientNames = [contractName, ...calleeClients.map((deployment) => deployment.name)];
                const exportLines = clientNames.map((name) => `export { ${name} } from "./${name}";`);
                // BUN_BE_BUN is inherited, so a qinit the spec spawns comes up as bun; this clears it for a spawn given `env: process.env`, all a bun process can reach.
                writeFileSync(join(sdkDir, "index.ts"), `delete process.env.BUN_BE_BUN;\nexport * from "./runtime";\n${exportLines.join("\n")}\n`);
                const testsDir = join(root, "tests");
                const calleeNote = calleeClients.length ? ` · ${calleeClients.map((deployment) => deployment.name).join(", ")}` : "";
                add("sdk", true, `tests/.qinit/ (${idl.functions.length} fn / ${idl.procedures.length} proc${calleeNote})`);
                // A spec is the developer's to write; a guessed one would only fail against their entries.
                if (!readdirSync(testsDir).some((f) => f.endsWith(".test.ts"))) {
                    throw new Error(
                        `no tests/*.test.ts in this project — \`qinit new\` ships one; write a spec that imports { ${contractName}, provider } from "./.qinit"`,
                    );
                }

                ensureSpecProject(root);
                const types = await installSpecTypes(root);
                if (types === "failed") {
                    add("types", false, "@types/bun not installed — run `bun install` for editor typing");
                } else if (types !== "skipped") {
                    add("types", true, `@types/bun ${types}`);
                }

                const testSeed = seed || (await new LiteRpc(activeRpc).fundedSeed()) || DEFAULT_FUNDED_SEED;
                setS({ phase: "testing", lines: [...lines] });
                const env = {
                    ...process.env,
                    QINIT_RPC: activeRpc,
                    QINIT_SEED: testSeed,
                    QINIT_CONTRACT: String(dep.slot),
                    // the release binary is bun underneath, and this makes it act as one; from a checkout the executable is bun already.
                    BUN_BE_BUN: "1",
                };
                // generous per-test timeout — procedures wait ~tick offset (settle), well past bun's 5s default.
                const bunArgs = ["test", existsSync(testsDir) ? "tests" : ".", "--timeout", timeout, ...(filter ? ["-t", filter] : [])];
                const p = Bun.spawn([process.execPath, ...bunArgs], {
                    cwd: root,
                    env,
                    stdout: "pipe",
                    stderr: "pipe",
                });
                const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
                await p.exited;
                const output = stripAnsi((out + err).trim());
                const ok = p.exitCode === 0;
                add("tests", ok, ok ? "all passed" : "failures (see below)");

                setS({
                    phase: "done",
                    lines,
                    ok,
                    output,
                    rows: [
                        ["contract", `${contractName} @ ${dep.slot}`],
                        ["rpc", activeRpc],
                        ["node", engineSrv ? "simulator" : ownNode ? (!keepNode ? "launched for test (stopped)" : "launched for test (kept)") : "reused"],
                    ],
                });
            } catch (e: any) {
                add("ERROR", false, String(e?.message ?? e));
                setS({ phase: "done", lines, ok: false, output: "", rows: [] });
            } finally {
                try {
                    if (ownNode && !keepNode) {
                        // the node this run launched, not whatever is globally active.
                        await killNode(scratchForRpc(activeRpc) ?? activeNodeScratchDir());
                    }
                } catch {}
                engineSrv?.stop();
            }
        })();
    }, []);
    useEffect(() => {
        if (s.phase === "done") {
            if (output.json) {
                process.stdout.write(
                    JSON.stringify({
                        ok: s.ok,
                        error: s.ok ? null : (s.lines.find((line) => line.ok === false)?.detail ?? "tests failed"),
                        steps: s.lines.map((line) => ({ label: line.label, ok: line.ok ?? null, detail: line.detail ?? null })),
                        summary: Object.fromEntries(s.rows),
                        output: s.output,
                    }) + "\n",
                );
            }
            process.exitCode = s.ok ? 0 : 1;
            exit();
        }
    }, [s, exit]);

    if (output.json) return null;
    const lines = s.lines;
    return (
        <Box flexDirection="column">
            <Header cmd="test" />
            <Box flexDirection="column">
                {lines.map((l, i) => (
                    <Status key={i} ok={l.ok} label={l.label} detail={l.detail} pad={14} />
                ))}
            </Box>
            {s.phase === "setup" && (
                <Box marginTop={lines.length ? 1 : 0}>
                    <Spinner label={s.spin} />
                </Box>
            )}
            {s.phase === "testing" && (
                <Box marginTop={1}>
                    <Spinner label="running bun test" color={theme.accent} />
                </Box>
            )}
            {s.phase === "done" && (
                <Box flexDirection="column" marginTop={1}>
                    {s.output && (
                        <Panel title={s.ok ? "bun test ✓" : "bun test ✗"} color={s.ok ? theme.ok : theme.err}>
                            <Box flexDirection="column">
                                {s.output
                                    .split("\n")
                                    .slice(-28)
                                    .map((ln, i) => (
                                        <Text key={i} dimColor>
                                            {ln}
                                        </Text>
                                    ))}
                            </Box>
                        </Panel>
                    )}
                    {s.rows.length > 0 && (
                        <Box marginTop={1}>
                            <Panel title={s.ok ? "passed ✓" : "failed"} color={s.ok ? theme.ok : theme.err}>
                                <KV rows={s.rows} />
                            </Panel>
                        </Box>
                    )}
                </Box>
            )}
        </Box>
    );
}
