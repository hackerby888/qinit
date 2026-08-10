import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Header, theme } from "../../ui";
import { loadSystem } from "../../contracts/registry";
import { extractIdl, genStdGtest } from "@qinit/build";
import { DEFAULT_RPC_BASE } from "@qinit/core";
import { TEMPLATE_KINDS, TEMPLATE_NOTE, templateSource, type TemplateKind } from "../../contracts/templates";
import { loadConfiguredQpiHeader } from "../../config";
import type { CommandArguments } from "../../args";

// Sanitize a project name into a valid C++ struct identifier (PascalCase-ish).
function toIdent(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_]/g, "");
  if (!s || /^[0-9]/.test(s)) s = "C" + s;
  return s[0].toUpperCase() + s.slice(1);
}

export function New({ commandArgs }: { commandArgs: CommandArguments }) {
  const { exit } = useApp();
  const projectName = commandArgs.positionals[0];
  const requestedTemplate = commandArgs.get("template");
  const requestedCoreDir = commandArgs.get("core-dir");
  const [log, setLog] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const add = (s: string) => setLog((l) => [...l, s]);

  useEffect(() => {
    try {
      if (!projectName) {
        add(
          `usage: qinit new <name> [--template ${TEMPLATE_KINDS.join("|")}] [--core-dir PATH]`,
        );
        setDone(true);
        return;
      }
      const kind = (requestedTemplate || "counter") as TemplateKind;
      if (!TEMPLATE_KINDS.includes(kind)) {
        add(`✗ unknown template '${kind}' — pick: ${TEMPLATE_KINDS.join(", ")}`);
        setDone(true);
        return;
      }
      // refuse nesting: a folder created by `qinit new` has qinit.json — making another project here gets messy
      if (existsSync("qinit.json")) {
        add("✗ already inside a qinit project (qinit.json is here) — cd out before `qinit new`");
        setDone(true);
        return;
      }
      const dir = projectName;
      const name = toIdent(projectName);
      // a contract named after a QPI type (Asset, Entity, …) makes the generated wrapper ambiguous -> won't compile
      const RESERVED = ["Asset", "Entity", "Array", "Collection", "HashMap", "HashSet"];
      if (RESERVED.includes(name)) {
        add(
          `✗ '${name}' collides with a QPI type — pick another name (reserved: ${RESERVED.join(", ")})`,
        );
        setDone(true);
        return;
      }
      // also refuse a built-in system-contract name (best-effort: needs the snapshot; deploy re-checks authoritatively)
      if (loadSystem().some((c) => c.name.toLowerCase() === name.toLowerCase())) {
        add(`✗ '${name}' is a system contract name — pick another`);
        setDone(true);
        return;
      }
      const coreDir = requestedCoreDir ?? process.env.QINIT_CORE;
      if (existsSync(dir)) {
        add(`✗ '${dir}' already exists`);
        setDone(true);
        return;
      }

      mkdirSync(join(dir, "contracts"), { recursive: true });
      const source = templateSource(kind);
      writeFileSync(join(dir, "contracts", `${name}.h`), source);

      // Scaffold a contract_testing.h test from the contract IDL.
      let testRel: string | undefined;
      try {
        mkdirSync(join(dir, "tests"), { recursive: true });
        writeFileSync(
          join(dir, "tests", `${name}.test.cpp`),
          genStdGtest(
            extractIdl(source, name, {
              qpiHeader: loadConfiguredQpiHeader(requestedCoreDir),
            }),
            name,
          ),
        );
        testRel = `tests/${name}.test.cpp`;
      } catch {}

      // No slot: project planning assigns dependencies below Main and reuses matching names.
      const cfg: Record<string, unknown> = {
        contractName: name,
        contract: `contracts/${name}.h`,
        rpc: DEFAULT_RPC_BASE,
      };
      if (coreDir) cfg.coreDir = coreDir;
      if (kind === "intercontract") {
        writeFileSync(join(dir, "contracts", "Counter.h"), templateSource("counter"));
      }
      writeFileSync(join(dir, "qinit.json"), JSON.stringify(cfg, null, 2) + "\n");
      writeFileSync(
        join(dir, ".gitignore"),
        ["dist/", "*.wasm", "*.log", "qinit.idl.json", "contracts_dyn/", ".DS_Store"].join("\n") +
          "\n",
      );
      writeFileSync(
        join(dir, "README.md"),
        `# ${name}\n\nQubic dynamic contract (\`qinit new --template ${kind}\`).\n\n` +
          "```bash\nqinit node run        # prepare headers + run a dev node\n" +
          "qinit dev       # watch contracts/" +
          name +
          ".h -> auto build+deploy on save\n" +
          "qinit gtest --compiler typescript   # run tests/" +
          name +
          ".test.cpp on an isolated node (TS compiler)\n" +
          "qinit call      # interactive: pick contract -> fn/proc\n```\n\n" +
          "Config in `qinit.json` (contractName, contract, coreDir, rpc). Slot is auto-allocated by contract name.\n" +
          "`qinit gtest` needs a core-lite checkout (`test/contract_testing.h`): pass `--core-dir PATH` or set `QINIT_CORE`.\n",
      );

      add(`✓ created ${dir}/  (template: ${kind})`);
      add(`  contracts/${name}.h`);
      if (testRel) add(`  ${testRel}`);
      add(`  qinit.json · .gitignore · README.md`);
      if (TEMPLATE_NOTE[kind]) add(`  note: ${TEMPLATE_NOTE[kind]}`);
      add("");
      add(`next:  cd ${dir} && qinit node run && qinit dev`);
      setDone(true);
    } catch (e: any) {
      add("ERROR: " + String(e?.message ?? e));
      setDone(true);
    }
  }, []);
  useEffect(() => {
    if (done) exit();
  }, [done]);

  const lineColor = (l: string) =>
    l.startsWith("✓")
      ? theme.ok
      : l.startsWith("✗") || l.startsWith("ERROR")
        ? theme.err
        : undefined;
  return (
    <Box flexDirection="column">
      <Header cmd="new" />
      {log.map((l, i) =>
        l.startsWith("next:") ? (
          <Text key={i}>
            <Text dimColor>next:</Text>{" "}
            <Text bold color={theme.accent}>
              {l.slice(5).trim()}
            </Text>
          </Text>
        ) : (
          <Text key={i} color={lineColor(l)} dimColor={l.startsWith("  ")}>
            {l}
          </Text>
        ),
      )}
    </Box>
  );
}
