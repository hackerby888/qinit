import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  DEFAULT_RPC_BASE,
  LiteRpc,
  k12Hex,
} from "@qinit/core";
import { systemContractClosure } from "@qinit/build";
import {
  loadConfig,
  resolveCompilerBackend,
  resolveCoreDir,
} from "../../config";
import { systemCatalog, systemWasm } from "../../contracts/system-wasm";
import { Header, Spinner, Status } from "../../ui";
import type { CommandArguments } from "../../args";

// qinit system manages simulator selections and reports native Core contracts.
type Line = { t: string; ok?: boolean | null };

// Persist the selection into qinit.json (kept minimal — preserves the rest of the config).
function saveSelection(system: string[]): void {
  const path = "qinit.json";
  const cfg: Record<string, unknown> = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : {};
  cfg.system = system;
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}

export function System({ commandArgs }: { commandArgs: CommandArguments }) {
  const { exit } = useApp();
  const o = {
    sub: commandArgs.positionals[0] ?? "",
    names: commandArgs.positionals.slice(1),
    rpc: commandArgs.get("rpc"),
    compiler: resolveCompilerBackend(commandArgs.get("compiler")),
  };
  const cfg = loadConfig();
  const rpcBaseUrl = o.rpc || cfg.rpc || DEFAULT_RPC_BASE;
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState("starting");
  const [done, setDone] = useState(false);
  const add = (text: string, ok?: boolean | null) =>
    setLines((currentLines) => [...currentLines, { t: text, ok }]);

  useEffect(() => {
    (async () => {
      try {
        const rpc = new LiteRpc(rpcBaseUrl);
        const core = resolveCoreDir(undefined, cfg.coreDir);
        const catalog = systemCatalog(core);

        if (o.sub === "add" || o.sub === "rm") {
          if (!o.names.length) {
            add(`usage: qinit system ${o.sub} <name…>`, false);
            setDone(true);
            return;
          }
          const identity = await rpc.whoami();
          const selected = new Set(cfg.system ?? []);
          const requested = o.names.flatMap((name) => {
            const contract = catalog.find(
              (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
            );
            if (!contract) {
              add(`unknown system contract '${name}'`, false);
              return [];
            }
            return [contract];
          });

          if (o.sub === "add" && identity.backend === "simulator") {
            const dependencies = new Map(
              requested.flatMap((contract) =>
                systemContractClosure(core, contract.name).map((dependency) => [
                  dependency.index,
                  dependency,
                ] as const)
              ),
            );
            const live = new Map(
              (await rpc.dynRegistry()).contracts
                .filter((contract) => contract.armed)
                .map((contract) => [contract.index, contract]),
            );
            const built = [];
            for (const dependency of [...dependencies.values()].sort(
              (left, right) => left.index - right.index,
            )) {
              setBusy(`compiling ${dependency.name}`);
              const wasm = await systemWasm(
                dependency.name,
                core,
                o.compiler,
              );
              built.push({
                dependency,
                wasm,
                hash: await k12Hex(wasm.wasm),
              });
            }

            for (const item of built) {
              const occupant = live.get(item.dependency.index);
              if (occupant && occupant.name !== item.dependency.name) {
                throw new Error(
                  `system slot ${item.dependency.index} is occupied by '${occupant.name}'`,
                );
              }
            }

            for (const item of built) {
              const occupant = live.get(item.dependency.index);
              if (occupant?.codeHash.toLowerCase() === item.hash.toLowerCase()) {
                add(`${item.dependency.name} @ ${item.dependency.index} unchanged`, true);
                continue;
              }
              setBusy(`deploying ${item.dependency.name}`);
              const deployed = await rpc.directDeploy(
                item.wasm.index,
                item.wasm.wasm,
                item.wasm.name,
                "system",
              );
              if (!deployed) {
                throw new Error("simulator does not expose system deployment");
              }
              await rpc.putContractSource(
                item.wasm.index,
                item.dependency.source,
              );
              add(`${item.dependency.name} @ ${item.dependency.index} deployed`, true);
            }
          }

          if (o.sub === "add") {
            for (const contract of requested) {
              if (identity.backend === "core") {
                add(`${contract.name}: already embedded by the core node`, true);
              }
              selected.add(contract.name);
            }
          } else {
            for (const contract of requested) {
              selected.delete(contract.name);
            }

            if (identity.backend === "core") {
              for (const contract of requested) {
                add(
                  `${contract.name}: removed from simulator startup; still embedded by core`,
                  true,
                );
              }
            } else {
              const requiredSlots = new Set(
                [...selected].flatMap((name) =>
                  systemContractClosure(core, name).map(
                    (dependency) => dependency.index,
                  )
                ),
              );
              const removedClosure = new Map(
                requested.flatMap((contract) =>
                  systemContractClosure(core, contract.name).map(
                    (dependency) => [dependency.index, dependency] as const,
                  )
                ),
              );

              for (const contract of [...removedClosure.values()].sort(
                (left, right) => right.index - left.index,
              )) {
                if (requiredSlots.has(contract.index)) {
                  if (requested.some((item) => item.index === contract.index)) {
                    add(
                      `${contract.name}: still required by the simulator selection`,
                      true,
                    );
                  }
                  continue;
                }

                try {
                  await rpc.undeploy(contract.index);
                  add(`${contract.name} @ ${contract.index} removed`, true);
                } catch (error: any) {
                  add(
                    `${contract.name}: ${String(error?.message ?? error)}`,
                    false,
                  );
                }
              }
            }
          }
          saveSelection([...selected].sort());
          setDone(true);
          return;
        }

        // default / ls — catalog with live + selected marks.
        setBusy("reading node");
        let live = new Set<number>();
        try {
          live = new Set(
            ((await rpc.dynRegistry()).contracts ?? []).filter((c) => c.armed).map((c) => c.index),
          );
        } catch {
          /* node down -> show catalog + selection only */
        }
        const selected = new Set(cfg.system ?? []);
        for (const c of catalog) {
          const state = live.has(c.index)
            ? "live"
            : selected.has(c.name)
              ? "selected"
              : "available";
          add(
            `${String(c.index).padStart(2)}  ${c.name.padEnd(12)} ${state}`,
            live.has(c.index) ? true : null,
          );
        }
        setDone(true);
      } catch (e: any) {
        add("ERROR: " + String(e?.message ?? e), false);
        setDone(true);
      }
    })();
  }, []);
  useEffect(() => {
    if (done) {
      process.exitCode = lines.some((l) => l.ok === false) ? 1 : 0;
      const t = setTimeout(() => exit(), 30);
      return () => clearTimeout(t);
    }
  }, [done]);

  return (
    <Box flexDirection="column">
      <Header cmd="system" />
      {!done && <Spinner label={busy} />}
      {o.sub !== "add" && o.sub !== "rm" && done && lines.length > 0 && (
        <Text dimColor>{"slot  contract     state   (add: qinit system add <name…>)"}</Text>
      )}
      {lines.map((l, i) => (
        <Status key={i} ok={l.ok} label={l.t} pad={0} />
      ))}
    </Box>
  );
}
