import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { ContractCall, ContractListEntry } from "@qinit/core";
import { Grad, KV, SectionHeader, Spinner, Table, theme, type Column } from "../../../ui";
import { SectionBody, inputTypeLabel, errText, fmtAmount, fmtTime, sectionTableWidth, windowOf, type ViewProps } from "./chrome";

// The web explorer scans the last 500 ticks for contract calls; the same window keeps a page cheap here.
const CONTRACT_CALL_WINDOW = 500;
const CONTRACT_PAGE_SIZE = 50;

// ---- contracts ----------------------------------------------------------------------------------

const CONTRACT_COLS: Column[] = [
    { header: "#", align: "right", max: 5 },
    { header: "name", max: 24 },
    { header: "state", align: "right", max: 10 },
    { header: "calls", align: "right", max: 8 },
];

export function ContractsView({ rpc, refreshToken, selected, push, rowCount, openRow, bodyRows, columns, page }: ViewProps & { page: number }) {
    const [contracts, setContracts] = useState<ContractListEntry[]>([]);
    const [calls, setCalls] = useState<Map<number, number>>(new Map());
    const [window, setWindow] = useState<{ from: number; to: number } | null>(null);
    const [err, setErr] = useState("");
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let alive = true;
        setLoading(true);
        void (async () => {
            try {
                const [{ contracts: list }, data] = await Promise.all([rpc.getContracts(), rpc.explorerData()]);
                if (!alive) return;
                setContracts(list);

                const toTick = data.header.tick;
                const fromTick = Math.max(data.header.initialTick, toTick - CONTRACT_CALL_WINDOW + 1);
                setWindow({ from: fromTick, to: toTick });

                const callPage = await rpc.getContractCalls({
                    fromTick,
                    toTick,
                    page,
                    pageSize: CONTRACT_PAGE_SIZE,
                });
                if (!alive) return;

                const counts = new Map<number, number>();
                for (const call of callPage.transactions) {
                    counts.set(call.contractIndex, (counts.get(call.contractIndex) ?? 0) + 1);
                }
                setCalls(counts);
                setErr("");
            } catch (e) {
                if (alive) setErr(errText(e));
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => {
            alive = false;
        };
    }, [page, refreshToken]);

    rowCount.current = contracts.length;
    openRow.current = (index) => {
        const contract = contracts[index];
        if (contract) push({ kind: "contract", index: contract.index });
    };

    const { win, offset } = windowOf(contracts, selected, bodyRows - 4);

    return (
        <Box flexDirection="column">
            <SectionHeader
                title="contracts"
                detail={window ? `${contracts.length} deployed · calls counted over ticks ${window.from}–${window.to}` : `${contracts.length} deployed`}
                error={err}
                width={columns}
            />
            <SectionBody>
                {loading && contracts.length === 0 ? (
                    <Text color={theme.brand}>
                        <Spinner label="reading the contract catalog" />
                    </Text>
                ) : contracts.length === 0 ? (
                    <Text dimColor>no contracts deployed on this node</Text>
                ) : (
                    <Table
                        columns={CONTRACT_COLS}
                        rows={win.map((c) => [String(c.index), c.name || "—", `${c.stateSize} B`, String(calls.get(c.index) ?? 0)])}
                        selected={selected - offset}
                        width={sectionTableWidth(columns)}
                    />
                )}
            </SectionBody>
        </Box>
    );
}

const CALL_COLS: Column[] = [
    { header: "tick", align: "right", max: 12 },
    { header: "hash", max: 16 },
    { header: "caller", max: 22 },
    { header: "amount", align: "right", max: 16 },
    { header: "in", max: 22 },
    { header: "timestamp", max: 20 },
];

export function ContractView({ rpc, refreshToken, selected, contractIdls, push, rowCount, openRow, bodyRows, columns, index }: ViewProps & { index: number }) {
    const [meta, setMeta] = useState<ContractListEntry | null>(null);
    const [calls, setCalls] = useState<ContractCall[]>([]);
    const [err, setErr] = useState("");
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let alive = true;
        setLoading(true);
        void (async () => {
            try {
                const [{ contracts }, data] = await Promise.all([rpc.getContracts(), rpc.explorerData()]);
                if (!alive) return;
                setMeta(contracts.find((c) => c.index === index) ?? null);

                const toTick = data.header.tick;
                const page = await rpc.getContractCalls({
                    fromTick: Math.max(data.header.initialTick, toTick - CONTRACT_CALL_WINDOW + 1),
                    toTick,
                    contractIndex: index,
                    pageSize: 100,
                });
                if (!alive) return;
                setCalls(page.transactions);
                setErr("");
            } catch (e) {
                if (alive) setErr(errText(e));
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => {
            alive = false;
        };
    }, [index, refreshToken]);

    rowCount.current = calls.length;
    openRow.current = (row) => {
        const call = calls[row];
        if (call) push({ kind: "tx", hash: call.hash, tick: call.tickNumber });
    };

    // Title, the 3-row KV when present, and the section header.
    const { win, offset } = windowOf(calls, selected, bodyRows - (meta ? 10 : 6));

    return (
        <Box flexDirection="column">
            <Box marginTop={1}>
                <Text>
                    <Grad text={meta?.name || `contract #${index}`} />
                    <Text dimColor>{`  #${index}`}</Text>
                </Text>
            </Box>
            {meta ? (
                <Box marginTop={1}>
                    <KV
                        rows={[
                            ["state size", `${meta.stateSize} bytes`],
                            ["construction", String(meta.constructionEpoch)],
                            ["destruction", String(meta.destructionEpoch)],
                        ]}
                    />
                </Box>
            ) : null}
            <SectionHeader title="calls" detail={`${calls.length} in the recent window`} error={err} width={columns} />
            <SectionBody>
                {loading && calls.length === 0 ? (
                    <Text color={theme.brand}>
                        <Spinner label="reading contract calls" />
                    </Text>
                ) : calls.length === 0 ? (
                    <Text dimColor>no calls to this contract in the recent window</Text>
                ) : (
                    <Table
                        columns={CALL_COLS}
                        rows={win.map((call) => [
                            String(call.tickNumber),
                            call.hash,
                            call.source,
                            fmtAmount(call.amount),
                            inputTypeLabel(call.contractIndex, call.inputType, contractIdls),
                            fmtTime(call.timestamp),
                        ])}
                        selected={selected - offset}
                        width={sectionTableWidth(columns)}
                    />
                )}
            </SectionBody>
        </Box>
    );
}
