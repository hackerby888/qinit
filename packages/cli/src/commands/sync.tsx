import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { resolve } from "node:path";
import { buildSnapshot } from "@qinit/build";
import { cacheDir, cacheHeaders, updateCurrent, loadManifest, fetchVerify, extractTarGz, autoUpdateVerifyTool } from "@qinit/core";
import { Header, Spinner, Panel, KV, theme } from "../ui";

function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--offline") o.offline = "1";
    else if (a.startsWith("--")) o[a.slice(2)] = args[++i] ?? "";
  }
  return o;
}

type State = { phase: "run"; msg: string } | { phase: "ok"; rows: [string, string][] } | { phase: "err"; msg: string };

const verifyRow = (vu: { action: string; version?: string }): string =>
  vu.action === "unsupported" ? "no build for this platform"
  : vu.action === "offline" ? "unreachable (skipped)"
  : `${(vu.version ?? "").slice(0, 12) || "—"} (${vu.action})`;

// qinit sync --from <core-checkout>   build a header snapshot locally (works today, no CI)
// qinit sync [--ref <tag>]            fetch the published snapshot from the fork's releases
export function Sync({ args }: { args: string[] }) {
  const { exit } = useApp();
  const o = parse(args);
  const [s, setS] = useState<State>({ phase: "run", msg: o.from ? "building snapshot from checkout" : "fetching snapshot" });

  useEffect(() => {
    (async () => {
      try {
        if (o.from) {
          const core = resolve(o.from);
          const version = "local";
          const r = await buildSnapshot(core, cacheDir(version));
          updateCurrent({ headersVersion: version, coreHeaders: r.root });
          const vu = await autoUpdateVerifyTool({ force: true });
          setS({ phase: "ok", rows: [
            ["source", core], ["version", version], ["files", String(r.fileCount)], ["cache", r.root],
            ["verify", verifyRow(vu)],
          ]});
        } else {
          const ref = o.ref || "latest";
          const m = await loadManifest(ref);
          if (!m.headers) throw new Error(`manifest ${m.version} has no headers asset`);
          const buf = await fetchVerify(m.headers, (rc, tt) =>
            setS({ phase: "run", msg: tt ? `downloading headers ${(rc / 1024).toFixed(0)}/${(tt / 1024).toFixed(0)} KB` : `downloading headers ${(rc / 1024).toFixed(0)} KB` }));
          const root = cacheHeaders(m.version);
          await extractTarGz(buf, root);
          updateCurrent({ headersVersion: m.version, coreHeaders: root });
          const vu = await autoUpdateVerifyTool({ force: true });
          setS({ phase: "ok", rows: [
            ["version", m.version], ["sha256", m.headers.sha256.slice(0, 16) + "…"], ["cache", root],
            ["verify", verifyRow(vu)],
          ]});
        }
      } catch (e: any) { setS({ phase: "err", msg: String(e?.message ?? e) }); }
    })();
  }, []);
  useEffect(() => { if (s.phase !== "run") { process.exitCode = s.phase === "ok" ? 0 : 1; exit(); } }, [s, exit]);

  return (
    <Box flexDirection="column">
      <Header cmd="sync" />
      {s.phase === "run" && <Spinner label={s.msg} />}
      {s.phase === "err" && <Panel title="sync failed" color={theme.err}><Text dimColor>{s.msg}</Text></Panel>}
      {s.phase === "ok" && (
        <Panel title="synced ✓" color={theme.ok}>
          <KV rows={s.rows} />
          <Box marginTop={1}><Text dimColor>now: </Text><Text bold color={theme.accent}>qinit build</Text></Box>
        </Panel>
      )}
    </Box>
  );
}
