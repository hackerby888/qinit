import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";

interface Check { name: string; ok: boolean; detail: string }

async function cmdVersion(cmd: string, args: string[], missingHint: string): Promise<Check> {
  try {
    const p = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    await p.exited;
    const firstLine = (await new Response(p.stdout).text()).split("\n")[0]?.trim() ?? "";
    return { name: cmd, ok: p.exitCode === 0, detail: p.exitCode === 0 ? firstLine : missingHint };
  } catch {
    return { name: cmd, ok: false, detail: missingHint };
  }
}

async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(await cmdVersion("clang++-18", ["--version"], "not found — needed to build .so"));
  checks.push(await cmdVersion("node", ["--version"], "not found"));

  const core = process.env.QINIT_CORE ?? "/home/kali/Projects/qubic-core-lite";
  const qpi = `${core}/src/contracts/qpi.h`;
  const hasQpi = await Bun.file(qpi).exists();
  checks.push({
    name: "qubic-core-lite",
    ok: hasQpi,
    detail: hasQpi ? qpi : `headers missing (set QINIT_CORE); looked at ${qpi}`,
  });

  try {
    const m = await import("@qinit/core");
    checks.push({ name: "@qubic-lib/qubic-ts-library", ok: typeof m.deriveIdentity === "function", detail: "import ok" });
  } catch (e: any) {
    checks.push({ name: "@qubic-lib/qubic-ts-library", ok: false, detail: String(e?.message ?? e) });
  }
  return checks;
}

export function Doctor() {
  const { exit } = useApp();
  const [checks, setChecks] = useState<Check[] | null>(null);

  useEffect(() => { runChecks().then(setChecks); }, []);
  useEffect(() => {
    if (checks) {
      process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
      exit();
    }
  }, [checks, exit]);

  if (!checks) return <Text>running checks…</Text>;
  return (
    <Box flexDirection="column">
      {checks.map((c) => (
        <Text key={c.name}>
          <Text color={c.ok ? "green" : "red"}>{c.ok ? "✓" : "✗"}</Text>{" "}
          <Text bold>{c.name.padEnd(28)}</Text>
          <Text dimColor>{c.detail}</Text>
        </Text>
      ))}
    </Box>
  );
}
