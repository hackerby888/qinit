import { useEffect, useState } from "react";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Box, Text, useApp } from "ink";
import { DEFAULT_RPC_BASE, LiteRpc, resolveTrapBacktrace, formatTrapBacktrace, type DebugEntry } from "@qinit/core";
import { activeNodeScratchDir } from "../../ops/node";
import { callFunction, invokeProcedure, encodeInput, encodeInputJson, parseInputJson, checkInputSize, zeroInputFormat, TX_TICK_OFFSET } from "@qinit/proto";
import { AbiTypeKind, type ContractEntry } from "@qinit/proto/contract-idl";
import { extractIdl } from "@qinit/build";
import { describeTrace, type DecodedTrace } from "../../trace/format";
import { fmtVal, formatStateValue } from "../../trace/state-format";
import { entryLabel } from "../../trace/entry-label";
import { TraceView } from "../../trace/views";
import { CallInteractive, type CollectedCall } from "./call-interactive";
import { loadConfig, loadConfiguredQpiHeader, resolveSeed } from "../../config";
import { resolveFundedSigner, unfundedSignerMessage } from "../../ops/signer";
import { loadContracts, resolveContract } from "../../contracts/registry";
import { contractIdlForSlot, loadContractIdlFile } from "../../contracts/idl-file";
import { Header, Spinner, Status, Bar, theme } from "../../ui";
import { invalidArgs, output, type CommandArguments } from "../../args";

type Result = {
    ok: boolean | null;
    label: string;
    detail?: string;
    rows?: [string, string][];
    err?: string;
};
type Trace = { e: DebugEntry; name: string; entry: string; view: DecodedTrace };
// What --json reports beyond the result itself: the values the rendered rows hold as text.
type CallFacts = { contract: string; slot: number; entry: string; tick?: number; tx?: string; out?: string };
type Confirm = { start: number; net: number; target: number };
type CallMode = "fn" | "proc";

// Non-interactive forms (qubic-cli style):
//   qinit call --fn   <idx> <functionId>   --in "<fmt>" --out "<fmt>"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --json: the rendered rows as data. Trace keys are absent without --trace rather than empty, so a
// consumer can tell "nothing changed" from "never captured"; internal rows come through tagged, not
// dropped, which is what --trace-full toggles in the view.
export function callJsonResult(mode: CallMode, contract: string, entryName: string, result: Result | null, facts: CallFacts | null, trace: Trace | null) {
    return {
        ok: result?.ok ?? false,
        contract: facts?.contract ?? contract,
        slot: facts?.slot ?? null,
        entry: facts?.entry ?? entryName,
        kind: mode === "fn" ? "function" : "procedure",
        tick: facts?.tick ?? trace?.e.tick ?? null,
        tx: facts?.tx ?? null,
        out: facts?.out ?? trace?.view.outDecoded ?? null,
        error: result?.err ?? null,
        ...(trace
            ? {
                  execNs: trace.e.execNs,
                  caller: trace.view.caller,
                  in: trace.view.inDecoded,
                  state: trace.view.stateDiff.map((line) => ({ label: line.label, detail: line.detail, text: line.text, internal: line.internal })),
                  logs: trace.view.logs.map((log) => ({
                      severity: log.severity,
                      type: log.type,
                      name: log.name ?? null,
                      fields: log.fields ?? null,
                      hex: log.hex,
                  })),
              }
            : {}),
    };
}

// Log fields decode to bigint, which JSON.stringify throws on, and a uint64 past 2^53 would lose
// digits as a number anyway.
export const bigintText = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);

// The wizard's answers as if they had been typed. A key present in `overrides` wins even when its value is
// undefined, so a stray --args/--out/--amount cannot outlive the prompt that replaced it.
export function overlayArgs(base: CommandArguments, positionals: string[], overrides: Record<string, string | undefined>): CommandArguments {
    return {
        positionals,
        has: (name) => (name in overrides ? overrides[name] !== undefined : base.has(name)),
        get: (name) => (name in overrides ? overrides[name] : base.get(name)),
        getAll: (name) => base.getAll(name),
    };
}

export function Call({ commandArgs }: { commandArgs: CommandArguments }) {
    // Declared before the argument checks so no throw below can skip the hook.
    const [collected, setCollected] = useState<CollectedCall | null>(null);
    const fn = commandArgs.has("fn");
    const proc = commandArgs.has("proc");
    if (fn && proc) {
        invalidArgs("choose either --fn or --proc");
    }

    const mode = fn ? "fn" : proc ? "proc" : undefined;
    const contract = commandArgs.positionals[0];
    const entryName = commandArgs.positionals[1];
    if (mode && (!contract || !entryName)) {
        invalidArgs(`${mode} requires <contract> and <entry>`);
    }
    // The wizard draws frames on stdout, which would land in front of the JSON document it produced.
    if (output.json && !mode) {
        invalidArgs("--json needs --fn or --proc");
    }
    // Refused before the wizard mounts: its useInput would ask ink for raw mode and throw ink's own message.
    if (!process.stdin.isTTY && !mode) {
        invalidArgs("call needs --fn or --proc without a terminal — `qinit ls` lists contracts and their entries");
    }
    const rpcBaseUrl = commandArgs.get("rpc") || loadConfig().rpc || DEFAULT_RPC_BASE;
    if (collected) {
        return (
            <CallOneShot
                commandArgs={overlayArgs(commandArgs, [collected.contract, collected.entry], collected.overrides)}
                mode={collected.mode}
                contract={collected.contract}
                entryName={collected.entry}
                rpcBaseUrl={rpcBaseUrl}
                cmdHint={collected.hint}
            />
        );
    }
    if (!mode) {
        return <CallInteractive rpcBaseUrl={rpcBaseUrl} onRun={setCollected} />;
    }
    return <CallOneShot commandArgs={commandArgs} mode={mode} contract={contract!} entryName={entryName!} rpcBaseUrl={rpcBaseUrl} />;
}

function CallOneShot({
    commandArgs,
    mode,
    contract,
    entryName,
    rpcBaseUrl,
    cmdHint,
}: {
    commandArgs: CommandArguments;
    mode: CallMode;
    contract: string;
    entryName: string;
    rpcBaseUrl: string;
    cmdHint?: string;
}) {
    const { exit } = useApp();
    const inputJson = commandArgs.get("args");
    const inputFormat = commandArgs.get("in");
    const outputFormat = commandArgs.get("out");
    const showAll = commandArgs.has("all");
    const showInternals = commandArgs.has("trace-full");
    const wantTrace = commandArgs.has("trace") || showInternals;
    const settle = !commandArgs.has("no-settle");
    const seed = commandArgs.get("seed");
    const amount = commandArgs.get("amount");
    const [result, setResult] = useState<Result | null>(null);
    const [trace, setTrace] = useState<Trace | null>(null);
    const [facts, setFacts] = useState<CallFacts | null>(null);
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const [note, setNote] = useState("");
    const [done, setDone] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const rpc = new LiteRpc(rpcBaseUrl);
                const idlFile = loadContractIdlFile();

                // contract: resolve a name or index across user-deployed (first) then built-in system contracts.
                const sets = await loadContracts(rpc);
                const rc = resolveContract(contract, sets);
                if (!rc) throw new Error(`no contract '${contract}' (deployed or system — run \`qinit node run\` to load system contracts)`);
                const idx = rc.index;
                // entry: accept a fn/proc name or an inputType number. Prefer local qinit.idl.json, else derive from the
                // contract source (node dyn-registry source for user contracts, snapshot source for system contracts).
                const localContractIdl = contractIdlForSlot(idlFile, idx, rc.codeHash);
                let contractIdl = localContractIdl;
                let entries = mode === "fn" ? contractIdl?.functions : contractIdl?.procedures;
                if ((!entries || entries.length === 0) && rc.source) {
                    // Without a core checkout there is no header to derive names from, which leaves numeric entries usable.
                    try {
                        contractIdl = extractIdl(rc.source, rc.name, {
                            slot: idx,
                            qpiHeader: loadConfiguredQpiHeader(),
                        });
                        entries = mode === "fn" ? contractIdl.functions : contractIdl.procedures;
                    } catch {
                        contractIdl = localContractIdl;
                    }
                }
                entries ??= [];
                let entry = Number(entryName);
                let entryIdl: ContractEntry | undefined = entries.find((candidate) => candidate.inputType === entry);
                if (Number.isNaN(entry)) {
                    entryIdl = entries.find((candidate) => candidate.name.toLowerCase() === entryName.toLowerCase());
                    if (!entryIdl) {
                        throw new Error(`no ${mode} named '${entryName}' on contract ${idx} (no local IDL and node has no source for this slot)`);
                    }
                    entry = entryIdl.inputType;
                }
                // --args JSON encodes through the IDL schema; otherwise use raw --in format.
                let input: Uint8Array;
                if (inputJson !== undefined) {
                    if (!entryIdl) {
                        throw new Error(
                            `--args needs the input schema for ${mode} ${idx}/${entry} (build/deploy locally, or the node must have the contract source)`,
                        );
                    }
                    try {
                        input = await encodeInputJson(entryIdl.input, parseInputJson(inputJson));
                    } catch (er: any) {
                        throw new Error("--args: " + String(er?.message ?? er));
                    }
                } else {
                    try {
                        input = await encodeInput(inputFormat ?? entryIdl?.input.format ?? "");
                    } catch (enc: any) {
                        let z = "";
                        try {
                            if (entryIdl && !(entryIdl.input.kind === AbiTypeKind.STRUCT && entryIdl.input.fields.length === 0)) {
                                z = zeroInputFormat(entryIdl.input);
                            }
                        } catch {}
                        throw new Error(`bad input: ${enc?.message ?? enc}${z ? `\nall-zero sample: ${z}` : ""}`);
                    }
                }
                if (entryIdl) {
                    try {
                        checkInputSize(entryIdl.input, input, `${mode} ${idx}/${entry}`);
                    } catch (size: any) {
                        throw new Error(`bad input: ${size?.message ?? size}`);
                    }
                }

                // --trace: capture the call in the node debug ring. Enable + note the latest seq BEFORE dispatch.
                // Entry seq is 1-based on both backends, so 0 means "everything captured from here on".
                let sinceSeq = 0;
                const traceSrc = rc.source;
                const traceName = rc.name;
                if (wantTrace) {
                    try {
                        await rpc.setDebug(true);
                        sinceSeq = ((await rpc.debugTrace(0, 500)).entries ?? []).reduce((mx, en) => Math.max(mx, en.seq), 0);
                    } catch {}
                }

                // node-side runtime error: the most recent dispatch trap on this slot (dyn-registry lastError).
                const nodeErr = async (): Promise<string> => {
                    try {
                        const reg = await rpc.dynRegistry();
                        const c = (reg.contracts ?? []).find((x) => x.index === idx);
                        return c?.lastError ?? "";
                    } catch {
                        return "";
                    }
                };
                // upgrade a raw trap string to a source-mapped backtrace via node.log + the slot's DWARF sidecar.
                const enrichErr = async (raw: string): Promise<string | undefined> => {
                    if (!raw) return undefined;
                    try {
                        const lineMapPath = localContractIdl?.linesJson;
                        const log = join(activeNodeScratchDir(), "node.log");
                        if (existsSync(log)) {
                            const bt = resolveTrapBacktrace(readFileSync(log, "utf8"), {
                                lineMapPath,
                            });
                            if (bt?.frames.length) return formatTrapBacktrace(bt);
                        }
                    } catch {}
                    return raw;
                };
                // A slot index resolves but reads poorly as a label, so fall back to the built name the way the picker does.
                const contractName = rc.name === String(idx) ? (localContractIdl?.name ?? rc.name) : rc.name;
                const label = `${contractName}.${entryIdl?.name ?? (mode === "fn" ? "fn#" : "proc#") + entry}`;

                const entryLabelName = entryIdl?.name ?? String(entry);

                if (mode === "fn") {
                    const out = await callFunction(rpc, idx, entry, input, outputFormat ?? entryIdl?.output ?? "");
                    const empty = out == null || (typeof out === "object" && Object.keys(out).length === 0);
                    const ne = empty ? await nodeErr() : "";
                    // An explicit --out format overrides the IDL, and only the IDL type carries field names.
                    const rendered = !outputFormat && entryIdl ? formatStateValue(out, entryIdl.output, showAll, true) : fmtVal(out, showAll);
                    setFacts({ contract: rc.name, slot: idx, entry: entryLabelName, out: rendered });
                    setResult({
                        ok: ne ? false : true,
                        label,
                        rows: [["out", rendered]],
                        err: await enrichErr(ne),
                    });
                } else {
                    const tickInfo = await rpc.tickInfo();
                    const tick = tickInfo.tick + TX_TICK_OFFSET;
                    const signer = await resolveFundedSigner(rpc, await resolveSeed(rpc, seed), {
                        explicit: Boolean(seed),
                    });
                    if (signer.switched) {
                        setNote(`⚠ seed unfunded here — signing as ${signer.identity}`);
                    }
                    const r = await invokeProcedure({
                        seed: signer.seed,
                        rpcBaseUrl: rpcBaseUrl,
                        contractIndex: idx,
                        procedureId: entry,
                        amount: Number(amount ?? 0),
                        input,
                        tick,
                        confirm: settle,
                        rpc,
                        onProgress: ({ tick: net, target }) => setConfirm((c) => ({ start: c?.start ?? net, net, target })),
                    });
                    setConfirm(null);
                    const txs = (r.txId ?? "") || "—"; // full txid — user pastes it into the explorer
                    const detail = !r.ok
                        ? `FAIL${r.code != null ? " code=" + r.code : ""}`
                        : !settle
                          ? "broadcast"
                          : r.confirmed && r.included
                            ? "processed"
                            : r.confirmed && !r.included
                              ? "dropped — not included"
                              : "broadcast · unconfirmed";
                    const ok = !r.ok ? false : r.confirmed && !r.included ? false : true;
                    // An empty signer is the usual reason a broadcast tx never makes it into a tick.
                    const dropped = r.ok && r.confirmed && !r.included;
                    setFacts({ contract: rc.name, slot: idx, entry: entryLabelName, tick, tx: r.txId || undefined });
                    setResult({
                        ok,
                        label,
                        detail,
                        rows: [
                            ["tx", txs],
                            ["tick", String(tick)],
                        ],
                        err:
                            (await enrichErr(await nodeErr())) ||
                            (!r.ok ? r.message : undefined) ||
                            (dropped && signer.unfunded ? unfundedSignerMessage(signer.identity) : undefined),
                    });
                }

                if (wantTrace) {
                    let te: DebugEntry | undefined;
                    for (let i = 0; i < 12 && !te; i++) {
                        const t = await rpc.debugTrace(sinceSeq, 200);
                        te = (t.entries ?? [])
                            .filter((x) => x.index === idx && x.seq > sinceSeq && x.kind === (mode === "fn" ? 0 : 1) && x.entry === entry)
                            .pop();
                        if (!te) await sleep(700);
                    }
                    // The header only matters for deriving an IDL from source, and the build already gave
                    // us one — a core checkout that cannot supply it must not fail a call that ran.
                    let traceHeader: string | undefined;
                    try {
                        traceHeader = traceSrc ? loadConfiguredQpiHeader() : undefined;
                    } catch {}

                    if (te)
                        setTrace({
                            e: te,
                            name: traceName,
                            entry: entryLabel(mode === "fn" ? 0 : 1, entry, entryIdl?.name),
                            view: await describeTrace(te, traceHeader ? traceSrc : undefined, traceName, traceHeader, contractIdl),
                        });
                    else setNote("(no trace captured — is the debug toggle available on this node?)");
                }
                setDone(true);
            } catch (e: any) {
                setResult({ ok: false, label: "call", err: String(e?.message ?? e) });
                setDone(true);
            }
        })();
    }, []);
    useEffect(() => {
        if (done) {
            if (output.json) process.stdout.write(JSON.stringify(callJsonResult(mode, contract, entryName, result, facts, trace), bigintText) + "\n");
            if (result?.ok === false) process.exitCode = 1;
            exit();
        }
    }, [done]); // failure -> non-zero for scripts/CI

    if (output.json) return null;

    const rw = Math.max(2, ...(result?.rows ?? []).map(([k]) => k.length));
    const pct = confirm && confirm.target > confirm.start ? (confirm.net - confirm.start) / (confirm.target - confirm.start) : 1;
    return (
        <Box flexDirection="column">
            <Header cmd="call" />
            {result && (
                <Box flexDirection="column">
                    <Status ok={result.ok} label={result.label} detail={result.detail} pad={Math.max(14, result.label.length + 2)} />
                    {result.rows?.length ? (
                        <Box flexDirection="column" marginLeft={2}>
                            {result.rows.map(([k, v], i) => (
                                <Text key={i}>
                                    <Text color={theme.info}>{k.padEnd(rw)}</Text> {v}
                                </Text>
                            ))}
                        </Box>
                    ) : null}
                    {result.err ? (
                        <Box marginLeft={2}>
                            <Text color={theme.err}>{result.err}</Text>
                        </Box>
                    ) : null}
                </Box>
            )}
            {trace && (
                <Box marginTop={1}>
                    <TraceView e={trace.e} name={trace.name} entry={trace.entry} view={trace.view} showInternals={showInternals} internalsHint="--trace-full" />
                </Box>
            )}
            {note && <Text dimColor>{note}</Text>}
            {!done &&
                (confirm ? (
                    <Text>
                        <Bar pct={pct} />{" "}
                        <Text dimColor>
                            tick {confirm.net}→{confirm.target}
                        </Text>
                    </Text>
                ) : (
                    <Spinner label="calling" />
                ))}
            {cmdHint && result ? (
                <Box marginTop={1}>
                    <Text bold color={theme.accent}>
                        ≡ {cmdHint}
                    </Text>
                </Box>
            ) : null}
        </Box>
    );
}
