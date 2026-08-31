import { useEffect, useState } from "react";
import { basename, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { Box, Text, useApp } from "ink";
import { analyzeCheatcodes, stripCheatcodes } from "@qinit/compiler/analyzer";
import { loadConfig } from "../../config";
import { Header, Panel, Status, theme } from "../../ui";
import { output, type CommandArguments } from "../../args";

interface StripResult {
    file: string;
    out?: string;
    removed: number;
    source: string;
}

/** Shows what `integrate` will send to Core, so a dev can diff it before submitting. */
export function Strip({ commandArgs }: { commandArgs: CommandArguments }) {
    const { exit } = useApp();
    const [result, setResult] = useState<StripResult | null>(null);
    const [err, setErr] = useState("");

    useEffect(() => {
        try {
            const configured = loadConfig();
            const path = commandArgs.get("contract") ?? commandArgs.positionals[0] ?? configured.contract;

            if (!path) {
                throw new Error("no contract: pass `qinit strip <file.h>` (or set contract in qinit.json)");
            }

            const file = resolve(path);
            const raw = readFileSync(file, "utf8");
            const violations = analyzeCheatcodes(raw);

            if (violations.length) {
                throw new Error(violations.map((item) => `line ${item.span.line}: ${item.message}`).join("\n"));
            }

            const source = stripCheatcodes(raw);
            const out = commandArgs.get("out");

            if (out) {
                writeFileSync(resolve(out), source);
            }

            setResult({ file, out, source, removed: raw.split("\n").length - source.replace(/^\s+$/gm, "").split("\n").length });
        } catch (error) {
            setErr((error as Error).message);
        }
    }, []);

    useEffect(() => {
        if (!result && !err) {
            return;
        }

        if (output.json) {
            process.stdout.write(JSON.stringify(err ? { ok: false, error: err } : { ok: true, file: result!.file, out: result!.out }) + "\n");
        } else if (result && !result.out) {
            process.stdout.write(result.source);
        }

        process.exitCode = err ? 1 : 0;
        exit();
    }, [result, err]);

    if (output.json || (result && !result.out)) {
        return null;
    }

    return (
        <Box flexDirection="column">
            <Header cmd="strip" />
            {err ? <Status ok={false} label="strip" detail={err} /> : null}
            {result?.out ? (
                <Panel title={basename(result.file)} color={theme.ok}>
                    <Text>wrote {result.out}</Text>
                </Panel>
            ) : null}
        </Box>
    );
}
