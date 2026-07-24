import { useEffect, useState } from "react";
import { resolve, basename } from "node:path";
import { readFileSync } from "node:fs";
import { Box, Text, useApp } from "ink";
import { verifyContract, type VerifyResult } from "@qinit/build";
import { loadConfig } from "../config";
import { Header, Panel, Status, theme, termCols } from "../ui";
import { output, parseArgs } from "../args";

export function Verify({ args }: { args: string[] }) {
  const { exit } = useApp();
  const { flags: o, pos, multi } = parseArgs(args, {
    strings: ["contract", "name"],
    multi: ["callee"],
  });
  const [r, setR] = useState<VerifyResult | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const cfg = loadConfig();
        const cpath = o.contract ?? pos[0] ?? cfg.contract;
        if (!cpath)
          throw new Error(
            "no contract: pass `qinit verify <file.h>` (or set contract in qinit.json)",
          );
        const file = resolve(cpath);
        const name = o.name ?? cfg.name ?? basename(file).replace(/\.[^.]+$/, "");
        // Declared inter-contract callees (--callee + CALL/INVOKE_OTHER_CONTRACT) — their scope-resolution
        // errors are false for declared callees and dropped by verifyContract (same as buildContract).
        const dynCallees: Record<string, { header: string; index: number }> = {};
        for (const value of multi.callee ?? []) {
          const m = value.match(/^(\w+)=(.+)@(\d+)$/);
          if (m) dynCallees[m[1]] = { header: resolve(m[2]), index: Number(m[3]) };
        }
        const calleeNames = [
          ...new Set([
            ...Object.keys(dynCallees),
            ...[
              ...readFileSync(file, "utf8").matchAll(
                /(?:CALL|INVOKE)_OTHER_CONTRACT_\w+\s*\(\s*(\w+)/g,
              ),
            ].map((m) => m[1]),
          ]),
        ];
        setR(await verifyContract(file, name, { allowedPrefixes: calleeNames }));
      } catch (e: any) {
        setErr(String(e?.message ?? e));
      }
    })();
  }, []);

  const done = r !== null || err !== "";
  useEffect(() => {
    if (!done) return;
    if (output.json) {
      const payload = err
        ? { ok: false, available: false, oracle: false, errors: [err] }
        : { ok: r!.ok, available: r!.available, oracle: r!.oracle, errors: r!.errors };
      process.stdout.write(JSON.stringify(payload) + "\n");
    }
    process.exitCode = err || (r && r.available && !r.ok) ? 1 : 0;
    const t = setTimeout(() => exit(), 40);
    return () => clearTimeout(t);
  }, [done]);

  if (output.json) return null;
  if (!done)
    return (
      <Box flexDirection="column">
        <Header cmd="verify" />
        <Text dimColor>checking protocol rules…</Text>
      </Box>
    );
  if (err)
    return (
      <Box flexDirection="column">
        <Header cmd="verify" />
        <Panel title="verify failed" color={theme.err}>
          <Text>{err}</Text>
        </Panel>
      </Box>
    );
  const v = r!;
  return (
    <Box flexDirection="column">
      <Header cmd="verify" />
      {!v.available ? (
        <Status
          ok={null}
          label="protocol rules"
          detail="skipped — verify tool not fetched (run qinit setup)"
          pad={16}
        />
      ) : v.ok ? (
        <Status
          ok={true}
          label="protocol rules"
          detail="passed — complies with qpi.h restrictions"
          pad={16}
        />
      ) : (
        <Panel title="protocol violations" color={theme.err}>
          <Box flexDirection="column" width={Math.min(100, termCols() - 4)}>
            {v.errors.map((e, i) => (
              <Text key={i} wrap="wrap">
                <Text color={theme.err}>✗ </Text>
                {e}
              </Text>
            ))}
          </Box>
        </Panel>
      )}
    </Box>
  );
}
