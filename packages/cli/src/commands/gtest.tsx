// `qinit gtest` — compile a contract's C++ gtest INTO its wasm (core-lite extensions/lite_test.h) and run it on
// a fresh, isolated in-process Virtual Node. No native toolchain, no node deploy: the same combined-module path
// the IDE "Run gtest" button uses, here in Bun. Scaffolds tests/<Name>.test.cpp from the IDL when absent.
import { useEffect, useState } from "react";
import { Box, Text, Static, useApp } from "ink";
import { resolve, join, basename } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig, resolveCore } from "../config";
import { buildContract, genGtest, extractIdl, qpiPrelude } from "@qinit/build";
import { runTests, runTestsAgainst, type TestResult } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "@qinit/compile";
import { runCorpus } from "../corpus-run";
import { Header, Spinner, Panel, KV, Status, theme } from "../ui";

function parse(args: string[]): { flags: Record<string, string>; pos: string[] } {
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const n = args[i + 1];
      flags[a.slice(2)] = n !== undefined && !n.startsWith("--") ? args[++i] : "";
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
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
  const parts = order.filter(([k]) => t[k] != null).map(([k, lbl]) => `${lbl} ${Math.round(t[k])}ms`);
  if (!parts.length) return undefined;
  const total = Math.round(Object.values(t).reduce((a, b) => a + b, 0));
  return `${parts.join(" · ")} · total ${total}ms`;
}

interface Line {
  label: string;
  ok?: boolean | null;
  detail?: string;
}
// Everything permanent (header, build status, each finished test) is an append-only Static item so it
// commits to the terminal top-to-bottom and survives a suite taller than the viewport; only the spinner
// (or the final summary box) lives in the dynamic tail below it.
type Item = { kind: "header" } | { kind: "line"; line: Line } | { kind: "test"; t: TestResult } | { kind: "note"; text: string };
type Tail =
  | { phase: "work"; spin: string }
  | { phase: "done"; ok: boolean; rows: [string, string][] };

export function Gtest({ args }: { args: string[] }) {
  const { exit } = useApp();
  const { flags: o, pos } = parse(args);
  const cfg = loadConfig();
  const [items, setItems] = useState<Item[]>([{ kind: "header" }]);
  const [s, setS] = useState<Tail>({ phase: "work", spin: "starting" });

  useEffect(() => {
    const add = (label: string, ok?: boolean | null, detail?: string) => setItems((it) => [...it, { kind: "line", line: { label, ok, detail } }]);
    const note = (text: string) => setItems((it) => [...it, { kind: "note", text }]); // full-width, wraps (no truncation)
    const spin = (t: string) => setS({ phase: "work", spin: t });
    const done = (ok: boolean, rows: [string, string][]) => setS({ phase: "done", ok, rows });

    const matches = (name: string) => !o.filter || name.toLowerCase().includes(o.filter.toLowerCase());
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
        const core = resolveCore(o.core, cfg.core);

        // --corpus <NAME>: run a system contract's REAL gtest (core-lite test/contract_<x>.cpp, the
        // contract_testing.h suite) on an isolated engine. Contract built by native clang, or by our TS
        // compiler with --local. Everything (header, test, deps, slot) derives from the core-lite checkout.
        if ("corpus" in o) {
          const scName = o.corpus || pos[0];
          if (!scName) {
            add("corpus", false, "pass a system contract name, e.g. --corpus QUTIL");
            return done(false, []);
          }
          const backend = "local" in o ? "local" : "native";
          spin(`building the real gtest for ${scName} (${backend})`);
          const run = await runCorpus({
            name: scName, core, backend, scratch: join(tmpdir(), "qinit-corpus"), onResult,
            onPhase: backend === "local" ? (label) => spin(label) : undefined,
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
            ["backend", backend === "local" ? "local TS compiler" : "native clang"],
            ["test", `real gtest — ${run.name.toLowerCase()} suite`],
            ["node", "in-process engine (isolated genesis)"],
          ]);
        }

        const contractPath = resolve(o.contract ?? cfg.contract ?? "contracts/" + (cfg.name ?? "") + ".h");
        if (!existsSync(contractPath)) {
          add("contract", false, contractPath + " not found");
          return done(false, []);
        }
        const name = o.name ?? cfg.name ?? basename(contractPath).replace(/\.[^.]+$/, "");
        const slot = Number.isFinite(Number(o.slot)) ? Number(o.slot) : 1;
        const contractSrc = readFileSync(contractPath, "utf8");

        // The test file: a positional arg, else tests/<Name>.test.cpp. Scaffold it from the IDL when missing.
        const testPath = resolve(pos[0] ?? join("tests", `${name}.test.cpp`));
        if (!existsSync(testPath) || o.new !== undefined) {
          const idl = extractIdl(contractSrc, name, { prelude: qpiPrelude(core) });
          mkdirSync(join(testPath, ".."), { recursive: true });
          writeFileSync(testPath, genGtest(idl));
          add("scaffold", true, testPath.replace(process.cwd() + "/", ""));
        }
        const testSrc = readFileSync(testPath, "utf8");

        spin("compiling contract + test → wasm");
        const outDir = join(tmpdir(), "qinit-gtest");
        mkdirSync(outDir, { recursive: true });
        const r = await buildContract({ contractPath, name, slot, corePath: core, outDir, skipVerify: true, testSource: testSrc, testPath: basename(testPath) });
        if (!r.ok || !r.so) {
          add("build", false, "compile failed");
          return done(false, [["stderr", (r.stderr ?? "").trim().split("\n").slice(-6).join("\n")]]);
        }
        add("build", true, `${((r.size ?? 0) / 1024) | 0}KB wasm`);

        // --local: run the SAME native test runner against a contract built by our TS compiler (differential).
        // The gtest harness stays native-clang (our compiler doesn't compile lite_test.h); only the
        // contract-under-test swaps backends, deployed at a separate slot by runTestsAgainst.
        let results: TestResult[];
        let localTimings: Record<string, number> | undefined;
        if ("local" in o) {
          spin("compiling contract with local TS compiler");
          const qpiHeader = loadQpiHeader(core);
          if (!qpiHeader) {
            add("compile", false, "cannot load qpi.h — set QINIT_CORE or --core");
            return done(false, []);
          }
          const cres = await compileContract({ source: contractSrc, name, slot, qpiHeader, onPhase: (p) => spin(`compiling ${name} (local) — ${p}`) });
          localTimings = cres.timings;
          const errs = cres.diagnostics.filter((d) => d.severity === "error");
          if (errs.length) {
            add("compile", false, `${errs.length} error(s)`);
            return done(false, [["diagnostics", errs.slice(0, 6).map((d) => d.message).join("\n")]]);
          }
          add("compile", true, `${(cres.wasm.byteLength / 1024) | 0}KB wasm (local)`);
          spin("running tests on a fresh, isolated virtual node (local backend)");
          results = await runTestsAgainst(new Uint8Array(readFileSync(r.so)), cres.wasm, onResult);
        } else {
          spin("running tests on a fresh, isolated virtual node");
          results = await runTests(new Uint8Array(readFileSync(r.so)), onResult);
        }
        const filtered = results.filter((t) => matches(t.name));
        const pass = filtered.filter((t) => t.passed).length;
        const ok = filtered.length > 0 && pass === filtered.length;
        add("tests", ok, `${pass}/${filtered.length} passed`);
        const ltiming = fmtTimings(localTimings);
        if (ltiming) note(`  compile   ${ltiming}`);
        done(ok, [
          ["contract", `${name} @ ${slot}`],
          ["backend", "local" in o ? "local TS compiler (differential)" : "native clang"],
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
            <Status key={i} ok={it.line.ok} label={it.line.label} detail={it.line.detail} pad={10} />
          ) : it.kind === "note" ? (
            <Text key={i} dimColor>{it.text}</Text>
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
