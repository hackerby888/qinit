import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { Header, Spinner, Panel, Status, theme } from "../ui";
import { resolveCore } from "../config";
import { resolveVerifyTool } from "@qinit/build";
import { wasiSdkPaths } from "@qinit/core";

interface Check { name: string; ok: boolean | null; detail: string; fix?: string; optional?: boolean }

async function cmdVersion(cmd: string, args: string[], missingHint: string, fix: string): Promise<Check> {
  try {
    const p = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    await p.exited;
    const firstLine = (await new Response(p.stdout).text()).split("\n")[0]?.trim() ?? "";
    return { name: cmd, ok: p.exitCode === 0, detail: p.exitCode === 0 ? firstLine : missingHint, fix: p.exitCode === 0 ? undefined : fix };
  } catch {
    return { name: cmd, ok: false, detail: missingHint, fix };
  }
}

async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  // wasm compiler: the auto-fetched wasi-sdk, or a WASM_CLANG/WASI_SYSROOT override.
  const sdk = wasiSdkPaths();
  const envClang = process.env.WASM_CLANG;
  checks.push(sdk
    ? { name: "wasi-sdk (wasm compiler)", ok: true, detail: sdk.clang }
    : envClang
      ? { name: "wasi-sdk (wasm compiler)", ok: true, detail: `WASM_CLANG=${envClang}` }
      : { name: "wasi-sdk (wasm compiler)", ok: false, detail: "not cached", fix: "qinit up   (auto-fetches the host wasi-sdk)" });
  checks.push(await cmdVersion("node", ["--version"], "not found — needed by qinit", "install Node 20+ from nodejs.org or your package manager"));

  // Cache-aware: prefer the synced header cache, fall back to QINIT_CORE / --core.
  let qpi = "", hasQpi = false, coreErr = "";
  try { qpi = `${resolveCore()}/src/contracts/qpi.h`; hasQpi = await Bun.file(qpi).exists(); }
  catch (e: any) { coreErr = String(e?.message ?? e); }
  checks.push({
    name: "qubic-core-lite headers",
    ok: hasQpi,
    detail: hasQpi ? qpi : (coreErr || "headers not found"),
    fix: hasQpi ? undefined : "qinit sync            (fetch published snapshot)  or  qinit sync --from <core-checkout>",
  });

  try {
    const m = await import("@qinit/core");
    checks.push({ name: "@qubic-lib/qubic-ts-library", ok: typeof m.deriveIdentity === "function", detail: "import ok" });
  } catch (e: any) {
    checks.push({ name: "@qubic-lib/qubic-ts-library", ok: false, detail: String(e?.message ?? e), fix: "bun install   (reinstall deps)" });
  }

  // Optional: the protocol-rule checker. Absent => qinit build still works, just skips the rule gate.
  const vtool = resolveVerifyTool();
  checks.push({
    name: "contract-verify tool", optional: true, ok: vtool ? true : null,
    detail: vtool ?? "not synced — qinit build will skip the qpi.h rule check",
    fix: vtool ? undefined : "qinit sync   ·   or set QINIT_VERIFY=/path/to/contractverify",
  });
  return checks;
}

export function Doctor() {
  const { exit } = useApp();
  const [checks, setChecks] = useState<Check[] | null>(null);

  useEffect(() => { runChecks().then(setChecks); }, []);
  // Optional checks (e.g. the verify tool) don't fail the gate; only required ones do.
  const required = (c: Check) => !c.optional;
  useEffect(() => {
    if (checks) {
      process.exitCode = checks.filter(required).every((c) => c.ok === true) ? 0 : 1;
      exit();
    }
  }, [checks, exit]);

  const allOk = checks?.filter(required).every((c) => c.ok === true) ?? false;
  const fixes = checks?.filter((c) => c.ok !== true && c.fix) ?? [];
  return (
    <Box flexDirection="column">
      <Header cmd="doctor" />
      {!checks && <Spinner label="running checks" />}
      {checks && (
        <Panel title={allOk ? "toolchain ✓" : "toolchain"} color={allOk ? theme.ok : theme.err}>
          {checks.map((c) => (
            <Status key={c.name} ok={c.ok} label={c.name} detail={c.detail} pad={30} />
          ))}
        </Panel>
      )}
      {fixes.length > 0 && (
        <Box marginTop={1}>
          <Panel title="to fix" color={theme.warn}>
            {fixes.map((c) => (
              <Box key={c.name} flexDirection="column">
                <Text color={theme.warn}>{c.name}</Text>
                {(c.fix ?? "").split("  or  ").map((p, i) => (
                  <Text key={i}>  <Text dimColor>{i === 0 ? "$ " : "or "}</Text><Text color={theme.accent}>{p.trim()}</Text></Text>
                ))}
              </Box>
            ))}
          </Panel>
        </Box>
      )}
    </Box>
  );
}
