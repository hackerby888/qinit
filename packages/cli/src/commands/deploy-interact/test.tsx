import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { resolve, join, basename } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import {
  loadConfig,
  resolveCompilerBackend,
  resolveCoreDir,
  resolveNodeBackend,
} from "../../config";
import type { DeploymentEvent } from "../../ops/deploy";
import { deployProjectContracts } from "../../ops/project-deploy";
import {
  activeNodeScratchDir,
  ensureNodeBinary,
  killNode,
  launchNode,
  waitTicking,
} from "../../ops/node";
import {
  DEFAULT_RPC_BASE,
  LiteRpc,
  resolveTrapBacktrace,
  formatTrapBacktrace,
} from "@qinit/core";
import { testRuntimeSource, sampleTest, generateClient, extractIdl } from "@qinit/build";
import { loadQpiHeader } from "@qinit/compiler";
import { EngineServer } from "@qinit/engine/server";
import { Header, Spinner, Panel, KV, Status, theme } from "../../ui";
import { DEFAULT_IDL_PATH, loadContractIdlFile } from "../../contracts/idl-file";
import { parseCallees } from "../../contracts/callees";
import { parseContractSlot } from "../../contracts/registry";
import type { CommandArguments } from "../../args";
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
  const rpcBaseUrl = commandArgs.get("rpc") ?? cfg.rpc ?? DEFAULT_RPC_BASE;
  const contractPath = resolve(
    commandArgs.get("contract") ??
      commandArgs.positionals[0] ??
      cfg.contract ??
      "contracts/" + (cfg.contractName ?? "") + ".h",
  );
  const contractName =
    commandArgs.get("contract-name") ??
    cfg.contractName ??
    basename(contractPath).replace(/\.[^.]+$/, "");
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
        // bun is required to run the test files. (Bun.which is cross-platform — no `sh` on Windows.)
        if (!Bun.which("bun")) {
          add("bun", false, "not found — qinit test needs bun (https://bun.sh)");
          setS({ phase: "done", lines, ok: false, output: "", rows: [] });
          return;
        }
        const core = resolveCoreDir(commandArgs.get("core-dir"), cfg.coreDir);
        if (!existsSync(contractPath)) {
          add("contract", false, contractPath + " not found");
          setS({ phase: "done", lines, ok: false, output: "", rows: [] });
          return;
        }

        const useSimulator =
          resolveNodeBackend(commandArgs.get("node-backend")) === "simulator";
        if (useSimulator) {
          spin("starting in-process simulator");
          engineSrv = new EngineServer();
          activeRpc = (await engineSrv.start()).rpcBaseUrl;
          // A test run reads assertions, not traces — skip the per-call state snapshot a node keeps.
          engineSrv.engine.setDebug(false);
          add("node", true, `simulator @ ${activeRpc}`);
        } else {
          spin("checking node");
          const ticking = await isTicking(activeRpc);
          const runningBackend = ticking
            ? (await new LiteRpc(activeRpc).whoami()).backend
            : undefined;
          if (!ticking || runningBackend !== "core") {
            spin("starting core node");
            // Reuse a compatible ticking Core node; otherwise launch the selected binary.
            const requestedNodeBinary = commandArgs.get("node-bin");
            let nodeBinary = requestedNodeBinary ? resolve(requestedNodeBinary) : "";
            let nodeNote = "";
            if (!nodeBinary) {
              spin("resolving node");
              const r = await ensureNodeBinary(
                commandArgs.get("ref"),
                (rc, tt) =>
                  spin(
                    tt
                      ? `node ${(rc / 1e6) | 0}/${(tt / 1e6) | 0} MB`
                      : `node ${(rc / 1e6) | 0} MB`,
                  ),
              );
              nodeBinary = r.nodeBinaryPath;
              if (r.cached) nodeNote = ` · cached ${r.version}`;
            }
            await killNode();
            if (
              runningBackend &&
              runningBackend !== "core" &&
              await isTicking(activeRpc)
            ) {
              add(
                "node",
                false,
                `${activeRpc} is served by an untracked ${runningBackend} node`,
              );
              setS({ phase: "done", lines, ok: false, output: "", rows: [] });
              return;
            }
            launchNode({
              nodeBinary,
              nodeMode: commandArgs.get("node-mode"),
              peers: commandArgs.get("peers"),
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
            slotOverride: requestedSlot === undefined
              ? undefined
              : parseContractSlot(requestedSlot),
            skipVerify,
            compiler: resolveCompilerBackend(requestedCompiler),
          },
          (e: DeploymentEvent) => {
            if ("note" in e) return;
            if (e.state === "active" && e.detail)
              spin(`deploy · ${STEP_LABEL[e.step] ?? e.step}: ${e.detail}`);
            if (e.step === "build" && e.state === "fail") depDetail = e.detail ?? "build failed";
          },
        );
        if (!dep.ok || dep.slot === undefined) {
          add("deploy", false, dep.error || depDetail || "failed");
          setS({ phase: "done", lines, ok: false, output: "", rows: [] });
          return;
        }
        add(
          "deploy",
          true,
          `${contractName} @ slot ${dep.slot}${dep.reused ? " (reuse)" : ""}`,
        );
        const synchronized = dep.deployments.filter(
          (deployment) => deployment.kind !== "main",
        );
        if (synchronized.length) {
          add(
            "dependencies",
            true,
            synchronized
              .map((deployment) =>
                `${deployment.name}@${deployment.slot} ${deployment.action}`
              )
              .join(" · "),
          );
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
        writeFileSync(
          join(sdkDir, `${contractName}.ts`),
          generateClient(idl, dep.slot, { runtimeImport: "./runtime" }),
        );
        writeFileSync(
          join(sdkDir, "index.ts"),
          `export * from "./runtime";\nexport { ${contractName} } from "./${contractName}";\n`,
        );
        // scaffold a sample test if the project has none
        const testsDir = join(root, "tests");
        const hasTest = readdirSync(testsDir).some((f) => f.endsWith(".test.ts"));
        if (!hasTest) {
          writeFileSync(
            join(testsDir, `${contractName}.test.ts`),
            sampleTest(contractName),
          );
        }
        add(
          "sdk",
          true,
          `tests/.qinit/ (${idl.functions.length} fn / ${idl.procedures.length} proc)`,
        );

        // The generated SDK bundles its own crypto, so the project needs no dependency — only ESM.
        const pkgPath = join(root, "package.json");
        const pkg: any = existsSync(pkgPath)
          ? JSON.parse(readFileSync(pkgPath, "utf8"))
          : { name: basename(root), private: true };
        pkg.type ??= "module";
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

        const testSeed = seed || (await new LiteRpc(activeRpc).fundedSeed()) || "a".repeat(55);
        setS({ phase: "testing", lines: [...lines] });
        const env = {
          ...process.env,
          QINIT_RPC: activeRpc,
          QINIT_SEED: testSeed,
          QINIT_CONTRACT: String(dep.slot),
        };
        // generous per-test timeout — procedures wait ~tick offset (settle), well past bun's 5s default.
        const bunArgs = [
          "test",
          existsSync(testsDir) ? "tests" : ".",
          "--timeout",
          timeout,
          ...(filter ? ["-t", filter] : []),
        ];
        const p = Bun.spawn(["bun", ...bunArgs], {
          cwd: root,
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
        ]);
        await p.exited;
        let output = stripAnsi((out + err).trim());
        const ok = p.exitCode === 0;
        if (!ok) {
          // append a source-mapped backtrace of the latest node trap (node.log + the slot's line map)
          try {
            const idl = loadContractIdlFile(join(root, DEFAULT_IDL_PATH));
            const log = join(activeNodeScratchDir(), "node.log");
            if (existsSync(log)) {
              const bt = resolveTrapBacktrace(readFileSync(log, "utf8"), {
                lineMapPath: idl.contracts[String(dep.slot)]?.linesJson,
              });
              if (bt?.frames.length) output += "\n\n" + formatTrapBacktrace(bt);
            }
          } catch (error: any) {
            output += `\n\n${String(error?.message ?? error)}`;
          }
        }
        add("tests", ok, ok ? "all passed" : "failures (see below)");

        setS({
          phase: "done",
          lines,
          ok,
          output,
          rows: [
            ["contract", `${contractName} @ ${dep.slot}`],
            ["rpc", activeRpc],
            [
              "node",
              engineSrv
                ? "simulator"
                : ownNode
                  ? !keepNode
                    ? "launched for test (stopped)"
                    : "launched for test (kept)"
                  : "reused",
            ],
          ],
        });
      } catch (e: any) {
        add("ERROR", false, String(e?.message ?? e));
        setS({ phase: "done", lines, ok: false, output: "", rows: [] });
      } finally {
        try {
          if (ownNode && !keepNode) {
            await killNode();
          }
        } catch {}
        engineSrv?.stop();
      }
    })();
  }, []);
  useEffect(() => {
    if (s.phase === "done") {
      process.exitCode = s.ok ? 0 : 1;
      exit();
    }
  }, [s, exit]);

  const lines = s.lines;
  return (
    <Box flexDirection="column">
      <Header cmd="test" />
      <Box flexDirection="column">
        {lines.map((l, i) => (
          <Status key={i} ok={l.ok} label={l.label} detail={l.detail} pad={10} />
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
