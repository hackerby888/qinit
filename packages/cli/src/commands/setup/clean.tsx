import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { cacheRoot } from "@qinit/core";
import { cacheInfo, wipeCache, human, type CacheItem } from "../../ops/cache";
import { Header, Status, Spinner, KV, theme } from "../../ui";
import { output, type CommandArguments } from "../../args";

// qinit clean [--dry-run]
// Remove ALL qinit cache (~/.cache/qinit or $QINIT_CACHE): fetched node, core-headers, wasi-sdk/clang artifacts.
type S = {
    phase: "run" | "empty" | "done" | "err";
    items?: CacheItem[];
    total?: number;
    killed?: boolean;
    err?: string;
};

// Sizes are plain bytes here; the rendered frame is the only place they are rounded.
export function cleanJsonResult(s: S, dryRun: boolean, root: string) {
    return {
        ok: s.phase !== "err",
        dryRun,
        root,
        total: s.total ?? 0,
        items: (s.items ?? []).map((item) => ({ name: item.name, bytes: item.sz })),
        killed: s.killed ?? false,
        error: s.phase === "err" ? (s.err ?? "clean failed") : null,
    };
}

export function Clean({ commandArgs }: { commandArgs: CommandArguments }) {
    const dry = commandArgs.has("dry-run");
    const root = cacheRoot();
    const { exit } = useApp();
    const [s, setS] = useState<S>({ phase: "run" });

    useEffect(() => {
        (async () => {
            try {
                if (dry) {
                    const info = cacheInfo();
                    setS(info.exists ? { phase: "done", items: info.items, total: info.total, killed: false } : { phase: "empty" });
                    return;
                }
                const w = await wipeCache();
                setS(w.exists ? { phase: "done", items: w.items, total: w.total, killed: w.killed } : { phase: "empty" });
            } catch (e: any) {
                setS({ phase: "err", err: String(e?.message ?? e) });
            }
        })();
    }, []);
    useEffect(() => {
        if (s.phase !== "run") {
            if (output.json) process.stdout.write(JSON.stringify(cleanJsonResult(s, dry, root)) + "\n");
            process.exitCode = s.phase === "err" ? 1 : 0;
            const t = setTimeout(() => exit(), 20);
            return () => clearTimeout(t);
        }
    }, [s.phase]);

    if (output.json) return null;
    return (
        <Box flexDirection="column">
            <Header cmd="clean" />
            <Text dimColor>{root}</Text>
            {s.phase === "run" && <Spinner label={dry ? "scanning cache" : "clearing cache"} />}
            {s.phase === "empty" && <Text dimColor>cache already empty — nothing to remove</Text>}
            {s.phase === "err" && <Text color={theme.err}>ERROR: {s.err}</Text>}
            {s.phase === "done" && (
                <Box flexDirection="column">
                    <Status ok={dry ? null : true} label={dry ? `would free ${human(s.total!)}` : `freed ${human(s.total!)}`} />
                    {s.items!.length ? (
                        <Box marginLeft={2}>
                            <KV rows={s.items!.map((i) => [i.name, human(i.sz)])} />
                        </Box>
                    ) : null}
                    {s.killed ? <Text dimColor>(stopped a running node first)</Text> : null}
                    <Box marginTop={1}>
                        <Text dimColor>re-fetched on next </Text>
                        <Text bold color={theme.accent}>
                            qinit setup
                        </Text>
                    </Box>
                </Box>
            )}
        </Box>
    );
}
