// `qinit gtest` — compile a contract's C++ gtest INTO its wasm (core-lite extensions/lite_test.h) and run it on
// a fresh, isolated in-process Virtual Node. No native toolchain, no node deploy: the same combined-module path
// the IDE "Run gtest" button uses, here in Bun. Scaffolds tests/<Name>.test.cpp from the IDL when absent.
import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { resolve, join, basename } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig, resolveCore } from "../config";
import { buildContract, genGtest, extractIdl, qpiPrelude } from "@qinit/build";
import { runTests, type TestResult } from "@qinit/engine";
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

interface Line {
  label: string;
  ok?: boolean | null;
  detail?: string;
}
type State =
  | { phase: "work"; spin: string; lines: Line[] }
  | { phase: "done"; lines: Line[]; ok: boolean; results: TestResult[]; rows: [string, string][] };

export function Gtest({ args }: { args: string[] }) {
  const { exit } = useApp();
  const { flags: o, pos } = parse(args);
  const cfg = loadConfig();
  const [s, setS] = useState<State>({ phase: "work", spin: "starting", lines: [] });

  useEffect(() => {
    const L: Line[] = [];
    const add = (label: string, ok?: boolean | null, detail?: string) => {
      L.push({ label, ok, detail });
    };
    const spin = (t: string) => setS({ phase: "work", spin: t, lines: [...L] });
    const done = (ok: boolean, results: TestResult[], rows: [string, string][]) => setS({ phase: "done", lines: L, ok, results, rows });

    (async () => {
      try {
        const core = resolveCore(o.core, cfg.core);
        const contractPath = resolve(o.contract ?? cfg.contract ?? "contracts/" + (cfg.name ?? "") + ".h");
        if (!existsSync(contractPath)) {
          add("contract", false, contractPath + " not found");
          return done(false, [], []);
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
          return done(false, [], [["stderr", (r.stderr ?? "").trim().split("\n").slice(-6).join("\n")]]);
        }
        add("build", true, `${((r.size ?? 0) / 1024) | 0}KB wasm`);

        spin("running tests on a fresh, isolated virtual node");
        let results = await runTests(new Uint8Array(readFileSync(r.so)));
        if (o.filter) {
          results = results.filter((t) => t.name.toLowerCase().includes(o.filter.toLowerCase()));
        }

        const pass = results.filter((t) => t.passed).length;
        const ok = results.length > 0 && pass === results.length;
        add("tests", ok, `${pass}/${results.length} passed`);
        done(ok, results, [
          ["contract", `${name} @ ${slot}`],
          ["test", testPath.replace(process.cwd() + "/", "")],
          ["node", "in-process engine (isolated genesis)"],
        ]);
      } catch (e: any) {
        add("ERROR", false, String(e?.message ?? e));
        done(false, [], []);
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
      <Header cmd="gtest" />
      <Box flexDirection="column">
        {s.lines.map((l, i) => (
          <Status key={i} ok={l.ok} label={l.label} detail={l.detail} pad={10} />
        ))}
      </Box>
      {s.phase === "work" && (
        <Box marginTop={s.lines.length ? 1 : 0}>
          <Spinner label={s.spin} color={theme.accent} />
        </Box>
      )}
      {s.phase === "done" && (
        <Box flexDirection="column" marginTop={1}>
          {s.results.length > 0 && (
            <Panel title={s.ok ? "gtest ✓" : "gtest ✗"} color={s.ok ? theme.ok : theme.err}>
              <Box flexDirection="column">
                {s.results.map((t, i) => (
                  <Box key={i} flexDirection="column">
                    <Text color={t.passed ? theme.ok : theme.err}>
                      {t.passed ? "✓" : "✗"} {t.name}
                    </Text>
                    {!t.passed && t.message ? <Text dimColor>{t.message.trim()}</Text> : null}
                  </Box>
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
