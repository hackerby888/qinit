import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { writeFileSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import { resolveCliTag, cliReleaseUrls, fetchCliSha, fetchVerify } from "@qinit/core";
import { VERSION } from "../version";
import { Header, Status, Spinner, Bar, theme } from "../ui";

// qinit self-update [--force] [--dry-run]
// Replace the running qinit binary with the newest qinit-cli-* release (mirrors install.sh: API tag resolve,
// per-host asset, sha256 verify). Atomic same-dir rename over the running exe (linux/macOS allow that).
function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const a of args) if (a.startsWith("--")) o[a.slice(2)] = "";
  return o;
}
type S = { phase: "run" | "done" | "uptodate" | "dev" | "dry" | "err"; from?: string; to?: string; tag?: string; asset?: string; err?: string };

export function Update({ args }: { args: string[] }) {
  const o = parse(args);
  const force = o.force !== undefined, dry = o["dry-run"] !== undefined;
  const { exit } = useApp();
  const [s, setS] = useState<S>({ phase: "run" });
  const [pct, setPct] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const self = process.execPath;
        if (basename(self) === "bun" || basename(self) === "node") { setS({ phase: "dev" }); return; }
        const tag = await resolveCliTag();
        if (!tag) throw new Error("no qinit-cli release found on the API");
        const to = tag.replace(/^qinit-cli-v?/, "");
        const { asset, sums, name } = cliReleaseUrls(tag);
        if (dry) { setS({ phase: "dry", tag, asset, to }); return; }
        if (to === VERSION && !force) { setS({ phase: "uptodate", to }); return; }
        const sha = await fetchCliSha(sums, name);
        const buf = await fetchVerify({ url: asset, sha256: sha }, (r, t) => t && setPct(r / t));
        const tmp = self + ".new";                                   // same dir => atomic rename, no cross-fs copy
        writeFileSync(tmp, buf);
        if (process.platform === "win32") {
          // Windows locks a running .exe against OVERWRITE but ALLOWS RENAME: move self aside, swap .new in.
          // The running process keeps the renamed handle; the next launch picks up the new binary.
          const old = self + ".old";
          try { unlinkSync(old); } catch {}                          // clear a prior .old (now unlocked)
          try { renameSync(self, old); renameSync(tmp, self); }
          catch (e: any) {
            try { renameSync(old, self); } catch {}                  // best-effort rollback
            try { unlinkSync(tmp); } catch {}
            throw new Error(`could not replace ${self} (${e?.code ?? e}) — close other qinit processes or re-run install.ps1`);
          }
        } else {
          chmodSync(tmp, 0o755);
          try { renameSync(tmp, self); }
          catch (e: any) { try { unlinkSync(tmp); } catch {} throw new Error(`could not replace ${self} (${e?.code ?? e}) — bin dir not writable; re-run install.sh or use sudo`); }
        }
        setS({ phase: "done", from: VERSION, to });
      } catch (e: any) { setS({ phase: "err", err: String(e?.message ?? e) }); }
    })();
  }, []);
  useEffect(() => { if (s.phase !== "run") { const t = setTimeout(() => exit(), 20); return () => clearTimeout(t); } }, [s.phase]);

  return (
    <Box flexDirection="column">
      <Header cmd="self-update" />
      {s.phase === "run" && (pct != null ? <Text><Bar pct={pct} /> <Text dimColor>downloading</Text></Text> : <Spinner label="checking for updates" />)}
      {s.phase === "dev" && <Text color={theme.warn}>self-update only updates the installed binary — in dev, rebuild or use the installer (install.sh / install.ps1)</Text>}
      {s.phase === "dry" && <Box flexDirection="column"><Status ok={null} label={`latest ${s.tag}`} detail={`current v${VERSION}`} /><Text dimColor>  {s.asset}</Text></Box>}
      {s.phase === "uptodate" && <Status ok={true} label={`already on the latest (v${s.to})`} />}
      {s.phase === "done" && <Box flexDirection="column"><Status ok={true} label={`updated v${s.from} → v${s.to}`} /><Box marginTop={1}><Text dimColor>restart qinit to use the new version</Text></Box></Box>}
      {s.phase === "err" && <Text color={theme.err}>ERROR: {s.err}</Text>}
    </Box>
  );
}
