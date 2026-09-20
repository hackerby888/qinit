import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { readFileSync } from "node:fs";
import { DEFAULT_RPC_BASE, LiteRpc } from "@qinit/core";
import { abiTypeFromFormat, AbiTypeKind, assertInputSize, encodeInputFormatAs, ORACLE_STATUS, zeroInputFormat, type AbiType } from "@qinit/proto";
import { ORACLE_INTERFACES } from "@qinit/engine/oracle-interfaces/registry";
import { loadConfig } from "../../config";
import { Header, Spinner, KV, theme } from "../../ui";
import { output, type CommandArguments } from "../../args";

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
export async function encodeReply(interfaceIndex: number, replyText: string, replyHex: string): Promise<Uint8Array> {
    const oracleInterface = interfaceOf(interfaceIndex);
    const replyType = replyTypeOf(oracleInterface);

    if (replyHex) {
        const hex = replyHex.replace(/^0x/, "");
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

function pendingRows(queries: PendingQuery[]): [string, string][] {
    if (!queries.length) return [["pending", "none"]];

    return queries.map((query) => [
        `#${query.queryId}`,
        `${interfaceOf(query.interfaceIndex).name}  slot ${query.slot}  query ${Buffer.from(query.query.subarray(0, 12)).toString("hex")}… (${query.query.length} B)`,
    ]);
}

export function Oracle({ commandArgs }: { commandArgs: CommandArguments }) {
    const o = {
        rpc: commandArgs.get("rpc"),
        reply: commandArgs.get("reply") ?? "",
        replyHex: commandArgs.get("reply-hex") ?? "",
        status: commandArgs.get("status") ?? "success",
        rules: commandArgs.get("rules") ?? "",
        sub: commandArgs.positionals[0] ?? "pending",
        arg: commandArgs.positionals[1] ?? "",
    };
    const rpcBaseUrl = o.rpc || loadConfig().rpc || DEFAULT_RPC_BASE;
    const { exit } = useApp();
    const [rows, setRows] = useState<[string, string][] | null>(null);
    const [busy, setBusy] = useState("");
    const [err, setErr] = useState("");
    const [served, setServed] = useState<string[]>([]);

    useEffect(() => {
        let stopped = false;
        (async () => {
            const rpc = new LiteRpc(rpcBaseUrl);
            try {
                if (o.sub === "pending") {
                    setRows(pendingRows(await rpc.oraclePending()));
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

                    while (!stopped) {
                        for (const query of await rpc.oraclePending()) {
                            const oracleInterface = interfaceOf(query.interfaceIndex);
                            const replyText = rules ? rules[oracleInterface.name] : o.reply;
                            if (!replyText && !(!rules && o.replyHex)) continue;

                            const reply = await encodeReply(query.interfaceIndex, replyText ?? "", rules ? "" : o.replyHex);
                            const result = await rpc.oracleResolve(query.queryId, reply, ORACLE_STATUS.SUCCESS);
                            setServed((lines) => [...lines.slice(-8), `#${query.queryId} ${oracleInterface.name} ${result.ok ? "answered" : "refused"}`]);
                        }
                        await new Promise((resolve) => setTimeout(resolve, SERVE_POLL_MS));
                    }
                } else {
                    throw new Error(`unknown subcommand '${o.sub}' (use: pending | resolve <queryId> | serve)`);
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
            if (output.json) process.stdout.write(JSON.stringify({ ok: !err, rows: rows ?? [], error: err || undefined }) + "\n");
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
