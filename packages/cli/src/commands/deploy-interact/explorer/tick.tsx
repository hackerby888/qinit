import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { contractIndexFromIdentity, type ExplorerTickData, type ExplorerTx } from "@qinit/core";
import { Badge, Grad, KV, SectionHeader, Spinner, Table, theme, truncMid, type Column } from "../../../ui";
import { decodeTxInput, entryFor, type ContractIdls, type DecodedInput } from "../../../contracts/idl-lookup";
import { SectionBody, contractLabel, inputTypeLabel, errText, fmtAmount, fmtTime, sectionTableWidth, windowOf, type ViewProps } from "./chrome";

// ---- tick ---------------------------------------------------------------------------------------

const TX_COLS: Column[] = [
    { header: "hash", max: 16 },
    { header: "source", max: 16 },
    { header: "destination", max: 26 },
    { header: "amount", align: "right", max: 16 },
    { header: "in", max: 22 },
    { header: "size", align: "right", max: 6 },
];

const txRow = (tx: ExplorerTx, names: Map<number, string>, idls: ContractIdls): string[] => {
    const label = contractLabel(tx.destination, names);
    return [
        tx.hash,
        tx.source,
        label ? `${truncMid(tx.destination, 10)} ${label}` : tx.destination,
        fmtAmount(tx.amount),
        inputTypeLabel(contractIndexFromIdentity(tx.destination), tx.inputType, idls),
        String(tx.inputSize),
    ];
};

export function TickView({
    rpc,
    refreshToken,
    selected,
    contractNames,
    contractIdls,
    push,
    rowCount,
    openRow,
    bodyRows,
    columns,
    tick,
}: ViewProps & { tick: number }) {
    const [tickData, setTickData] = useState<ExplorerTickData | null>(null);
    const [txs, setTxs] = useState<ExplorerTx[]>([]);
    const [err, setErr] = useState("");
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let alive = true;
        setLoading(true);
        setErr("");
        // The header and the transaction list are fetched independently — an empty tick has no header but can
        // still be rendered, and a node missing one route must not blank out the other.
        void (async () => {
            const [header, list] = await Promise.allSettled([rpc.getTickData(tick), rpc.explorerTickTransactions(tick)]);
            if (!alive) return;

            setTickData(header.status === "fulfilled" ? header.value : null);
            setTxs(list.status === "fulfilled" ? list.value : []);
            setErr(header.status === "rejected" ? errText(header.reason) : list.status === "rejected" ? errText(list.reason) : "");
            setLoading(false);
        })();
        return () => {
            alive = false;
        };
    }, [tick, refreshToken]);

    rowCount.current = txs.length;
    openRow.current = (index) => {
        const tx = txs[index];
        if (tx) push({ kind: "tx", hash: tx.hash, tick });
    };

    // Title, the 6-row KV (or its one-line fallback), and the section header.
    const { win, offset } = windowOf(txs, selected, bodyRows - (tickData ? 12 : 7));

    return (
        <Box flexDirection="column">
            <Box marginTop={1}>
                <Text>
                    <Grad text={`TICK ${tick}`} />
                </Text>
            </Box>
            {loading ? (
                <Box marginTop={1}>
                    <Text color={theme.brand}>
                        <Spinner label="reading the tick" />
                    </Text>
                </Box>
            ) : tickData ? (
                <Box marginTop={1}>
                    <KV
                        rows={[
                            ["epoch", String(tickData.epoch)],
                            ["leader", `computor #${tickData.computorIndex}`],
                            ["timestamp", fmtTime(tickData.timestamp)],
                            ["digests", String(tickData.transactionDigests.length)],
                            ["timelock", truncMid(tickData.timelock, 44)],
                            ["signature", truncMid(tickData.signature, 44)],
                        ]}
                    />
                </Box>
            ) : (
                <Box marginTop={1}>
                    <Text color={theme.warn}>this tick is empty or outside the node's history</Text>
                </Box>
            )}
            <SectionHeader title="transactions" detail={String(txs.length)} error={err} width={columns} />
            <SectionBody>
                {txs.length === 0 ? (
                    <Text dimColor>no transactions in this tick</Text>
                ) : (
                    <Table
                        columns={TX_COLS}
                        rows={win.map((tx) => txRow(tx, contractNames, contractIdls))}
                        selected={selected - offset}
                        width={sectionTableWidth(columns)}
                    />
                )}
            </SectionBody>
        </Box>
    );
}

// ---- transaction --------------------------------------------------------------------------------

// A wide input (QUTIL's SendToManyV1 carries 25 identities) would otherwise fill the frame on its own.
const FIELD_ROWS = 8;
const NAME_WIDTH = 24;

export function TxView({
    rpc,
    refreshToken,
    contractNames,
    contractIdls,
    push,
    rowCount,
    openRow,
    bodyRows,
    columns,
    hash,
    tick,
}: ViewProps & { hash: string; tick?: number }) {
    const [tx, setTx] = useState<ExplorerTx | null>(null);
    const [decoded, setDecoded] = useState<DecodedInput | null>(null);
    const [err, setErr] = useState("");
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let alive = true;
        setLoading(true);
        rpc.getTransactionByHash(hash, tick)
            .then((found) => {
                if (!alive) return;
                setTx(found);
                setErr("");
                setLoading(false);
            })
            .catch((e) => {
                if (!alive) return;
                setErr(errText(e));
                setLoading(false);
            });
        return () => {
            alive = false;
        };
    }, [hash, tick, refreshToken]);

    // The payload is decoded off the render path: the IDL map arrives after the transaction does, and
    // container fields make the decode async.
    const entry = tx ? entryFor(contractIndexFromIdentity(tx.destination), tx.inputType, contractIdls) : undefined;
    useEffect(() => {
        if (!tx || !entry) {
            setDecoded(null);
            return;
        }

        let alive = true;
        decodeTxInput(entry, Buffer.from(tx.inputData ?? "", "base64"))
            .then((value) => {
                if (alive) setDecoded(value);
            })
            .catch(() => {
                if (alive) setDecoded(null);
            });
        return () => {
            alive = false;
        };
    }, [tx, entry]);

    // ↵ walks from a transaction to the identities it touches.
    const targets = tx ? [tx.source, tx.destination] : [];
    rowCount.current = 0;
    openRow.current = () => {
        if (targets[0]) push({ kind: "identity", id: targets[0] });
    };

    if (loading) {
        return (
            <Box marginTop={1}>
                <Text color={theme.brand}>
                    <Spinner label="reading the transaction" />
                </Text>
            </Box>
        );
    }

    if (!tx) {
        return (
            <Box marginTop={1} flexDirection="column">
                <Text color={theme.warn}>no transaction with this hash on the node</Text>
                <Text dimColor>{hash}</Text>
                {err ? <Text color={theme.err}>{err}</Text> : null}
            </Box>
        );
    }

    const label = contractLabel(tx.destination, contractNames);
    const inputBytes = tx.inputData ? Buffer.from(tx.inputData, "base64") : Buffer.alloc(0);
    // Every decoded line is variable width, and a line that wraps costs a row this view has not budgeted —
    // which is what would push the control bar off the screen. Truncate them all to the section's width.
    const width = sectionTableWidth(columns);
    const shownFields = decoded ? decoded.fields.slice(0, FIELD_ROWS) : [];
    const hiddenFields = (decoded?.fields.length ?? 0) - shownFields.length;
    const nameWidth = Math.min(NAME_WIDTH, Math.max(0, ...shownFields.map(([name]) => name.length)));
    const valueWidth = Math.max(8, width - nameWidth - 2);
    const fieldRows = shownFields.map(([name, value]): [string, string] => [truncMid(name, nameWidth).padEnd(nameWidth), truncMid(value, valueWidth)]);
    const formatRow = decoded?.format ? truncMid(`--in "${decoded.format}"`, width) : "";
    const decodedRows = fieldRows.length + (hiddenFields > 0 ? 1 : 0) + (formatRow ? 2 : 0);

    // 15 fixed rows (title/from-to band 5, 7-row KV + margin 8, trailing hint 2); the dump costs its own
    // margin + section header + overflow line, so a short terminal drops dump rows, never the control bar.
    const hexBudget = Math.max(0, Math.min(8, bodyRows - 19 - decodedRows - (decodedRows > 0 ? 1 : 0)));
    const hexRows: string[] = [];
    for (let offset = 0; offset < inputBytes.length && hexRows.length < hexBudget; offset += 32) {
        hexRows.push(inputBytes.subarray(offset, offset + 32).toString("hex"));
    }
    const shownBytes = hexRows.length * 32;
    const entryName = entry ? `${tx.inputType} · ${entry.name}${entry.notification ? " (notification)" : ""}` : String(tx.inputType);

    return (
        <Box flexDirection="column">
            <Box marginTop={1} flexDirection="column">
                <Text>
                    <Grad text="TRANSACTION" />
                    <Text dimColor>{`  ${tx.hash}`}</Text>
                </Text>
                <Box marginTop={1} flexDirection="column">
                    <Text>
                        <Text color={theme.info}>from </Text>
                        <Text>{tx.source}</Text>
                    </Text>
                    <Text>
                        <Text color={theme.info}> to </Text>
                        <Text>{tx.destination}</Text>
                        {label ? (
                            <Text>
                                {"  "}
                                <Badge text={label} color={theme.info} />
                            </Text>
                        ) : null}
                    </Text>
                </Box>
            </Box>
            <Box marginTop={1}>
                <KV
                    rows={[
                        ["amount", fmtAmount(tx.amount)],
                        ["tick", String(tx.tickNumber)],
                        ["timestamp", fmtTime(tx.timestamp)],
                        ["input type", entryName],
                        ["input size", `${tx.inputSize} bytes`],
                        ["money flew", tx.moneyFlew ? "✓ yes" : "◌ no"],
                        ["signature", tx.signature ? truncMid(tx.signature, 60) : "—"],
                    ]}
                />
            </Box>
            {hexRows.length > 0 || decodedRows > 0 ? (
                <Box marginTop={1} flexDirection="column">
                    <SectionHeader title="input data" detail={`${inputBytes.length} bytes`} width={columns} />
                    <SectionBody>
                        {fieldRows.map(([name, value], index) => (
                            <Text key={`field-${index}`}>
                                <Text color={theme.info}>{name}</Text>
                                <Text>{`  ${value}`}</Text>
                            </Text>
                        ))}
                        {hiddenFields > 0 ? <Text dimColor>{`… ${hiddenFields} more fields`}</Text> : null}
                        {formatRow ? (
                            <Box marginTop={1}>
                                <Text dimColor>{formatRow}</Text>
                            </Box>
                        ) : null}
                        {hexRows.length > 0 ? (
                            <Box marginTop={decodedRows > 0 ? 1 : 0} flexDirection="column">
                                {hexRows.map((row, index) => (
                                    <Text key={index} dimColor>
                                        {row}
                                    </Text>
                                ))}
                                {inputBytes.length > shownBytes ? <Text dimColor>{`… ${inputBytes.length - shownBytes} more bytes`}</Text> : null}
                            </Box>
                        ) : null}
                    </SectionBody>
                </Box>
            ) : null}
            <Box marginTop={1}>
                <Text dimColor>↵ opens the sender's identity</Text>
            </Box>
        </Box>
    );
}
