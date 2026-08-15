import { useEffect, useState } from "react";
import { resolve, basename } from "node:path";
import { Box, Text, useApp } from "ink";
import { resolveProjectDependencies, verifyContract, type VerifyResult } from "@qinit/build";
import { loadConfig, resolveCoreDir } from "../../config";
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
                const cpath = commandArgs.get("contract") ?? commandArgs.positionals[0] ?? cfg.contract;
                if (!cpath) throw new Error("no contract: pass `qinit verify <file.h>` (or set contract in qinit.json)");
                const file = resolve(cpath);
                const name = commandArgs.get("contract-name") ?? cfg.contractName ?? basename(file).replace(/\.[^.]+$/, "");
                const graph = resolveProjectDependencies({
                    projectRoot: process.cwd(),
                    corePath: resolveCoreDir(commandArgs.get("core-dir"), cfg.coreDir),
                    contractName: name,
                    contractPath: file,
                    explicitCallees: dynCallees,
                });
                const calleeNames = graph.filter((contract) => contract.stateType !== name).flatMap((contract) => [contract.name, contract.stateType]);
                setR(await verifyContract(file, name, { allowedPrefixes: calleeNames }));
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
                ? { ok: false, available: false, oracle: false, errors: [err] }
                : { ok: r!.ok, available: r!.available, oracle: r!.oracle, errors: r!.errors };
            process.stdout.write(JSON.stringify(payload) + "\n");
        }
        process.exitCode = err || (r && r.available && !r.ok) ? 1 : 0;
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
            {!v.available ? (
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
