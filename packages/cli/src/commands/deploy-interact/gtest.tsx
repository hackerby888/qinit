// `qinit gtest` runs core-lite contract_testing.h tests against an isolated simulator.
import { useEffect, useState } from "react";
import { Box, Text, Static, useApp } from "ink";
import { resolve, join, basename } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  loadConfig,
  resolveCompilerBackend,
  resolveCoreDir,
} from "../../config";
import {
  genStdGtest,
  extractIdl,
  resolveProjectDependencies,
} from "@qinit/build";
import { loadQpiHeader } from "@qinit/compiler";
import type { TestResult } from "@qinit/engine";
import { loadCoreWasmSlotLayout } from "@qinit/core";
import { runCorpus, runStdGtest } from "../../ops/corpus-run";
import { Header, Spinner, Panel, KV, Status, theme } from "../../ui";
import type { CommandArguments } from "../../args";
import { parseCallees } from "../../contracts/callees";
import { planProjectSlots } from "../../contracts/project-slots";
import { parseContractSlot } from "../../contracts/registry";

export function resolveGtestSlot(
  core: string,
  requestedSlot?: unknown,
): number {
  return parseContractSlot(
    requestedSlot === undefined
      ? loadCoreWasmSlotLayout(core).slotBase
      : requestedSlot,
  );
}

// Render the TS compiler's per-phase timings as a one-line breakdown (short labels, in pipeline order).
function fmtTimings(t?: Record<string, number>): string | undefined {
  if (!t) return undefined;
  const order: [string, string][] = [
    ["loading qpi.h", "qpi"],
    ["preprocessing", "pre"],
    ["parsing", "parse"],
    ["analyzing", "analyze"],
    ["generating wasm", "codegen"],
    ["assembling wasm", "wabt"],
  ];
  const parts = order
    .filter(([k]) => t[k] != null)
    .map(([k, lbl]) => `${lbl} ${Math.round(t[k])}ms`);
  if (!parts.length) return undefined;
  const total = Math.round(Object.values(t).reduce((a, b) => a + b, 0));
  return `${parts.join(" · ")} · total ${total}ms`;
}

interface Line {
  label: string;
  ok?: boolean | null;
  detail?: string;
}
// Keep completed output in Static items; reserve the live tail for the spinner or summary.
type Item =
  | { kind: "header" }
  | { kind: "line"; line: Line }
  | { kind: "test"; t: TestResult }
  | { kind: "note"; text: string };
type Tail =
  { phase: "work"; spin: string } | { phase: "done"; ok: boolean; rows: [string, string][] };

export function Gtest({ commandArgs }: { commandArgs: CommandArguments }) {
  const { exit } = useApp();
  const cfg = loadConfig();
  const filter = commandArgs.get("filter");
  const firstPositional = commandArgs.positionals[0];
  const explicitCallees = parseCallees(commandArgs.getAll("callee"));
  const [items, setItems] = useState<Item[]>([{ kind: "header" }]);
  const [s, setS] = useState<Tail>({ phase: "work", spin: "starting" });

  useEffect(() => {
    const add = (label: string, ok?: boolean | null, detail?: string) =>
      setItems((it) => [...it, { kind: "line", line: { label, ok, detail } }]);
    const note = (text: string) => setItems((it) => [...it, { kind: "note", text }]); // full-width, wraps (no truncation)
    const spin = (t: string) => setS({ phase: "work", spin: t });
    const done = (ok: boolean, rows: [string, string][]) => setS({ phase: "done", ok, rows });

    const matches = (name: string) =>
      !filter || name.toLowerCase().includes(filter.toLowerCase());
    let ran = 0;
    // Stream each finished test the moment the engine reports it (engine yields a macrotask per test so
    // this paints). Filtered-out tests still execute engine-side; we just don't surface them.
    const onResult = (t: TestResult) => {
      if (!matches(t.name)) return;
      ran++;
      setItems((it) => [...it, { kind: "test", t }]);
      setS({ phase: "work", spin: `running tests… ${ran} done` });
    };

    (async () => {
      try {
        const core = resolveCoreDir(commandArgs.get("core-dir"), cfg.coreDir);
        const backend = resolveCompilerBackend(commandArgs.get("compiler"));

        // Run a core-lite contract_testing.h suite on an isolated engine.
        if (commandArgs.has("corpus")) {
          const scName = commandArgs.get("corpus") || firstPositional;
          if (!scName) {
            add("corpus", false, "pass a system contract name, e.g. --corpus QUTIL");
            return done(false, []);
          }
          spin(`building the real gtest for ${scName} (${backend})`);
          const run = await runCorpus({
            name: scName,
            core,
            backend,
            scratch: join(tmpdir(), "qinit-corpus"),
            onResult,
            onPhase: backend === "typescript" ? (label) => spin(label) : undefined,
          });
          if (!run.found) {
            add("corpus", false, `unknown contract '${scName}'`);
            return done(false, [["available", run.available.join(" ")]]);
          }
          if (!run.hasCorpus) {
            add("corpus", false, `${run.name} has no test/contract_*.cpp in core-lite`);
            return done(false, []);
          }
          if (!run.runnerOk) {
            add("build", false, "test-wasm build failed");
            return done(false, [["stderr", (run.buildError ?? "").slice(0, 400)]]);
          }
          const results = run.results.filter((t) => matches(t.name));
          const pass = results.filter((t) => t.passed).length;
          const ok = results.length > 0 && pass === results.length;
          add("tests", ok, `${pass}/${results.length} passed`);
          const ctiming = fmtTimings(run.timings);
          if (ctiming) note(`  compile   ${ctiming}`);
          return done(ok, [
            ["contract", `${run.name} @ ${run.slot}${run.heavy ? " (heavy/shared-mem)" : ""}`],
            ["backend", backend === "typescript" ? "TypeScript compiler" : "clang"],
            ["test", `real gtest — ${run.name.toLowerCase()} suite`],
            ["node", "in-process engine (isolated genesis)"],
          ]);
        }

        // One accepted source format: core-lite contract_testing.h / ContractTesting.
        const contractPath = resolve(
          commandArgs.get("contract") ??
            cfg.contract ??
            "contracts/" + (cfg.contractName ?? "") + ".h",
        );
        if (!existsSync(contractPath)) {
          add("contract", false, contractPath + " not found");
          return done(false, []);
        }
        const name =
          commandArgs.get("contract-name") ??
          cfg.contractName ??
          basename(contractPath).replace(/\.[^.]+$/, "");
        const stateType = commandArgs.get("state-type") ?? name;
        const requestedSlot = commandArgs.get("slot") ?? cfg.slot;
        const contractSrc = readFileSync(contractPath, "utf8");
        const testPath = resolve(
          firstPositional ?? join("tests", `${name}.test.cpp`),
        );
        const existingTestSource =
          existsSync(testPath) && !commandArgs.has("new")
            ? readFileSync(testPath, "utf8")
            : undefined;
        const slotLayout = loadCoreWasmSlotLayout(core);
        const dependencyGraph = resolveProjectDependencies({
          projectRoot: process.cwd(),
          corePath: core,
          contractName: stateType,
          contractPath,
          contractIndex: requestedSlot === undefined
            ? undefined
            : resolveGtestSlot(core, requestedSlot),
          explicitCallees,
          additionalRootSource: existingTestSource,
        });
        const plannedSlots = planProjectSlots(dependencyGraph, slotLayout);
        const plannedContracts = dependencyGraph.map((contract, index) => ({
          ...contract,
          index: plannedSlots[index].index,
        }));
        const plannedMain = plannedContracts[plannedContracts.length - 1];
        if (!plannedMain) {
          throw new Error(`cannot resolve the ${name} contract graph`);
        }
        const slot = plannedMain.index;
        const plannedDependencies = plannedContracts.slice(0, -1);
        const projectDependencies = plannedDependencies.map((contract) => ({
          contractPath: contract.sourcePath,
          name: contract.name,
          stateType: contract.stateType,
          slot: contract.index,
        }));
        const dynCallees = Object.fromEntries(
          plannedDependencies
            .filter((contract) => contract.kind === "custom")
            .map((contract) => [
              contract.stateType,
              {
                header: contract.sourcePath,
                index: contract.index,
              },
            ]),
        );
        // Scaffold the test when missing (or --new).
        if (!existsSync(testPath) || commandArgs.has("new")) {
          const idl = extractIdl(contractSrc, name, {
            slot,
            qpiHeader: loadQpiHeader(core),
            stateType,
          });
          mkdirSync(join(testPath, ".."), { recursive: true });
          writeFileSync(testPath, genStdGtest(idl, name, stateType));
          add("scaffold", true, `${testPath.replace(process.cwd() + "/", "")} (core-lite)`);
        }

        spin(`building the gtest for ${name} (${backend})`);
        const run = await runStdGtest({
          contractPath,
          testPath,
          name,
          stateType,
          slot,
          core,
          backend,
          projectDependencies,
          dynCallees,
          shared: commandArgs.has("shared-mem"),
          scratch: join(tmpdir(), "qinit-corpus"),
          onResult,
          onPhase: backend === "typescript" ? (label) => spin(label) : undefined,
        });
        if (!run.runnerOk) {
          add("build", false, "test-wasm build failed");
          return done(false, [["stderr", (run.buildError ?? "").slice(0, 400)]]);
        }
        const ctiming = fmtTimings(run.timings);
        if (ctiming) note(`  compile   ${ctiming}`);
        const rr = run.results.filter((t) => matches(t.name));
        const pass = rr.filter((t) => t.passed).length;
        const ok = rr.length > 0 && pass === rr.length;
        add("tests", ok, `${pass}/${rr.length} passed`);
        return done(ok, [
          ["contract", `${name} @ ${slot}${run.heavy ? " (shared-mem)" : ""}`],
          ["backend", backend === "typescript" ? "TypeScript compiler" : "clang"],
          ["test", testPath.replace(process.cwd() + "/", "")],
          ["node", "in-process engine (isolated genesis)"],
        ]);
      } catch (e: any) {
        add("ERROR", false, String(e?.message ?? e));
        done(false, []);
      }
    })();
  }, []);

  useEffect(() => {
    if (s.phase === "done") {
      process.exitCode = s.ok ? 0 : 1;
      exit();
    }
  }, [s, exit]);

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(it, i) =>
          it.kind === "header" ? (
            <Header key={i} cmd="gtest" />
          ) : it.kind === "line" ? (
            <Status
              key={i}
              ok={it.line.ok}
              label={it.line.label}
              detail={it.line.detail}
              pad={10}
            />
          ) : it.kind === "note" ? (
            <Text key={i} dimColor>
              {it.text}
            </Text>
          ) : (
            <Box key={i} flexDirection="column">
              <Text color={it.t.passed ? theme.ok : theme.err}>
                {it.t.passed ? "✓" : "✗"} {it.t.name}
              </Text>
              {!it.t.passed && it.t.message ? <Text dimColor>{it.t.message.trim()}</Text> : null}
            </Box>
          )
        }
      </Static>
      {s.phase === "work" && (
        <Box marginTop={1}>
          <Spinner label={s.spin} color={theme.accent} />
        </Box>
      )}
      {s.phase === "done" && s.rows.length > 0 && (
        <Box marginTop={1}>
          <Panel title={s.ok ? "passed ✓" : "failed"} color={s.ok ? theme.ok : theme.err}>
            <KV rows={s.rows} />
          </Panel>
        </Box>
      )}
    </Box>
  );
}
