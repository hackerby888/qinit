import { useEffect, useState } from "react";
import { Box, useApp } from "ink";
import { DEFAULT_RPC_BASE, readCurrent, wasiSdkPaths } from "@qinit/core";
import { compilerInfo } from "@qinit/compiler/browser";
import { output, type CommandArguments } from "../../args";
import { loadConfig, resolveCoreDir, savedCompilerBackend, savedRuntime } from "../../config";
import { nodeStatus } from "../../ops/node";
import { Header, KV, Panel, Spinner, theme } from "../../ui";
import { VERSION } from "../../version";

interface Setup {
    qinit: { version: string; binary: string };
    compiler: { backend: string; wasiSdk: string; protocolVersion: number; snapshotHash: string; coreCommit: string };
    runtime: { runtime: string; rpc: string; nodeVersion: string; nodeBinary: string; headersVersion: string; node: string };
    core: { checkout: string; qpiHeader: string };
}

/** A stored choice and its fallback read the same on screen otherwise, and which one is in play matters. */
const chosen = (saved: string | undefined, fallback: string): string => saved ?? `${fallback} (default)`;

const short = (value: string | undefined, length = 12): string => (value ? (value.length > length ? value.slice(0, length) + "…" : value) : "—");

async function collectSetup(rpcOverride?: string): Promise<Setup> {
    const config = loadConfig();
    const rpc = rpcOverride || config.rpc || DEFAULT_RPC_BASE;
    const current = readCurrent();

    let checkout = "";
    let qpiHeader = "not found";
    try {
        checkout = resolveCoreDir();
        const path = `${checkout}/src/qpi/qpi.h`;
        qpiHeader = (await Bun.file(path).exists()) ? path : "missing from the checkout";
    } catch (error: any) {
        checkout = String(error?.message ?? error);
    }

    // The node is the one remote fact here; everything else stays readable with nothing running.
    let node = "not reachable";
    try {
        const status = await nodeStatus(rpc);
        node = status.up ? `up · tick ${status.tick} · epoch ${status.epoch}` : "not reachable";
    } catch {
        node = "not reachable";
    }

    return {
        qinit: { version: VERSION, binary: process.execPath },
        compiler: {
            backend: chosen(savedCompilerBackend(), "clang"),
            wasiSdk: wasiSdkPaths()?.clang ?? "not cached — run qinit setup",
            protocolVersion: compilerInfo.protocolVersion,
            snapshotHash: compilerInfo.snapshotHash,
            coreCommit: compilerInfo.coreCommit,
        },
        runtime: {
            runtime: chosen(savedRuntime(), "core"),
            rpc,
            nodeVersion: current?.nodeVersion ?? "—",
            nodeBinary: current?.node ?? "—",
            headersVersion: current?.headersVersion ?? "—",
            node,
        },
        core: { checkout, qpiHeader },
    };
}

export function Info({ commandArgs }: { commandArgs: CommandArguments }) {
    const { exit } = useApp();
    const [setup, setSetup] = useState<Setup | null>(null);
    const rpcOverride = commandArgs.get("rpc");

    useEffect(() => {
        collectSetup(rpcOverride).then(setSetup);
    }, [rpcOverride]);

    useEffect(() => {
        if (!setup) {
            return;
        }
        if (output.json) {
            process.stdout.write(JSON.stringify(setup) + "\n");
        }
        exit();
    }, [setup, exit]);

    if (output.json) {
        return null;
    }

    // Drift between the headers a contract compiles against and the node it deploys to breaks deploys,
    // so say it here rather than leaving it to be discovered at deploy time.
    const drift =
        setup && setup.runtime.headersVersion !== "—" && setup.runtime.nodeVersion !== "—" && setup.runtime.headersVersion !== setup.runtime.nodeVersion;

    return (
        <Box flexDirection="column">
            <Header cmd="info" />
            {!setup && <Spinner label="reading setup" />}
            {setup && (
                <Box flexDirection="column">
                    <Panel title="qinit" color={theme.ok}>
                        <KV
                            rows={[
                                ["version", setup.qinit.version],
                                ["binary", setup.qinit.binary],
                            ]}
                        />
                    </Panel>
                    <Panel title="compiler">
                        <KV
                            rows={[
                                ["backend", setup.compiler.backend],
                                ["wasi-sdk", setup.compiler.wasiSdk],
                                ["protocol", String(setup.compiler.protocolVersion)],
                                ["qpi snapshot", `${short(setup.compiler.snapshotHash, 20)} @ ${short(setup.compiler.coreCommit)}`],
                            ]}
                        />
                    </Panel>
                    <Panel title="runtime" color={drift ? theme.warn : undefined}>
                        <KV
                            rows={[
                                ["runtime", setup.runtime.runtime],
                                ["rpc", setup.runtime.rpc],
                                ["node", setup.runtime.node],
                                ["node version", setup.runtime.nodeVersion],
                                ["node binary", setup.runtime.nodeBinary],
                                ["headers", drift ? `${setup.runtime.headersVersion}  ⚠ drift — run qinit setup` : setup.runtime.headersVersion],
                            ]}
                        />
                    </Panel>
                    <Panel title="core">
                        <KV
                            rows={[
                                ["checkout", setup.core.checkout],
                                ["qpi.h", setup.core.qpiHeader],
                            ]}
                        />
                    </Panel>
                </Box>
            )}
        </Box>
    );
}
