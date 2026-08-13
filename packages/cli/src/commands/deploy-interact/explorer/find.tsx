// One search field for every jump target, and the screen that hosts it.
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { SectionHeader, TextPrompt, theme, truncMid } from "../../../ui";
import type { View, ViewProps } from "./chrome";

// One field for every jump target, told apart by shape: identities are 60 uppercase characters and a tx id
// is the same alphabet lowercased (the engine lowercases it in transport.ts), so nothing has to be typed
// twice. Anything else is rejected rather than guessed at.
export function parseFindQuery(value: string): View | null {
    const query = value.trim();
    if (/^\d+$/.test(query)) {
        return { kind: "tick", tick: Number(query) };
    }
    if (/^[a-z]{60}$/.test(query)) {
        return { kind: "tx", hash: query };
    }
    if (/^[A-Za-z]{60}$/.test(query)) {
        return { kind: "identity", id: query.toUpperCase() };
    }
    return null;
}

// ---- find ---------------------------------------------------------------------------------------

export function FindView({
    rpc,
    refreshToken,
    rowCount,
    columns,
    onSubmit,
}: ViewProps & { onSubmit: (view: View) => void }) {
    const [head, setHead] = useState<{ first: number; last: number } | null>(null);
    const [err, setErr] = useState("");

    // Only feeds the placeholder and the range hint, so the prompt is usable before this lands — and still
    // usable if it never does.
    useEffect(() => {
        let alive = true;
        rpc.explorerData()
            .then(({ header }) => {
                if (alive) setHead({ first: header.initialTick, last: header.tick });
            })
            .catch(() => {});
        return () => {
            alive = false;
        };
    }, [refreshToken]);

    rowCount.current = 0;

    return (
        <Box marginTop={1} flexDirection="column">
            <SectionHeader
                title="find"
                detail={
                    head
                        ? `ticks ${head.first}–${head.last} · identity · transaction`
                        : "tick · identity · transaction"
                }
                width={columns}
            />
            <TextPrompt
                // TextPrompt already advertises → for the placeholder, so the label only names what is accepted.
                label="tick number, identity, or tx hash"
                placeholder={head ? String(head.last) : undefined}
                onSubmit={(value) => {
                    const target = value.trim()
                        ? parseFindQuery(value)
                        : head
                          ? ({ kind: "tick", tick: head.last } as View)
                          : null;
                    if (target) {
                        onSubmit(target);
                    } else {
                        setErr(
                            `not a tick number, identity, or transaction hash: ${truncMid(value.trim(), 24)}`,
                        );
                    }
                }}
            />
            {err ? <Text color={theme.err}>{err}</Text> : null}
        </Box>
    );
}
