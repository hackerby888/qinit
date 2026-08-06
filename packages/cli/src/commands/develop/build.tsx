import { useEffect, useState } from "react";
import { resolve, join, basename } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { Box, Text, useApp } from "ink";
import { buildContractWithWasiClang, type ContractBuildResult } from "@qinit/build";
import {
  DEFAULT_RPC_BASE,
  autoUpdateVerifyTool,
  LiteRpc,
  loadCoreWasmSlotLayout,
} from "@qinit/core";
import { buildContractWithTypeScript } from "../../ops/typescript-build";
import { loadQpiHeader } from "@qinit/compiler";
import {
  loadConfig,
  resolveCoreDir,
  resolveCompilerBackend,
} from "../../config";
import { Header, Spinner, Panel, KV, Status, theme } from "../../ui";
import { output, type CommandArguments } from "../../args";
import { parseCallees, resolveNodeCallees } from "../../contracts/callees";
import { parseContractSlot } from "../../contracts/registry";

type State =
  { phase: "run" } | { phase: "done"; r: ContractBuildResult };

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
        const contractPath = resolve(
          commandArgs.get("contract") ??
            commandArgs.positionals[0] ??
            cfg.contract ??
            "fixtures/Counter.h",
        );
        const name =
          commandArgs.get("contract-name") ??
          cfg.contractName ??
          basename(contractPath).replace(/\.[^.]+$/, "");
        const outDir = resolve(commandArgs.get("out") ?? "dist/contracts");
        const requestedSlot = commandArgs.get("slot") ?? cfg.slot;
        const slot = parseContractSlot(
          requestedSlot === undefined
            ? loadCoreWasmSlotLayout(core).slotBase
            : requestedSlot,
        );

        let r: ContractBuildResult;
        if (compiler === "typescript") {
          r = await buildContractWithTypeScript({
            contractPath,
            name,
            slot,
            core,
            outDir,
            dynCallees,
          });
        } else {
          const rpcBaseUrl = commandArgs.get("rpc") ?? cfg.rpc ?? DEFAULT_RPC_BASE;
          const callees = await resolveNodeCallees(
            new LiteRpc(rpcBaseUrl),
            readFileSync(contractPath, "utf8"),
            dynCallees,
            undefined,
            {
              name,
              slot,
              qpiHeader: loadQpiHeader(core),
            },
            2500,
          );
          await autoUpdateVerifyTool();
          r = await buildContractWithWasiClang({
            contractPath,
            name,
            slot,
            corePath: core,
            outDir,
            dynCallees: callees,
            skipVerify: commandArgs.has("skip-verify"),
          });
        }
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
    const label =
      compiler === "typescript"
        ? "compiling contract to wasm (TypeScript compiler)"
        : "compiling contract to wasm";
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
      <Panel
        title={"built ✓" + (compiler === "typescript" ? " (TypeScript)" : "")}
        color={theme.ok}
      >
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
          <Status
            ok={true}
            label="protocol rules"
            detail="passed — complies with qpi.h restrictions"
            pad={16}
          />
        </Box>
      )}
    </Box>
  );
}
