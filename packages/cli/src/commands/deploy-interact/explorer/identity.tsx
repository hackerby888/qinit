import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { EntityInfo, IdentityTransfer } from "@qinit/core";
import {
    Grad,
    KV,
    SectionHeader,
    Spinner,
    Table,
    TextPrompt,
    theme,
    type Column,
} from "../../../ui";
import {
    SectionBody,
    contractLabel,
    errText,
    fmtAmount,
    fmtTime,
    sectionTableWidth,
    windowOf,
    type ViewProps,
} from "./chrome";

// ---- identity -----------------------------------------------------------------------------------

const TRANSFER_COLS: Column[] = [
    { header: "tick", align: "right", max: 12 },
    { header: "dir", max: 4 },
    { header: "hash", max: 16 },
    { header: "peer", max: 22 },
    { header: "amount", align: "right", max: 18 },
    { header: "timestamp", max: 20 },
];

export function IdentityView({
    rpc,
    refreshToken,
    selected,
    contractNames,
    push,
    rowCount,
    openRow,
    bodyRows,
    columns,
    id,
    onSubmit,
}: ViewProps & {
    id?: string;
    onSubmit: (id: string) => void;
}) {
    const [entity, setEntity] = useState<EntityInfo | null>(null);
    const [transfers, setTransfers] = useState<IdentityTransfer[]>([]);
    const [balanceErr, setBalanceErr] = useState("");
    const [transferErr, setTransferErr] = useState("");
    const [loading, setLoading] = useState(Boolean(id));

    useEffect(() => {
        if (!id) return;
        let alive = true;
        setLoading(true);

        // Balance and transfers are fetched independently so a node without the transfers route still
        // renders a balance.
        void (async () => {
            const [balance, transferList] = await Promise.allSettled([
                rpc.balance(id),
                rpc.getTransfersForIdentity(id, 50),
            ]);
            if (!alive) return;

            setEntity(balance.status === "fulfilled" ? balance.value : null);
            setBalanceErr(balance.status === "rejected" ? errText(balance.reason) : "");
            setTransfers(
                transferList.status === "fulfilled" ? transferList.value.transactions : [],
            );
            setTransferErr(transferList.status === "rejected" ? errText(transferList.reason) : "");
            setLoading(false);
        })();
        return () => {
            alive = false;
        };
    }, [id, refreshToken]);

    rowCount.current = transfers.length;
    openRow.current = (index) => {
        const transfer = transfers[index];
        if (transfer) push({ kind: "tx", hash: transfer.hash, tick: transfer.tickNumber });
    };

    if (!id) {
        return (
            <Box marginTop={1} flexDirection="column">
                <SectionHeader
                    title="identity lookup"
                    detail="60-character identity"
                    width={columns}
                />
                <TextPrompt
                    label="identity"
                    onSubmit={(value) => {
                        const trimmed = value.trim().toUpperCase();
                        if (trimmed.length === 60) onSubmit(trimmed);
                    }}
                    placeholder={"A".repeat(60)}
                />
            </Box>
        );
    }

    if (loading) {
        return (
            <Box marginTop={1}>
                <Text color={theme.brand}>
                    <Spinner label="reading the identity" />
                </Text>
            </Box>
        );
    }

    // The web explorer derives the displayed balance from the transfer totals rather than the stored field.
    const balance = entity ? BigInt(entity.incomingAmount) - BigInt(entity.outgoingAmount) : 0n;
    // Balance hero (3), the 4-row KV or its fallback, and the section header.
    const { win, offset } = windowOf(transfers, selected, bodyRows - (entity ? 11 : 8));

    return (
        <Box flexDirection="column">
            <Box marginTop={1} flexDirection="column">
                <Text>
                    <Grad text={fmtAmount(balance.toString())} />
                    <Text dimColor>{"  qu"}</Text>
                </Text>
                <Text dimColor>{id}</Text>
            </Box>
            {entity ? (
                <Box marginTop={1}>
                    <KV
                        rows={[
                            [
                                "incoming",
                                `${fmtAmount(entity.incomingAmount)}  (${entity.numberOfIncomingTransfers} transfers)`,
                            ],
                            [
                                "outgoing",
                                `${fmtAmount(entity.outgoingAmount)}  (${entity.numberOfOutgoingTransfers} transfers)`,
                            ],
                            ["latest in", String(entity.latestIncomingTransferTick)],
                            ["latest out", String(entity.latestOutgoingTransferTick)],
                        ]}
                    />
                </Box>
            ) : (
                <Box marginTop={1}>
                    <Text color={theme.warn}>
                        no spectrum entry — this address has never been seen on chain
                    </Text>
                </Box>
            )}
            {balanceErr ? <Text color={theme.err}>{balanceErr}</Text> : null}
            <SectionHeader
                title="transfers"
                detail={`${transfers.length} in the node's recent window`}
                error={transferErr}
                width={columns}
            />
            <SectionBody>
                {transfers.length === 0 ? (
                    <Text dimColor>no transfers in the retained window</Text>
                ) : (
                    <Table
                        columns={TRANSFER_COLS}
                        rows={win.map((t) => {
                            const peer = t.direction === "in" ? t.source : t.destination;
                            const label = contractLabel(peer, contractNames);
                            // A zero-amount call is neither a credit nor a debit — don't sign it.
                            const sign = t.amount === "0" ? "" : t.direction === "in" ? "+" : "-";
                            return [
                                String(t.tickNumber),
                                t.direction === "in" ? "IN" : "OUT",
                                t.hash,
                                label ?? peer,
                                `${sign}${fmtAmount(t.amount)}`,
                                fmtTime(t.timestamp),
                            ];
                        })}
                        selected={selected - offset}
                        rowColor={(i) => (win[i].direction === "in" ? theme.ok : theme.warn)}
                        width={sectionTableWidth(columns)}
                    />
                )}
            </SectionBody>
        </Box>
    );
}
