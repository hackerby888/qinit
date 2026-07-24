import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Header, theme } from "../ui";
import { loadSystem } from "../contracts";
import { extractIdl, genStdGtest } from "@qinit/build";
import { TEMPLATE_KINDS, TEMPLATE_NOTE, templateSource, type TemplateKind } from "../templates";
import { loadConfiguredQpiHeader } from "../config";

function parse(args: string[]): { name?: string; slot?: string; core?: string; template?: string } {
  const o: any = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) o[a.slice(2)] = args[++i] ?? "";
    else if (!o.name) o.name = a;
  }
  return o;
}

// Sanitize a project name into a valid C++ struct identifier (PascalCase-ish).
function toIdent(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_]/g, "");
  if (!s || /^[0-9]/.test(s)) s = "C" + s;
  return s[0].toUpperCase() + s.slice(1);
}

export function New({ args }: { args: string[] }) {
  const { exit } = useApp();
  const o = parse(args);
  const [log, setLog] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const add = (s: string) => setLog((l) => [...l, s]);

  useEffect(() => {
    try {
      if (!o.name) {
        add(`usage: qinit new <name> [--template ${TEMPLATE_KINDS.join("|")}] [--core PATH]`);
        setDone(true);
        return;
      }
      const kind = (o.template || "counter") as TemplateKind;
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
      const dir = o.name;
      const name = toIdent(o.name);
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
      const core = o.core ?? process.env.QINIT_CORE; // pin only if explicit; else qinit.json omits it -> synced cache (portable)
      if (existsSync(dir)) {
        add(`✗ '${dir}' already exists`);
        setDone(true);
        return;
      }

      mkdirSync(join(dir, "contracts"), { recursive: true });
      const source = templateSource(kind);
      writeFileSync(join(dir, "contracts", `${name}.h`), source);

      // Example standard gtest (contract_testing.h) scaffolded from the contract IDL. `qinit gtest` runs it;
      // `--local` runs the contract through the TS compiler.
      let testRel: string | undefined;
      try {
        mkdirSync(join(dir, "tests"), { recursive: true });
        writeFileSync(
          join(dir, "tests", `${name}.test.cpp`),
          genStdGtest(
            extractIdl(source, name, {
              qpiHeader: loadConfiguredQpiHeader(o.core),
            }),
            name,
          ),
        );
        testRel = `tests/${name}.test.cpp`;
      } catch {}

      // No slot: the framework auto-allocates one at deploy by name (reuse-or-first-free).
      const cfg: Record<string, unknown> = {
        name,
        contract: `contracts/${name}.h`,
        rpc: "http://127.0.0.1:41841",
      };
      if (core) cfg.core = core; // omitted by default -> resolveCore uses the synced cache, project is machine-portable
      // The intercontract template CALLs a Counter — scaffold that callee + register it so `qinit test` deploys
      // it before the main contract (else the CALL_OTHER_CONTRACT(Counter) names can't resolve at build time).
      if (kind === "intercontract") {
        writeFileSync(join(dir, "contracts", "Counter.h"), templateSource("counter"));
        cfg.callees = [{ name: "Counter", contract: "contracts/Counter.h" }];
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
          "```bash\nqinit node run        # sync headers + run a dev node\n" +
          "qinit dev       # watch contracts/" +
          name +
          ".h -> auto build+deploy on save\n" +
          "qinit gtest --local   # run tests/" +
          name +
          ".test.cpp on an isolated node (TS compiler)\n" +
          "qinit call      # interactive: pick contract -> fn/proc\n```\n\n" +
          "Config in `qinit.json` (name, contract, core, rpc). Slot is auto-allocated by name.\n" +
          "`qinit gtest` needs a core-lite checkout (`test/contract_testing.h`): pass `--core PATH` or set `QINIT_CORE`.\n",
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
