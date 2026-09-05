import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { Header, Spinner, Panel, Status, theme } from "../../ui";
import { resolveCoreDir } from "../../config";
import { resolveVerifyTool } from "@qinit/build";
import { wasiSdkPaths } from "@qinit/core";
import { output } from "../../args";

interface Check {
    name: string;
    ok: boolean | null;
    detail: string;
    fix?: string;
    optional?: boolean;
}

async function runChecks(): Promise<Check[]> {
    const checks: Check[] = [];
    const sdk = wasiSdkPaths();
    checks.push(
        sdk
            ? { name: "wasi-sdk (wasm compiler)", ok: true, detail: sdk.clang }
            : {
                  name: "wasi-sdk (wasm compiler)",
                  ok: false,
                  detail: "not cached",
                  fix: "qinit setup   (downloads the host wasi-sdk)",
              },
    );

    let qpi = "",
        hasQpi = false,
        coreErr = "";
    try {
        qpi = `${resolveCoreDir()}/src/qpi/qpi.h`;
        hasQpi = await Bun.file(qpi).exists();
    } catch (e: any) {
        coreErr = String(e?.message ?? e);
    }
    checks.push({
        name: "qubic-core-lite headers",
        ok: hasQpi,
        detail: hasQpi ? qpi : coreErr || "headers not found",
        fix: hasQpi ? undefined : "qinit setup (fetch published snapshot) or set QINIT_CORE=<core-checkout>",
    });

    const vtool = resolveVerifyTool();
    checks.push({
        name: "contract-verify tool",
        optional: true,
        ok: vtool ? true : null,
        detail: vtool ?? "not fetched — qinit build will skip the qpi.h rule check",
        fix: vtool ? undefined : "qinit setup   ·   or set QINIT_VERIFY=/path/to/contractverify",
    });
    return checks;
}

// Optional checks never fail the document, the same rule the exit code follows.
export function doctorJsonResult(checks: Check[]) {
    const failed = checks.filter((check) => !check.optional && check.ok !== true);
    return {
        ok: failed.length === 0,
        checks: checks.map((check) => ({ name: check.name, ok: check.ok, detail: check.detail, fix: check.fix ?? null, optional: check.optional ?? false })),
        error: failed.length ? `${failed.map((check) => check.name).join(", ")} not ready` : null,
    };
}

export function Doctor() {
    const { exit } = useApp();
    const [checks, setChecks] = useState<Check[] | null>(null);

    useEffect(() => {
        runChecks().then(setChecks);
    }, []);
    // Optional checks (e.g. the verify tool) don't fail the gate; only required ones do.
    const required = (c: Check) => !c.optional;
    useEffect(() => {
        if (checks) {
            if (output.json) process.stdout.write(JSON.stringify(doctorJsonResult(checks)) + "\n");
            process.exitCode = checks.filter(required).every((c) => c.ok === true) ? 0 : 1;
            exit();
        }
    }, [checks, exit]);

    const allOk = checks?.filter(required).every((c) => c.ok === true) ?? false;
    const fixes = checks?.filter((c) => c.ok !== true && c.fix) ?? [];
    if (output.json) return null;
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
                                    <Text key={i}>
                                        {" "}
                                        <Text dimColor>{i === 0 ? "$ " : "or "}</Text>
                                        <Text color={theme.accent}>{p.trim()}</Text>
                                    </Text>
                                ))}
                            </Box>
                        ))}
                    </Panel>
                </Box>
            )}
        </Box>
    );
}
