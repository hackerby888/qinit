import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { resolve, join, basename } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { extractIdl, generateClient, resolveContracts, testRuntimeSource, type CalleeSource } from "@qinit/build";
import { loadQpiHeader } from "@qinit/compiler";
import { loadCoreWasmSlotLayout } from "@qinit/core";
import { loadConfig, resolveCoreDir } from "../../config";
import { Header, Panel, KV, theme } from "../../ui";
import { output, type CommandArguments } from "../../args";
import { parseContractSlot } from "../../contracts/registry";
import { loadContractIdlFile } from "../../contracts/idl-file";

function deployedSlot(name: string): number | undefined {
    return Object.values(loadContractIdlFile().contracts).find((contract) => contract.name === name)?.slot;
}

// The contracts this one calls, resolved the way `build` resolves them, so a state or locals field typed by a
// callee gets its real layout in the client. A project that does not resolve keeps generating without them.
function projectCalleeSources(core: string, contractPath: string, contractName: string, slot: number): CalleeSource[] {
    try {
        const resolved = resolveContracts({
            projectRoot: process.cwd(),
            corePath: core,
            contractPath,
            contractName,
            slot,
        });
        return resolved
            .filter((contract) => contract.stateType !== contractName)
            .map((contract) => ({ name: contract.stateType, source: contract.source, slot: contract.slot }));
    } catch {
        return [];
    }
}

type State = { ok: true; file: string; name: string; slot: number; fns: number; procs: number } | { ok: false; err: string } | null;

export function genJsonResult(s: Exclude<State, null>) {
    return s.ok ? { ...s, error: null } : { ok: false, error: s.err };
}

export function Gen({ commandArgs }: { commandArgs: CommandArguments }) {
    const { exit } = useApp();
    const [s, setS] = useState<State>(null);

    useEffect(() => {
        try {
            const cfg = loadConfig();
            const requestedContractPath = commandArgs.get("contract") ?? commandArgs.positionals[0];
            const contractPath = resolve(requestedContractPath ?? cfg.contract ?? "fixtures/Counter.h");
            // A header named on the command line is the contract to generate for, whatever the project's main one is.
            const headerName = basename(contractPath).replace(/\.[^.]+$/, "");
            const name = commandArgs.get("contract-name") ?? (requestedContractPath ? headerName : (cfg.contractName ?? headerName));
            const core = resolveCoreDir(commandArgs.get("core-dir"), cfg.coreDir);
            // The deploy wrote this contract's slot to the IDL file; the window base is only right with no callees.
            const requestedSlot = commandArgs.get("slot") ?? cfg.slot ?? deployedSlot(name);
            const slot = parseContractSlot(requestedSlot === undefined ? loadCoreWasmSlotLayout(core).slotBase : requestedSlot);
            const idl = extractIdl(readFileSync(contractPath, "utf8"), name, {
                slot,
                qpiHeader: loadQpiHeader(core),
                calleeSources: projectCalleeSources(core, contractPath, name, slot),
            });
            // Emit a SELF-CONTAINED client: the client pulls LiteRpc/codec from a sibling runtime.ts (only needs the
            // crypto is bundled in), not from the unpublished @qinit/* monorepo packages — so the output works outside it.
            const ts = generateClient(idl, slot, { runtimeImport: "./runtime" });
            const outDir = resolve(commandArgs.get("out") ?? "dist/clients");
            mkdirSync(outDir, { recursive: true });
            writeFileSync(join(outDir, "runtime.ts"), testRuntimeSource);
            const file = join(outDir, `${name}.ts`);
            writeFileSync(file, ts);
            setS({
                ok: true,
                file,
                name,
                slot,
                fns: idl.functions.length,
                procs: idl.procedures.length,
            });
        } catch (e: any) {
            setS({ ok: false, err: String(e?.message ?? e) });
        }
    }, []);
    useEffect(() => {
        if (s) {
            if (output.json) process.stdout.write(JSON.stringify(genJsonResult(s)) + "\n");
            process.exitCode = s.ok ? 0 : 1;
            exit();
        }
    }, [s, exit]);

    if (output.json) return null;
    return (
        <Box flexDirection="column">
            <Header cmd="gen" />
            {s?.ok && (
                <Panel title="client generated ✓" color={theme.ok}>
                    <KV
                        rows={[
                            ["contract", s.name],
                            ["slot", String(s.slot)],
                            ["fns/procs", `${s.fns} / ${s.procs}`],
                            ["file", s.file],
                        ]}
                    />
                    <Box marginTop={1}>
                        <Text dimColor>
                            import {`{ ${s.name} }`} from "{s.file.replace(/\.ts$/, "")}"
                        </Text>
                    </Box>
                </Panel>
            )}
            {s && !s.ok && (
                <Panel title="gen failed" color={theme.err}>
                    <Text dimColor>{s.err}</Text>
                </Panel>
            )}
        </Box>
    );
}
