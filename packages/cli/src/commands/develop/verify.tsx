import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { isCoreStateType, resolveContracts, verifyContract, type VerifyResult } from "@qinit/build";
import { loadConfig, projectContractName, projectContractPath, resolveCoreDir } from "../../config";
import { Header, Panel, Status, theme, termCols } from "../../ui";
import { output, type CommandArguments } from "../../args";
import { parseCallees } from "../../contracts/callees";

export function Verify({ commandArgs }: { commandArgs: CommandArguments }) {
    const { exit } = useApp();
    const dynCallees = parseCallees(commandArgs.getAll("callee"));
    const [r, setR] = useState<VerifyResult | null>(null);
    const [err, setErr] = useState("");

    useEffect(() => {
        (async () => {
            try {
                const cfg = loadConfig();
                const requested = commandArgs.get("contract") ?? commandArgs.positionals[0];
                const file = projectContractPath("verify", requested, cfg);
                const { name, stateType } = projectContractName(file, { contractName: commandArgs.get("contract-name") }, cfg, !requested);
                const core = resolveCoreDir(commandArgs.get("core-dir"), cfg.coreDir);
                const graph = resolveContracts({
                    projectRoot: process.cwd(),
                    corePath: core,
                    contractName: name,
                    stateType,
                    contractPath: file,
                    explicitCallees: dynCallees,
                });
                // the graph ends with the contract itself
                const calleeNames = graph.slice(0, -1).flatMap((contract) => [contract.name, contract.stateType]);
                setR(
                    await verifyContract(file, stateType, {
                        allowedPrefixes: calleeNames,
                        stateType,
                        buildRules: { contractKind: isCoreStateType(core, stateType) ? "system" : "user", buildRules: !commandArgs.has("no-build-rules") },
                    }),
                );
            } catch (e: any) {
                setErr(String(e?.message ?? e));
            }
        })();
    }, []);

    const done = r !== null || err !== "";
    useEffect(() => {
        if (!done) return;
        if (output.json) {
            const payload = err
                ? { ok: false, available: false, oracle: false, error: err, errors: [err] }
                : { ok: r!.ok, available: r!.available, oracle: r!.oracle, error: r!.ok ? null : (r!.errors[0] ?? "protocol violations"), errors: r!.errors };
            process.stdout.write(JSON.stringify(payload) + "\n");
        }
        process.exitCode = err || (r && !r.ok) ? 1 : 0;
        const t = setTimeout(() => exit(), 40);
        return () => clearTimeout(t);
    }, [done]);

    if (output.json) return null;
    if (!done)
        return (
            <Box flexDirection="column">
                <Header cmd="verify" />
                <Text dimColor>checking protocol rules…</Text>
            </Box>
        );
    if (err)
        return (
            <Box flexDirection="column">
                <Header cmd="verify" />
                <Panel title="verify failed" color={theme.err}>
                    <Text>{err}</Text>
                </Panel>
            </Box>
        );
    const v = r!;
    return (
        <Box flexDirection="column">
            <Header cmd="verify" />
            {v.ok && !v.available ? (
                <Status ok={null} label="protocol rules" detail="skipped — verify tool not fetched (run qinit setup)" pad={16} />
            ) : v.ok ? (
                <Status ok={true} label="protocol rules" detail="passed — complies with qpi.h restrictions" pad={16} />
            ) : (
                <Panel title="protocol violations" color={theme.err}>
                    <Box flexDirection="column" width={Math.min(100, termCols() - 4)}>
                        {v.errors.map((e, i) => (
                            <Text key={i} wrap="wrap">
                                <Text color={theme.err}>✗ </Text>
                                {e}
                            </Text>
                        ))}
                    </Box>
                </Panel>
            )}
        </Box>
    );
}
