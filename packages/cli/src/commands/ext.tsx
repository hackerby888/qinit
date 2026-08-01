import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Header, Panel, KV, theme } from "../ui";
import { output, type CommandArguments } from "../args";

const EXTENSION_ID = "qinit.qpi-vscode";
const EDITORS = ["code", "cursor", "windsurf", "codium"];

interface Result {
  ok: boolean;
  title: string;
  rows: [string, string][];
  note?: string;
}

export function Ext({ commandArgs }: { commandArgs: CommandArguments }) {
  const { exit } = useApp();
  const sub = commandArgs.positionals[0] ?? "";
  const editor = commandArgs.get("editor");
  const vsix = commandArgs.get("vsix");
  const [r, setR] = useState<Result | null>(null);

  useEffect(() => {
    (async () => {
      if (sub !== "install") {
        setR({
          ok: false,
          title: "usage",
          rows: [
            ["usage", "qinit ext install [--vsix <path>] [--editor <code|cursor|windsurf|codium>]"],
          ],
        });
        return;
      }
      const editorCmd = editor || EDITORS.find((e) => Bun.which(e)) || "";
      const editorPath = (editorCmd && Bun.which(editorCmd)) || editorCmd;
      if (!editorCmd || !editorPath) {
        setR({
          ok: false,
          title: "no editor found",
          rows: [["looked for", EDITORS.join(", ")]],
          note: "Install VS Code (or Cursor/Windsurf/VSCodium), or pass --editor. Then search the Marketplace for “Qubic QPI”.",
        });
        return;
      }
      const target = vsix ? resolve(vsix) : EXTENSION_ID;
      if (vsix && !existsSync(target)) {
        setR({ ok: false, title: "vsix not found", rows: [["path", target]] });
        return;
      }

      const p = Bun.spawnSync([editorPath, "--install-extension", target], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const log = ((p.stdout?.toString() ?? "") + (p.stderr?.toString() ?? "")).trim();
      const ok = p.exitCode === 0;
      setR({
        ok,
        title: ok ? "extension installed" : "install failed",
        rows: [
          ["editor", editorCmd],
          ["source", vsix ? target : `marketplace (${EXTENSION_ID})`],
        ],
        note: ok
          ? "Open a QPI contract header to start using IntelliSense and diagnostics."
          : log.split("\n").slice(0, 6).join("\n"),
      });
    })();
  }, []);

  useEffect(() => {
    if (!r) return;
    if (output.json)
      process.stdout.write(JSON.stringify({ ok: r.ok, ...Object.fromEntries(r.rows) }) + "\n");
    process.exitCode = r.ok ? 0 : 1;
    const t = setTimeout(() => exit(), 40);
    return () => clearTimeout(t);
  }, [r]);

  if (output.json) return null;
  if (!r)
    return (
      <Box flexDirection="column">
        <Header cmd="ext" />
        <Text dimColor>installing…</Text>
      </Box>
    );
  return (
    <Box flexDirection="column">
      <Header cmd="ext" />
      <Panel title={r.ok ? r.title + " ✓" : r.title} color={r.ok ? theme.ok : theme.err}>
        <KV rows={r.rows} />
      </Panel>
      {r.note && (
        <Box marginTop={1}>
          <Text color={r.ok ? theme.accent : theme.err} dimColor={r.ok}>
            {r.note}
          </Text>
        </Box>
      )}
    </Box>
  );
}
