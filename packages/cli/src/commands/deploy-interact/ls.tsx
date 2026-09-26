import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { LiteRpc, type DynamicContractRegistryEntry } from "@qinit/core";
import type { SystemContract } from "@qinit/build";
import { loadConfig, resolveRpc } from "../../config";
import { loadSystem, systemLoaded } from "../../contracts/registry";
import { Header, Spinner, Panel, Table, theme, type Column } from "../../ui";
import { output, type CommandArguments } from "../../args";
import { contractIsDormant } from "../../ops/node";

// qinit ls [--rpc <url>]  — user-deployed contracts (dyn-registry) first, then built-in system contracts (catalog).
const COLS: Column[] = [
    { header: "slot", align: "right" },
    { header: "name", max: 20 },
    { header: "state" },
    { header: "fn·proc", align: "right" },
    { header: "ver", align: "right" },
    { header: "reserve", align: "right" },
    { header: "k12", dim: true, max: 16 },
];
const SYS_COLS: Column[] = [
    { header: "idx", align: "right" },
    { header: "name", max: 16 },
    { header: "fn·proc", align: "right" },
    { header: "source", dim: true, max: 24 },
];
export const stateOf = (contract: DynamicContractRegistryEntry) =>
    !contract.armed ? "empty" : !contract.constructed ? "constructing" : contractIsDormant(contract) ? "dormant" : "ready";

export function lsJsonResult(user: DynamicContractRegistryEntry[], system: SystemContract[], nodeDown: boolean, systemLoaded: boolean) {
    return {
        // without ok/error a script cannot tell "no contracts" from "the node was down".
        ok: !nodeDown,
        error: nodeDown ? "node unreachable" : null,
        // the catalog lists every system contract; on the simulator only the added ones run.
        systemLoaded,
        deployed: user.map((c) => ({
            slot: c.index,
            name: c.name || null,
            state: stateOf(c),
            version: c.version ?? 0,
            codeHash: c.codeHash || null,
            feeReserve: c.feeReserve ?? null,
        })),
        system: system.map((c) => ({
            index: c.index,
            name: c.name,
            file: c.file,
        })),
        nodeDown,
    };
}

export function Ls({ commandArgs }: { commandArgs: CommandArguments }) {
    const rpcBaseUrl = resolveRpc(commandArgs.get("rpc"), loadConfig());
    const { exit } = useApp();
    const [s, setS] = useState<{
        phase: "run" | "done";
        user?: DynamicContractRegistryEntry[];
        system?: SystemContract[];
        nodeDown?: boolean;
        systemLoaded?: boolean;
    }>({ phase: "run" });

    useEffect(() => {
        (async () => {
            let user: DynamicContractRegistryEntry[] = [];
            let nodeDown = false;
            let systemLive = true;
            try {
                const rpc = new LiteRpc(rpcBaseUrl);
                user = (await rpc.dynRegistry()).contracts ?? [];
                // the simulator runs only the system contracts it was given; a node too old for whoami reads as core, where all of them are native.
                systemLive = systemLoaded({ user, system: [], backend: (await rpc.whoami().catch(() => undefined))?.backend });
            } catch {
                nodeDown = true;
            }
            setS({ phase: "done", user, system: loadSystem(), nodeDown, systemLoaded: systemLive }); // system from the snapshot — shows even if the node is down
        })();
    }, []);
    useEffect(() => {
        if (s.phase !== "run") {
            if (output.json) process.stdout.write(JSON.stringify(lsJsonResult(s.user ?? [], s.system ?? [], !!s.nodeDown, s.systemLoaded ?? true)) + "\n");
            process.exitCode = s.nodeDown ? 1 : 0;
            const t = setTimeout(() => exit(), 20);
            return () => clearTimeout(t);
        }
    }, [s.phase]);

    if (output.json) return null;
    if (s.phase === "run")
        return (
            <Box flexDirection="column">
                <Header cmd="ls" />
                <Spinner label="loading contracts" />
            </Box>
        );

    const user = (s.user ?? []).filter((c) => c.armed || (c.name && c.name.length));
    const system = s.system ?? [];
    return (
        <Box flexDirection="column">
            <Header cmd="ls" />
            {user.length > 0 && (
                <Panel title={`deployed · ${user.length}`} color={theme.brand}>
                    <Table
                        columns={COLS}
                        rows={user.map((c) => [
                            String(c.index),
                            c.name || "-",
                            stateOf(c),
                            `${c.functions?.length ?? 0}/${c.procedures?.length ?? 0}`,
                            "v" + (c.version ?? 0),
                            c.feeReserve ?? "-",
                            (c.codeHash || "").slice(0, 16) + "…",
                        ])}
                        rowColor={(i) => {
                            const st = stateOf(user[i]);
                            return st === "constructing" || st === "dormant" ? theme.warn : st === "empty" ? theme.mute : undefined;
                        }}
                    />
                </Panel>
            )}
            {system.length > 0 && (
                <Panel title={`system · ${system.length}${s.systemLoaded === false ? " · not loaded — qinit system add <name>" : ""}`} color={theme.info}>
                    <Table
                        columns={SYS_COLS}
                        rows={system.map((c) => [String(c.index), c.name, `${c.idl.functions.length}/${c.idl.procedures.length}`, c.file])}
                    />
                </Panel>
            )}
            {user.length === 0 &&
                (s.nodeDown ? (
                    <Text dimColor>
                        node unreachable — deployed contracts hidden.{" "}
                        <Text bold color={theme.accent}>
                            qinit node run
                        </Text>{" "}
                        to start it.
                    </Text>
                ) : system.length === 0 ? (
                    <Text dimColor>
                        no contracts —{" "}
                        <Text bold color={theme.accent}>
                            qinit deploy
                        </Text>
                        , or{" "}
                        <Text bold color={theme.accent}>
                            qinit node run
                        </Text>{" "}
                        for system contracts
                    </Text>
                ) : null)}
        </Box>
    );
}
