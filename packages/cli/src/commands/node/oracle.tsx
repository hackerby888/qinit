import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp } from "ink";
import { readFileSync } from "node:fs";
import { DEFAULT_PEER_PORT, LiteRpc } from "@qinit/core";
import { abiTypeFromFormat, AbiTypeKind, assertInputSize, encodeInputFormatAs, ORACLE_STATUS, zeroInputFormat, type AbiType } from "@qinit/proto";
import { ORACLE_INTERFACES } from "@qinit/engine/oracle-interfaces/registry";
import { loadConfig, resolveRpc } from "../../config";
import { Header, Spinner, KV, theme, termCols } from "../../ui";
import { output, type CommandArguments } from "../../args";
import { readTickLogRecords } from "../../ops/node-logs";
import { oracleLogEntries, oracleLogText, type OracleLogEntry } from "../../ops/oracle-log";

type PendingQuery = { queryId: bigint; slot: number; interfaceIndex: number; query: Uint8Array };

const STATUS_BY_NAME: Record<string, number> = {
    success: ORACLE_STATUS.SUCCESS,
    // an oracle machine can only report that it has no value; the query then ends at its own timeout, on a node as on the simulator.
    unavailable: ORACLE_STATUS.UNRESOLVABLE,
};

function interfaceOf(interfaceIndex: number) {
    const oracleInterface = ORACLE_INTERFACES[interfaceIndex];
    if (!oracleInterface) throw new Error(`unknown oracle interface ${interfaceIndex}`);
    return oracleInterface;
}

// the format text carries types and not names, so the mirror's field names are put back to make an error point at a member the user can see.
function replyTypeOf(oracleInterface: (typeof ORACLE_INTERFACES)[number]): AbiType {
    const replyType = abiTypeFromFormat(oracleInterface.replyFormat);
    const names = Object.keys(oracleInterface.reply.OFFSETS);
    if (replyType.kind !== AbiTypeKind.STRUCT || replyType.fields.length !== names.length) {
        return replyType;
    }

    return { ...replyType, fields: replyType.fields.map((field, index) => ({ ...field, name: names[index] })) };
}

// "123456sint64, 1000sint64" -> reply bytes, checked against the interface's own reply layout.
export async function encodeReply(interfaceIndex: number, replyText: string, replyHex: string | undefined): Promise<Uint8Array> {
    const oracleInterface = interfaceOf(interfaceIndex);
    const replyType = replyTypeOf(oracleInterface);

    // given at all, even empty, the answer is hex: '' is a zero-byte reply, not an empty text reply
    if (replyHex !== undefined) {
        const hex = replyHex.replace(/^0x/i, "");
        if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) throw new Error(`--reply-hex '${replyHex}' is not whole hex bytes`);
        const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
        assertInputSize(replyType, bytes, `${oracleInterface.name} reply`);
        return bytes;
    }

    try {
        const bytes = await encodeInputFormatAs(replyType, replyText);
        assertInputSize(replyType, bytes, `${oracleInterface.name} reply`);
        return bytes;
    } catch (error: any) {
        throw new Error(`${String(error?.message ?? error)}\n  ${oracleInterface.name} reply looks like: ${zeroInputFormat(replyType)}`);
    }
}

// a rules file maps an interface name to the reply text used for every query on it, e.g. {"Price": "123456sint64, 1000sint64"}
function loadRules(path: string): Record<string, string> {
    const rules = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    for (const [name, replyText] of Object.entries(rules)) {
        if (!ORACLE_INTERFACES.some((oracleInterface) => oracleInterface.name === name)) throw new Error(`rules: unknown oracle interface '${name}'`);
        if (typeof replyText !== "string") throw new Error(`rules: '${name}' must map to reply text`);
    }
    return rules;
}

// the query preview takes only the room KV leaves for a value, so KV never has to cut the row in the middle
export function pendingRows(queries: PendingQuery[], columns = termCols()): [string, string][] {
    if (!queries.length) return [["pending", "none"]];

    const labelWidth = Math.max(...queries.map((query) => `#${query.queryId}`.length));
    const budget = Math.max(12, columns - labelWidth - 8);
    return queries.map((query) => {
        const head = `${interfaceOf(query.interfaceIndex).name}  slot ${query.slot}  query `;
        const tail = `… (${query.query.length} B)`;
        const bytes = Math.max(0, Math.min(12, Math.floor((budget - head.length - tail.length) / 2)));
        return [`#${query.queryId}`, `${head}${Buffer.from(query.query.subarray(0, bytes)).toString("hex")}${tail}`];
    });
}

export type OracleFacts = {
    pending?: { queryId: string; interface: string; interfaceIndex: number; slot: number; query: string }[];
    resolved?: { queryId: string; interface: string; status: string; reply: string | null };
    log?: OracleLogEntry[];
};

// --json returns the data behind the rows: ids as decimal strings, query and reply bytes as full hex.
export function oracleJsonResult(action: string, facts: OracleFacts | null, error: string) {
    return {
        ok: !error,
        action,
        pending: facts?.pending ?? null,
        resolved: facts?.resolved ?? null,
        // only `log` reports records, so the other actions keep their envelope
        ...(action === "log" ? { log: facts?.log ?? null } : {}),
        error: error || null,
    };
}

export function pendingFacts(queries: PendingQuery[]): OracleFacts["pending"] {
    return queries.map((query) => ({
        queryId: String(query.queryId),
        interface: interfaceOf(query.interfaceIndex).name,
        interfaceIndex: query.interfaceIndex,
        slot: query.slot,
        query: Buffer.from(query.query).toString("hex"),
    }));
}

// One pass of `serve`: answer every pending query a rule or --reply covers. A query this server cannot answer is reported once
// and remembered in `skipped`, so one bad query does not end the others.
export async function servePending(
    rpc: Pick<LiteRpc, "oraclePending" | "oracleResolve">,
    answer: { rules: Record<string, string> | null; reply: string; replyHex: string | undefined },
    skipped: Set<bigint>,
): Promise<string[]> {
    const lines: string[] = [];
    for (const query of await rpc.oraclePending()) {
        if (skipped.has(query.queryId)) continue;
        const oracleInterface = interfaceOf(query.interfaceIndex);
        const replyText = answer.rules ? answer.rules[oracleInterface.name] : answer.reply;
        if (!replyText && !(!answer.rules && answer.replyHex)) continue;

        try {
            // a rule is reply text; `undefined` keeps it from reading as an empty --reply-hex
            const reply = await encodeReply(query.interfaceIndex, replyText ?? "", answer.rules ? undefined : answer.replyHex);
            const result = await rpc.oracleResolve(query.queryId, reply, ORACLE_STATUS.SUCCESS);
            lines.push(`#${query.queryId} ${oracleInterface.name} ${result.ok ? "answered" : "refused"}`);
        } catch (e: any) {
            skipped.add(query.queryId);
            lines.push(`#${query.queryId} ${oracleInterface.name} skipped: ${String(e?.message ?? e)}`);
        }
    }
    return lines;
}

export function Oracle({ commandArgs }: { commandArgs: CommandArguments }) {
    const o = {
        rpc: commandArgs.get("rpc"),
        reply: commandArgs.get("reply") ?? "",
        replyHex: commandArgs.get("reply-hex"),
        status: commandArgs.get("status") ?? "success",
        rules: commandArgs.get("rules") ?? "",
        sub: commandArgs.positionals[0] ?? "pending",
        arg: commandArgs.positionals[1] ?? "",
        to: commandArgs.positionals[2] ?? "",
        peerPort: commandArgs.get("peer-port"),
    };
    const rpcBaseUrl = resolveRpc(o.rpc, loadConfig());
    const { exit } = useApp();
    const [rows, setRows] = useState<[string, string][] | null>(null);
    const [busy, setBusy] = useState("");
    const [err, setErr] = useState("");
    const [served, setServed] = useState<string[]>([]);
    // a ref, not state: the emit below must not read a batched-stale null.
    const factsRef = useRef<OracleFacts | null>(null);

    useEffect(() => {
        let stopped = false;
        (async () => {
            const rpc = new LiteRpc(rpcBaseUrl);
            try {
                if (o.sub === "pending") {
                    const queries = await rpc.oraclePending();
                    factsRef.current = { pending: pendingFacts(queries) };
                    setRows(pendingRows(queries));
                } else if (o.sub === "resolve") {
                    if (!o.arg) throw new Error("resolve <queryId> [--reply <value text> | --reply-hex <hex>] [--status success|unavailable]");
                    const status = STATUS_BY_NAME[o.status];
                    if (status === undefined) throw new Error(`--status '${o.status}' is not success or unavailable`);

                    const queryId = BigInt(o.arg);
                    const pending = await rpc.oraclePending();
                    const query = pending.find((entry) => entry.queryId === queryId);
                    if (!query) throw new Error(`query ${queryId} is not waiting for a reply`);

                    const reply = status === ORACLE_STATUS.SUCCESS ? await encodeReply(query.interfaceIndex, o.reply, o.replyHex) : new Uint8Array(0);
                    const result = await rpc.oracleResolve(queryId, reply, status);
                    if (!result.ok) throw new Error(`the node refused the reply${result.message ? `: ${result.message}` : ""}`);

                    factsRef.current = {
                        resolved: {
                            queryId: String(queryId),
                            interface: interfaceOf(query.interfaceIndex).name,
                            status: o.status,
                            reply: status === ORACLE_STATUS.SUCCESS ? Buffer.from(reply).toString("hex") : null,
                        },
                    };
                    setRows([
                        ["query", String(queryId)],
                        ["interface", interfaceOf(query.interfaceIndex).name],
                        ["reply", status === ORACLE_STATUS.SUCCESS ? Buffer.from(reply).toString("hex") : "none (reported unavailable)"],
                        // a node answers through its commit and reveal steps, so the contract is notified a few ticks later.
                        ["accepted", "yes — the contract is notified once the reply is revealed"],
                    ]);
                } else if (o.sub === "serve") {
                    const rules = o.rules ? loadRules(o.rules) : null;
                    if (!rules && !o.reply && !o.replyHex) throw new Error("serve needs --rules <file> or a --reply to answer every query with");
                    setBusy("answering oracle queries — ctrl-c to stop");

                    const skipped = new Set<bigint>();
                    while (!stopped) {
                        const lines = await servePending(rpc, { rules, reply: o.reply, replyHex: o.replyHex }, skipped);
                        if (lines.length) setServed((shown) => [...shown, ...lines].slice(-9));
                        await new Promise((resolve) => setTimeout(resolve, SERVE_POLL_MS));
                    }
                } else if (o.sub === "log") {
                    // the oracle and OC records of a tick range, read from the node's log stream over its peer port
                    const tick = (await rpc.tickInfo()).tick;
                    const to = o.to ? Number(o.to) : tick;
                    const from = o.arg ? Number(o.arg) : Math.max(0, to - LOG_DEFAULT_TICKS + 1);
                    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) {
                        throw new Error(`log [<fromTick> [<toTick>]]: '${o.arg} ${o.to}' is not a tick range`);
                    }
                    if (to - from + 1 > LOG_MAX_TICKS) throw new Error(`log reads at most ${LOG_MAX_TICKS} ticks at a time (asked ${to - from + 1})`);
                    const host = new URL(rpcBaseUrl).hostname.replace(/^\[|\]$/g, "");
                    const port = o.peerPort ? Number(o.peerPort) : DEFAULT_PEER_PORT;
                    setBusy(`reading the log of ticks ${from}..${to} from ${host}:${port}`);
                    const entries: OracleLogEntry[] = [];
                    for (let at = from; at <= to && !stopped; at++) {
                        entries.push(...oracleLogEntries(await readTickLogRecords(host, port, at)));
                    }
                    factsRef.current = { log: entries };
                    setRows(
                        entries.length
                            ? entries.map((entry): [string, string] => [`${entry.tick} r${entry.range}`, oracleLogText(entry)])
                            : [["log", `no oracle or OC records in ticks ${from}..${to}`]],
                    );
                } else {
                    throw new Error(`unknown subcommand '${o.sub}' (use: pending | resolve <queryId> | serve | log [<fromTick> [<toTick>]])`);
                }
            } catch (e: any) {
                setErr(String(e?.message ?? e));
            }
            setBusy("");
        })();
        return () => {
            stopped = true;
        };
    }, []);

    useEffect(() => {
        if (rows || err) {
            if (output.json) process.stdout.write(JSON.stringify(oracleJsonResult(o.sub, factsRef.current, err)) + "\n");
            process.exitCode = err ? 1 : 0;
            const timer = setTimeout(() => exit(), 30);
            return () => clearTimeout(timer);
        }
    }, [rows, err]);

    if (output.json) return null;

    return (
        <Box flexDirection="column">
            <Header cmd="oracle" />
            {busy && <Spinner label={busy} />}
            {served.map((line) => (
                <Text key={line} dimColor>
                    {line}
                </Text>
            ))}
            {err && <Text color={theme.err}>ERROR: {err}</Text>}
            {rows && (
                <Box marginTop={1}>
                    <KV rows={rows} />
                </Box>
            )}
        </Box>
    );
}

const SERVE_POLL_MS = 500;
// `log` without a range reads the last ticks up to the current one
const LOG_DEFAULT_TICKS = 30;
const LOG_MAX_TICKS = 2_000;
