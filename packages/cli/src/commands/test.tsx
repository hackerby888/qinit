import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { resolve, join, basename } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { loadConfig, resolveCore, savedMode, resolveCompiler } from "../config";
import { deployContract, type Ev } from "../deploy-ops";
import { launchNode, waitTicking, killNode, ensureNode, scratchDir } from "../node-ops";
import { LiteRpc, resolveTrapBacktrace, formatTrapBacktrace } from "@qinit/core";
import { testRuntimeSource, sampleTest, generateClient, extractIdl } from "@qinit/build";
import { EngineServer } from "@qinit/engine/server";
import { Header, Spinner, Panel, KV, Status, theme } from "../ui";

function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const n = args[i + 1];
      o[a.slice(2)] = n !== undefined && !n.startsWith("--") ? args[++i] : "";
    }
  }
  return o;
}
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
async function isTicking(rpcBase: string): Promise<boolean> {
  const rpc = new LiteRpc(rpcBase);
  try {
    const a = (await rpc.tickInfo()).tick ?? 0;
    await sleep(1300);
    const b = (await rpc.tickInfo()).tick ?? 0;
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

export function Test({ args }: { args: string[] }) {
  const { exit } = useApp();
  const o = parse(args);
  const cfg = loadConfig();
  const root = process.cwd();
  const rpcBase = o.rpc ?? cfg.rpc ?? "http://127.0.0.1:41841";
  const contractPath = resolve(
    o.contract ?? cfg.contract ?? "contracts/" + (cfg.name ?? "") + ".h",
  );
  const name = o.name ?? cfg.name ?? basename(contractPath).replace(/\.[^.]+$/, "");
  const [s, setS] = useState<State>({ phase: "setup", spin: "starting", lines: [] });

  useEffect(() => {
    let ownNode = false;
    let activeRpc = rpcBase;
    let engineSrv: EngineServer | null = null;
    const L: Line[] = [];
    const add = (label: string, ok?: boolean | null, detail?: string) => {
      L.push({ label, ok, detail });
    };
    const spin = (spin: string) => setS({ phase: "setup", spin, lines: [...L] });

    (async () => {
      try {
        // bun is required to run the test files. (Bun.which is cross-platform — no `sh` on Windows.)
        if (!Bun.which("bun")) {
          add("bun", false, "not found — qinit test needs bun (https://bun.sh)");
          setS({ phase: "done", lines: L, ok: false, output: "", rows: [] });
          return;
        }
        const core = resolveCore(o.core, cfg.core);
        if (!existsSync(contractPath)) {
          add("contract", false, contractPath + " not found");
          setS({ phase: "done", lines: L, ok: false, output: "", rows: [] });
          return;
        }

        // 1) node — virtual (in-process TS engine) or real (ephemeral qubic node), chosen by `qinit mode`.
        // An explicit flag wins over the saved selection; with neither, the saved mode decides (default real).
        const wantVirtual =
          "in-process" in o ||
          "engine" in o ||
          (savedMode() === "virtualnode" && !("real" in o) && !("realnode" in o));
        if (wantVirtual) {
          spin("starting in-process engine");
          engineSrv = new EngineServer();
          activeRpc = (await engineSrv.start()).rpcBase;
          add("node", true, `in-process engine @ ${activeRpc}`);
        } else {
          spin("checking node");
          if (!(await isTicking(activeRpc))) {
            spin("starting ephemeral node");
            // Prefer the latest release node; fall back to a cached one only offline (don't silently
            // run a stale pinned version against newer tooling).
            let bin = o.bin ? resolve(o.bin) : "";
            let nodeNote = "";
            if (!bin) {
              spin("resolving node");
              const r = await ensureNode(o.ref || "latest", (rc, tt) =>
                spin(
                  tt ? `node ${(rc / 1e6) | 0}/${(tt / 1e6) | 0} MB` : `node ${(rc / 1e6) | 0} MB`,
                ),
              );
              bin = r.bin;
              if (r.stale) nodeNote = ` · cached ${r.version} (offline)`;
            }
            await killNode();
            launchNode({ bin, mode: o["node-mode"], peers: o.peers });
            ownNode = true;
            spin("waiting for ticking");
            const w = await waitTicking(activeRpc, Number(o.wait || 60));
            if (!w.ticking) {
              add("node", false, w.exited ? "exited early — see log" : "not ticking");
              setS({ phase: "done", lines: L, ok: false, output: "", rows: [] });
              return;
            }
            add("node", true, `ephemeral · ticking at ${w.tick}${nodeNote}`);
          } else {
            add("node", true, "reused running node");
          }
        }

        // 2) deploy inter-contract callees first, so the main contract's CALL_OTHER_CONTRACT names resolve from
        //    the node registry (deploy submits each callee's .h; the main build then auto-derives type + slot).
        for (const callee of cfg.callees ?? []) {
          const cpath = resolve(callee.contract);
          if (!existsSync(cpath)) {
            add("callee", false, `${callee.name}: ${cpath} not found`);
            if (ownNode && o.keep === undefined) await killNode();
            engineSrv?.stop();
            setS({ phase: "done", lines: L, ok: false, output: "", rows: [] });
            return;
          }
          spin(`deploying callee ${callee.name}`);
          const cd = await deployContract(
            {
              contractPath: cpath,
              name: callee.name,
              core,
              rpcBase: activeRpc,
              seed: o.seed,
              skipVerify: "skip-verify" in o,
              compiler: resolveCompiler(o),
            },
            () => {},
          );
          if (!cd.ok || cd.slot === undefined) {
            add("callee", false, `${callee.name}: ${cd.error ?? "deploy failed"}`);
            if (ownNode && o.keep === undefined) await killNode();
            engineSrv?.stop();
            setS({ phase: "done", lines: L, ok: false, output: "", rows: [] });
            return;
          }
          add("callee", true, `${callee.name} @ slot ${cd.slot}`);
        }

        // 3) build + deploy the main contract (also runs the protocol-rule gate).
        spin("deploying contract");
        let depDetail = "";
        const dep = await deployContract(
          {
            contractPath,
            name,
            core,
            rpcBase: activeRpc,
            seed: o.seed,
            skipVerify: "skip-verify" in o,
            compiler: resolveCompiler(o),
          },
          (e: Ev) => {
            if ("note" in e) return;
            if (e.state === "active" && e.detail)
              spin(`deploy · ${STEP_LABEL[e.step] ?? e.step}: ${e.detail}`);
            if (e.step === "build" && e.state === "fail") depDetail = e.detail ?? "build failed";
          },
        );
        if (!dep.ok || dep.slot === undefined) {
          add("deploy", false, dep.error || depDetail || "failed");
          if (ownNode && o.keep === undefined) await killNode();
          engineSrv?.stop();
          setS({ phase: "done", lines: L, ok: false, output: "", rows: [] });
          return;
        }
        add("deploy", true, `${name} @ slot ${dep.slot}${dep.reused ? " (reuse)" : ""}`);

        // 3) emit the self-contained test SDK (runtime + typed client + barrel).
        spin("generating test SDK");
        const idl = dep.idl ?? extractIdl(readFileSync(contractPath, "utf8"), name);
        const sdkDir = join(root, "tests", ".qinit");
        mkdirSync(sdkDir, { recursive: true });
        writeFileSync(join(sdkDir, "runtime.ts"), testRuntimeSource);
        writeFileSync(
          join(sdkDir, `${name}.ts`),
          generateClient(idl, dep.slot, { runtimeImport: "./runtime" }),
        );
        writeFileSync(
          join(sdkDir, "index.ts"),
          `export * from "./runtime";\nexport { ${name} } from "./${name}";\n`,
        );
        // scaffold a sample test if the project has none
        const testsDir = join(root, "tests");
        const hasTest = readdirSync(testsDir).some((f) => f.endsWith(".test.ts"));
        if (!hasTest) writeFileSync(join(testsDir, `${name}.test.ts`), sampleTest(name));
        add(
          "sdk",
          true,
          `tests/.qinit/ (${Object.keys(idl.functions).length} fn / ${Object.keys(idl.procedures).length} proc)`,
        );

        // 4) ensure the one public dep + install if needed.
        const pkgPath = join(root, "package.json");
        const pkg: any = existsSync(pkgPath)
          ? JSON.parse(readFileSync(pkgPath, "utf8"))
          : { name: basename(root), private: true };
        pkg.type ??= "module";
        pkg.devDependencies ??= {};
        let needInstall = !existsSync(join(root, "node_modules", "@qubic-lib", "qubic-ts-library"));
        if (!pkg.devDependencies["@qubic-lib/qubic-ts-library"]) {
          pkg.devDependencies["@qubic-lib/qubic-ts-library"] = "latest";
          needInstall = true;
        }
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
        if (needInstall) {
          spin("bun install (@qubic-lib/qubic-ts-library)");
          Bun.spawnSync(["bun", "install"], { cwd: root, stdout: "ignore", stderr: "ignore" });
        }
        add("deps", true, "@qubic-lib/qubic-ts-library");

        // 5) run bun test with the provider env injected.
        const seed = o.seed || (await new LiteRpc(activeRpc).fundedSeed()) || "a".repeat(55);
        setS({ phase: "testing", lines: [...L] });
        const env = {
          ...process.env,
          QINIT_RPC: activeRpc,
          QINIT_SEED: seed,
          QINIT_CONTRACT: String(dep.slot),
        };
        // generous per-test timeout — procedures wait ~tick offset (settle), well past bun's 5s default.
        const bunArgs = [
          "test",
          existsSync(testsDir) ? "tests" : ".",
          "--timeout",
          o.timeout || "60000",
          ...(o.filter ? ["-t", o.filter] : []),
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
            const all = existsSync(join(root, "qinit.idl.json"))
              ? JSON.parse(readFileSync(join(root, "qinit.idl.json"), "utf8"))
              : {};
            const log = join(scratchDir(), "node.log");
            if (existsSync(log)) {
              const bt = resolveTrapBacktrace(readFileSync(log, "utf8"), {
                lineMapPath: all[String(dep.slot)]?.linesJson,
              });
              if (bt?.frames.length) output += "\n\n" + formatTrapBacktrace(bt);
            }
          } catch {}
        }
        add("tests", ok, ok ? "all passed" : "failures (see below)");

        if (ownNode && o.keep === undefined) await killNode();
        engineSrv?.stop();
        setS({
          phase: "done",
          lines: L,
          ok,
          output,
          rows: [
            ["contract", `${name} @ ${dep.slot}`],
            ["rpc", activeRpc],
            [
              "node",
              engineSrv
                ? "in-process engine"
                : ownNode
                  ? o.keep === undefined
                    ? "ephemeral (stopped)"
                    : "ephemeral (kept)"
                  : "reused",
            ],
          ],
        });
      } catch (e: any) {
        add("ERROR", false, String(e?.message ?? e));
        if (ownNode && o.keep === undefined)
          try {
            await killNode();
          } catch {}
        engineSrv?.stop();
        setS({ phase: "done", lines: L, ok: false, output: "", rows: [] });
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
