import { CheatMode } from "@qinit/compiler";
import { useEffect, useState } from "react";
import { resolve, basename } from "node:path";
import { Box, Text, useApp } from "ink";
import { contractAddress } from "@qinit/proto";
import { DEFAULT_RPC_BASE, bytesToIdentity } from "@qinit/core";
import { loadConfig, resolveCoreDir, resolveCompilerBackend } from "../../config";
import { STEPS, updateDeploymentSteps, type DeploymentEvent, type DeploymentStepState } from "../../ops/deploy";
import { deployProjectContracts, type ProjectDeployResult } from "../../ops/project-deploy";
import { Header, StepRow, type StepState, Panel, KV, theme } from "../../ui";
import { output, type CommandArguments } from "../../args";
import { parseCallees } from "../../contracts/callees";
import { parseContractSlot } from "../../contracts/registry";

export function Deploy({ commandArgs }: { commandArgs: CommandArguments }) {
    const dynCallees = parseCallees(commandArgs.getAll("callee"));
    const { exit } = useApp();
    const [steps, setSteps] = useState<Record<string, DeploymentStepState>>({});
    const [notes, setNotes] = useState<string[]>([]);
    const [result, setResult] = useState<ProjectDeployResult | null>(null);
    const [addr, setAddr] = useState("");
    const [name, setName] = useState("");

    useEffect(() => {
        (async () => {
            try {
                const cfg = loadConfig();
                const cpath = commandArgs.get("contract") ?? commandArgs.positionals[0] ?? cfg.contract;
                if (!cpath) throw new Error("no contract: pass `qinit deploy <file.h>` (or --contract <file.h>, or set contract in qinit.json)");
                const contractPath = resolve(cpath);
                const nm = commandArgs.get("contract-name") ?? cfg.contractName ?? basename(contractPath).replace(/\.[^.]+$/, "");
                setName(nm);
                const requestedSlot = commandArgs.get("slot") ?? cfg.slot;
                const slotOverride = requestedSlot === undefined ? undefined : parseContractSlot(requestedSlot);
                const emit = (e: DeploymentEvent) => {
                    if ("note" in e) {
                        setNotes((n) => [...n, e.note]);
                        return;
                    }
                    setSteps((steps) => updateDeploymentSteps(steps, e));
                };
                const r = await deployProjectContracts(
                    {
                        projectRoot: process.cwd(),
                        contractPath,
                        name: nm,
                        core: resolveCoreDir(commandArgs.get("core-dir"), cfg.coreDir),
                        rpcBaseUrl: commandArgs.get("rpc") ?? cfg.rpc ?? DEFAULT_RPC_BASE,
                        seed: commandArgs.get("seed"),
                        explicitCallees: dynCallees,
                        slotOverride,
                        skipVerify: commandArgs.has("skip-verify"),
                        compiler: resolveCompilerBackend(commandArgs.get("compiler")),
                        cheats: commandArgs.has("production") ? CheatMode.OFF : CheatMode.ON,
                    },
                    emit,
                );
                if (r.ok && r.slot != null) {
                    try {
                        setAddr(await bytesToIdentity(contractAddress(r.slot)));
                    } catch {}
                }
                setResult(r);
            } catch (e: any) {
                setNotes((n) => [...n, "ERROR: " + String(e?.message ?? e).slice(0, 300)]);
                setResult({
                    ok: false,
                    deployments: [],
                    error: String(e?.message ?? e),
                });
            }
        })();
    }, []);
    useEffect(() => {
        if (result) {
            if (output.json)
                process.stdout.write(
                    JSON.stringify({
                        ok: result.ok,
                        contract: name,
                        slot: result.slot ?? null,
                        address: addr || null,
                        tx: result.txId ?? null,
                        codeHash: result.hash ?? null,
                        dependencies: result.deployments.filter((deployment) => deployment.kind !== "main"),
                        remaining: result.remainingContracts ?? [],
                        error: result.ok ? null : (result.reason ?? result.error ?? null),
                    }) + "\n",
                );
            process.exitCode = result.ok ? 0 : 1;
            const t = setTimeout(() => exit(), 60);
            return () => clearTimeout(t);
        }
    }, [result]);

    if (output.json) return null;
    return (
        <Box flexDirection="column">
            <Header cmd="deploy" />
            <Box flexDirection="column">
                {STEPS.map(({ key, label }) => {
                    const s = steps[key] ?? { state: "pending" as StepState };
                    return <StepRow key={key} state={s.state} label={label} detail={s.detail} pct={s.pct} elapsedMs={s.elapsedMs} />;
                })}
            </Box>
            {notes.length > 0 && (
                <Box marginTop={1} flexDirection="column">
                    {notes.map((n, i) => (
                        <Text
                            key={i}
                            color={n.startsWith("✗") || n.startsWith("ERROR") ? theme.err : n.startsWith("⚠") ? theme.warn : undefined}
                            dimColor={!/^[✗⚠E]/.test(n)}
                        >
                            {n}
                        </Text>
                    ))}
                </Box>
            )}
            {result?.ok && (
                <Box marginTop={1}>
                    <Panel title="deployed ✓" color={theme.ok}>
                        <KV
                            full
                            rows={[
                                ["contract", name],
                                ["slot", String(result.slot)],
                                ["address", addr || `id(${result.slot},0,0,0)`],
                                ["tx", result.txId ?? "—"],
                                ["codeHash", result.hash ?? "—"],
                                ["fns/procs", result.idl ? `${result.idl.functions.length} / ${result.idl.procedures.length}` : "—"],
                            ]}
                        />
                        <Box marginTop={1}>
                            <Text dimColor>next: </Text>
                            <Text bold color={theme.accent}>
                                qinit call
                            </Text>
                        </Box>
                    </Panel>
                </Box>
            )}
            {result && !result.ok && (
                <Box marginTop={1}>
                    <Panel title="deploy failed" color={theme.err}>
                        <Text>{result.reason ?? result.error ?? "see steps above"}</Text>
                        {result.deployments.length > 0 && <Text dimColor>completed: {result.deployments.map((item) => item.name).join(", ")}</Text>}
                        {(result.remainingContracts?.length ?? 0) > 0 && <Text dimColor>not run: {result.remainingContracts!.join(", ")}</Text>}
                    </Panel>
                </Box>
            )}
            {!result && (
                <Box marginTop={1}>
                    <Text dimColor>…</Text>
                </Box>
            )}
        </Box>
    );
}
