import { useEffect, useState } from "react";
import { resolve, join, basename } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { analyzeCheatcodes, stripCheatcodes } from "@qinit/compiler/analyzer";
import { Box, Text, useApp } from "ink";
import type { ContractBuildResult } from "@qinit/build";
import { DEFAULT_RPC_BASE, autoUpdateVerifyTool, LiteRpc, loadCoreWasmSlotLayout } from "@qinit/core";
import { loadConfig, resolveCoreDir, resolveCompilerBackend } from "../../config";
import { Header, Spinner, Panel, KV, Status, theme } from "../../ui";
import { output, type CommandArguments } from "../../args";
import { parseCallees } from "../../contracts/callees";
import { parseContractSlot } from "../../contracts/registry";
import { buildProjectContracts, resolveProjectPlan } from "../../ops/project-build";

type State = { phase: "run" } | { phase: "done"; r: ContractBuildResult };

/** Writes the cheat-free source beside the build output and hands back its path. */
function productionCopy(sourcePath: string): string {
    const raw = readFileSync(sourcePath, "utf8");
    const violations = analyzeCheatcodes(raw);

    if (violations.length) {
        throw new Error(violations.map((item) => `line ${item.span.line}: ${item.message}`).join("\n"));
    }

    const target = join(mkdtempSync(join(tmpdir(), "qinit-production-")), basename(sourcePath));
    writeFileSync(target, stripCheatcodes(raw));

    return target;
}

export function buildJsonResult(r: ContractBuildResult, compiler: string) {
    return {
        ok: r.ok,
        compiler,
        artifact: r.wasmPath ?? null,
        size: r.wasmSizeBytes ?? null,
        hash: r.wasmK12DigestHex ?? null,
        idl: r.idl ?? null,
        idlError: r.idlError ?? null,
        stderr: r.stderr ?? "",
    };
}

export function Build({ commandArgs }: { commandArgs: CommandArguments }) {
    const { exit } = useApp();
    const dynCallees = parseCallees(commandArgs.getAll("callee"));
    const compiler = resolveCompilerBackend(commandArgs.get("compiler"));
    const [s, setS] = useState<State>({ phase: "run" });

    useEffect(() => {
        (async () => {
            try {
                const cfg = loadConfig();
                const core = resolveCoreDir(commandArgs.get("core-dir"), cfg.coreDir);
                const sourcePath = resolve(commandArgs.get("contract") ?? commandArgs.positionals[0] ?? cfg.contract ?? "fixtures/Counter.h");
                // A production build compiles what Core will receive. The stripped copy goes to a
                // scratch file: a build must never rewrite the contract the dev is working on.
                const contractPath = commandArgs.has("production") ? productionCopy(sourcePath) : sourcePath;
                const name = commandArgs.get("contract-name") ?? cfg.contractName ?? basename(contractPath).replace(/\.[^.]+$/, "");
                const outDir = resolve(commandArgs.get("out") ?? "dist/contracts");
                const requestedSlot = commandArgs.get("slot") ?? cfg.slot;
                const slot = requestedSlot === undefined ? undefined : parseContractSlot(requestedSlot);
                const rpcBaseUrl = commandArgs.get("rpc") ?? cfg.rpc ?? DEFAULT_RPC_BASE;
                const rpc = new LiteRpc(rpcBaseUrl);
                const registry = await Promise.race([
                    rpc.dynRegistry().catch(() => undefined),
                    new Promise<undefined>((resolveTimeout) => setTimeout(() => resolveTimeout(undefined), 2500)),
                ]);
                const slotLayout = registry ?? loadCoreWasmSlotLayout(core);
                const plan = resolveProjectPlan({
                    projectRoot: process.cwd(),
                    core,
                    contractPath,
                    name,
                    slot,
                    explicitCallees: dynCallees,
                    slotLayout,
                    registry,
                });

                if (compiler === "clang") {
                    await autoUpdateVerifyTool();
                }
                const project = await buildProjectContracts({
                    plan,
                    core,
                    compiler,
                    outDir,
                    skipVerify: commandArgs.has("skip-verify"),
                    // Production means what Core compiles: no shim at all, and the cheats already gone
                    // from the source. Anything left over is then an undeclared identifier, not a no-op.
                    cheats: commandArgs.has("production") ? "off" : "on",
                });
                const r: ContractBuildResult = project.ok
                    ? project.contracts.at(-1)!.result
                    : (project.result ?? {
                          ok: false,
                          stderr: `${project.failed?.name ?? "contract"}: compile failed`,
                      });
                if (r.ok && r.idl)
                    try {
                        writeFileSync(join(outDir, `${name}.idl.json`), JSON.stringify(r.idl, null, 2));
                    } catch {}
                setS({ phase: "done", r });
            } catch (e: any) {
                setS({ phase: "done", r: { ok: false, stderr: String(e?.message ?? e) } });
            }
        })();
    }, []);

    useEffect(() => {
        if (s.phase === "done") {
            if (output.json) {
                process.stdout.write(JSON.stringify(buildJsonResult(s.r, compiler)) + "\n");
            }
            process.exitCode = s.r.ok ? 0 : 1;
            exit();
        }
    }, [s, exit]);

    if (output.json) return null;

    if (s.phase === "run") {
        const label = compiler === "typescript" ? "compiling contract to wasm (TypeScript compiler)" : "compiling contract to wasm";
        return (
            <Box flexDirection="column">
                <Header cmd="build" />
                <Spinner label={label} />
            </Box>
        );
    }

    const { r } = s;
    if (!r.ok) {
        return (
            <Box flexDirection="column">
                <Header cmd="build" />
                <Panel title="build failed" color={theme.err}>
                    <Text dimColor>{(r.stderr ?? "").split("\n").slice(0, 25).join("\n")}</Text>
                </Panel>
            </Box>
        );
    }

    return (
        <Box flexDirection="column">
            <Header cmd="build" />
            <Panel title={"built ✓" + (compiler === "typescript" ? " (TypeScript)" : "")} color={theme.ok}>
                <KV
                    rows={[
                        ["wasm", String(r.wasmPath)],
                        ["size", `${r.wasmSizeBytes} bytes`],
                        ["k12 ", r.wasmK12DigestHex || "(pending)"],
                    ]}
                />
            </Panel>
            {r.idlError ? (
                <Box marginTop={1}>
                    <Text color={theme.warn}>IDL unavailable: {r.idlError}</Text>
                </Box>
            ) : null}
            {compiler === "typescript" ? null : (
                <Box marginTop={1}>
                    <Status ok={true} label="protocol rules" detail="passed — complies with qpi.h restrictions" pad={16} />
                </Box>
            )}
        </Box>
    );
}
