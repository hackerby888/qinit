// The explorer's send form: a sender, a recipient, an amount, a confirmation, then the tx settling.
// FROM always ends as a seed because it has to sign; TO always ends as an identity because that is what
// the transaction carries. Either field accepts either form and resolves it.
import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { deriveIdentity, identityToBytes } from "@qinit/core";
import { TX_TICK_OFFSET, sendTransfer, type SubmittedTx } from "@qinit/proto";
import { resolveSeed } from "../../../config";
import { KV, SectionHeader, Spinner, Status, TextPrompt, theme, truncEnd, truncMid } from "../../../ui";
import { SectionBody, errText, fmtAmount, type ViewProps } from "./chrome";

// Ask for more than either backend holds so the whole pool always arrives. Never 0: core reads that as
// "all", the simulator as "none".
const FUNDED_POOL_LIMIT = 256;

const FIELD_COUNT = 3;

export type WalletInputKind = "empty" | "seed" | "identity" | "partial" | "invalid";

// Seeds are 55 lowercase letters, identities 60 uppercase. The shapes cannot overlap, so one field takes
// either without a mode switch, and a half-typed value is "partial" rather than an error.
export function classifyWalletInput(value: string): WalletInputKind {
    const trimmed = value.trim();

    if (trimmed === "") {
        return "empty";
    }
    if (/^[a-z]{55}$/.test(trimmed)) {
        return "seed";
    }
    if (/^[A-Z]{60}$/.test(trimmed)) {
        return "identity";
    }
    if (/^[a-z]{1,54}$/.test(trimmed) || /^[A-Z]{1,59}$/.test(trimmed)) {
        return "partial";
    }

    return "invalid";
}

interface PartyState {
    status: "idle" | "checking" | "ok" | "error";
    identity?: string;
    seed?: string; // sender only — the recipient never needs one
    destination?: Uint8Array; // recipient only
    message?: string;
}

interface AmountState {
    status: "idle" | "ok" | "error";
    qu?: number;
    message?: string;
}

export interface FundedPool {
    seedByIdentity: Map<string, string>;
    received: number;
    total: number;
}

// An identity as sender carries no private key, so its seed has to come out of the node's funded pool.
// A node without the route and a genuine miss are different failures and must never share a message —
// the routes are compile-gated on core, so "unavailable" is a real and common case.
export function poolSeedForIdentity(identity: string, pool: FundedPool | null, poolError: string): string {
    if (poolError) {
        throw new Error(`funded-seed route unavailable — the node is not a TESTNET build (${poolError})`);
    }
    if (!pool) {
        throw new Error("funded-seed pool has not loaded yet");
    }

    const seed = pool.seedByIdentity.get(identity);
    if (!seed) {
        const scope =
            pool.received < pool.total ? `the node returned only ${pool.received} of ${pool.total} pool seeds` : `the pool holds ${pool.total} seed(s)`;
        throw new Error(`not in the node's funded-seed pool — ${scope}`);
    }

    return seed;
}

// `max` is a word rather than an autofill: the prompt owns its own buffer, so writing into it from the
// outside would mean remounting the field and losing the caret.
function parseAmount(text: string, balance: bigint | null): AmountState {
    if (text === "") {
        return { status: "idle" };
    }

    const wantsMax = text.toLowerCase() === "max";
    if (wantsMax && balance == null) {
        return { status: "error", message: "max needs a resolved sender first" };
    }
    if (!wantsMax && !/^\d+$/.test(text)) {
        return { status: "error", message: "whole qu only — digits, or `max`" };
    }

    const wanted = wantsMax ? (balance as bigint) : BigInt(text);
    if (balance != null && wanted > balance) {
        const over = fmtAmount((wanted - balance).toString());
        return { status: "error", message: `over the sender's balance by ${over} qu` };
    }
    // buildSignedTx takes a number, and anything past 2^53 would round silently — signing an amount other
    // than the one on screen.
    if (!Number.isSafeInteger(Number(wanted))) {
        return { status: "error", message: "too large to sign exactly" };
    }

    return { status: "ok", qu: Number(wanted) };
}

function shapeHint(kind: WalletInputKind, value: string): string {
    if (kind === "partial") {
        const lower = /^[a-z]+$/.test(value);
        return lower ? `${value.length}/55 · seed` : `${value.length}/60 · identity`;
    }
    if (kind === "invalid") {
        return "not a seed (55 a-z) or an identity (60 A-Z)";
    }

    return "";
}

// Every hint must stay on one row: the shell budgets body rows by counting them, so a line that wraps
// pushes the control bar off-screen. A 60-character identity plus a balance overflows 80 columns, and the
// balance is the part worth keeping, so the identity is what gives.
function HintLine({ state, extra, columns }: { state: PartyState; extra?: string; columns: number }) {
    const budget = Math.max(20, columns - 4);

    if (state.status === "idle") {
        return (
            <Text color={theme.mute} dimColor>
                {truncEnd(extra ?? " ", budget)}
            </Text>
        );
    }
    if (state.status === "checking") {
        return (
            <Text color={theme.brand}>
                <Spinner label="resolving" />
            </Text>
        );
    }
    if (state.status === "error") {
        return <Text color={theme.err}>{truncEnd(state.message ?? "", budget)}</Text>;
    }

    const suffix = extra ? `  ·  ${extra}` : "";
    const identity = truncMid(state.identity ?? "", Math.max(12, budget - 2 - suffix.length));

    return (
        <Text>
            <Text color={theme.ok}>✓ </Text>
            <Text color={theme.mute} dimColor>
                {identity}
            </Text>
            {suffix ? <Text color={theme.info}>{suffix}</Text> : null}
        </Text>
    );
}

export function WalletView({
    rpc,
    rpcBaseUrl,
    push,
    rowCount,
    openRow,
    columns,
    to: prefilledTo,
    onExit,
}: ViewProps & {
    rpcBaseUrl: string;
    to?: string;
    onExit: () => void;
}) {
    const [ready, setReady] = useState(false);
    const [pool, setPool] = useState<FundedPool | null>(null);
    const [poolError, setPoolError] = useState("");

    const [fromInput, setFromInput] = useState("");
    const [toInput, setToInput] = useState(prefilledTo ?? "");
    const [amountInput, setAmountInput] = useState("");

    const [from, setFrom] = useState<PartyState>({ status: "idle" });
    const [to, setTo] = useState<PartyState>({ status: "idle" });
    const [balance, setBalance] = useState<bigint | null>(null);
    // Bumped after a send so the sender is re-read: its input string has not changed, but its balance has.
    const [senderReload, setSenderReload] = useState(0);

    const [focus, setFocus] = useState(0);
    const [stage, setStage] = useState<"edit" | "review" | "sending" | "result">("edit");
    const [targetTick, setTargetTick] = useState<number | null>(null);
    const [epochWarning, setEpochWarning] = useState("");
    const [progress, setProgress] = useState<{ tick: number; target: number } | null>(null);
    const [result, setResult] = useState<SubmittedTx | null>(null);
    const [sendError, setSendError] = useState("");

    // The wallet binds no list, so the shell's ↑↓/↵ list plumbing stays idle here.
    rowCount.current = 0;
    openRow.current = () => {};

    // The pool and the default sender are both needed before the fields mount: TextPrompt captures its
    // initial value once, so a seed arriving later would never reach the field.
    useEffect(() => {
        let alive = true;

        void (async () => {
            const [poolResult, seedResult] = await Promise.allSettled([rpc.fundedSeeds(FUNDED_POOL_LIMIT), resolveSeed(rpc)]);
            if (!alive) {
                return;
            }

            if (poolResult.status === "fulfilled") {
                const seeds = poolResult.value.seeds ?? [];
                const entries = await Promise.all(seeds.map(async (seed) => [(await deriveIdentity(seed)).identity, seed] as const));
                if (!alive) {
                    return;
                }
                setPool({
                    seedByIdentity: new Map(entries),
                    received: seeds.length,
                    total: poolResult.value.count ?? seeds.length,
                });
            } else {
                setPoolError(errText(poolResult.reason));
            }

            // Set before `ready` so the fields mount with the default already in place — TextPrompt captures
            // its initial value once.
            setFromInput(seedResult.status === "fulfilled" ? seedResult.value : "");
            setReady(true);
        })();

        return () => {
            alive = false;
        };
    }, []);

    useEffect(() => {
        const value = fromInput.trim();
        const kind = classifyWalletInput(value);

        if (kind === "empty" || kind === "partial") {
            setFrom({ status: "idle" });
            setBalance(null);
            return;
        }
        if (kind === "invalid") {
            setFrom({ status: "error", message: shapeHint(kind, value) });
            setBalance(null);
            return;
        }

        let alive = true;
        setFrom({ status: "checking" });

        void (async () => {
            try {
                const identity = kind === "seed" ? (await deriveIdentity(value)).identity : value;
                const seed = kind === "seed" ? value : poolSeedForIdentity(identity, pool, poolError);
                const entity = await rpc.balance(identity);
                if (!alive) {
                    return;
                }

                setFrom({ status: "ok", identity, seed });
                setBalance(BigInt(entity.incomingAmount) - BigInt(entity.outgoingAmount));
            } catch (error) {
                if (alive) {
                    setFrom({ status: "error", message: errText(error) });
                    setBalance(null);
                }
            }
        })();

        return () => {
            alive = false;
        };
    }, [fromInput, pool, poolError, senderReload]);

    useEffect(() => {
        const value = toInput.trim();
        const kind = classifyWalletInput(value);

        if (kind === "empty" || kind === "partial") {
            setTo({ status: "idle" });
            return;
        }
        if (kind === "invalid") {
            setTo({ status: "error", message: shapeHint(kind, value) });
            return;
        }

        let alive = true;
        setTo({ status: "checking" });

        void (async () => {
            try {
                const identity = kind === "seed" ? (await deriveIdentity(value)).identity : value;
                // The node does not check identities at all, so this checksum is the only thing between a typo
                // and a transfer into an address nobody holds.
                const destination = identityToBytes(identity);
                if (alive) {
                    setTo({ status: "ok", identity, destination });
                }
            } catch (error) {
                // The shape already passed, so the only way to land here is a bad checksum — and the library's
                // "expected 60 uppercase letters" would point at the wrong thing.
                if (alive) {
                    setTo({
                        status: "error",
                        message: kind === "identity" ? "checksum does not match — one character is mistyped" : errText(error),
                    });
                }
            }
        })();

        return () => {
            alive = false;
        };
    }, [toInput]);

    const amount = parseAmount(amountInput.trim(), balance);
    const complete = from.status === "ok" && to.status === "ok" && amount.status === "ok";

    // A target tick past the epoch's last would never execute. epoch-info is testnet-only, so its absence
    // just means no warning.
    useEffect(() => {
        if (stage !== "review") {
            return;
        }

        let alive = true;
        void (async () => {
            try {
                const [tickInfo, epoch] = await Promise.all([rpc.tickInfo(), rpc.epochInfo()]);
                if (!alive) {
                    return;
                }

                const target = (tickInfo.tick ?? 0) + TX_TICK_OFFSET;
                setTargetTick(target);
                setEpochWarning(
                    epoch.epochLastTick && target > epoch.epochLastTick
                        ? `target tick ${target} is past the epoch's last tick ${epoch.epochLastTick} — it would never execute`
                        : "",
                );
            } catch {
                // no epoch-info on this node; the review simply shows no tick estimate
            }
        })();

        return () => {
            alive = false;
        };
    }, [stage]);

    const send = async () => {
        setStage("sending");
        setProgress(null);
        setSendError("");

        try {
            const tickInfo = await rpc.tickInfo();
            const tick = (tickInfo.tick ?? 0) + TX_TICK_OFFSET;
            setTargetTick(tick);

            const submitted = await sendTransfer({
                seed: from.seed as string,
                destination: to.destination as Uint8Array,
                amount: amount.qu as number,
                tick,
                rpcBaseUrl,
                confirm: true,
                rpc,
                onProgress: setProgress,
            });
            setResult(submitted);
        } catch (error) {
            setSendError(errText(error));
        }

        setStage("result");
    };

    const startOver = () => {
        setAmountInput("");
        setResult(null);
        setSendError("");
        setProgress(null);
        setFocus(0);
        setSenderReload((count) => count + 1);
        setStage("edit");
    };

    // ↵ walks the fields and, from the last one, opens the review — or drops focus on whatever still needs
    // fixing, which is more useful than refusing silently.
    const advance = (index: number) => {
        if (index < FIELD_COUNT - 1) {
            setFocus(index + 1);
            return;
        }
        if (complete) {
            setStage("review");
            return;
        }

        if (from.status !== "ok") {
            setFocus(0);
        } else if (to.status !== "ok") {
            setFocus(1);
        } else {
            setFocus(2);
        }
    };

    useInput((input, key) => {
        if (stage === "sending") {
            return;
        }

        if (stage === "result") {
            if (key.return && result?.txId) {
                push({ kind: "tx", hash: result.txId });
            } else if (input === "n") {
                startOver();
            } else if (key.escape) {
                onExit();
            }
            return;
        }

        if (stage === "review") {
            if (key.return) {
                void send();
            } else if (key.escape) {
                setStage("edit");
            }
            return;
        }

        // While editing, the focused TextPrompt owns every printable key and ↵; only these are ours.
        if (key.escape) {
            onExit();
        } else if (key.upArrow) {
            setFocus((current) => Math.max(0, current - 1));
        } else if (key.downArrow) {
            setFocus((current) => Math.min(FIELD_COUNT - 1, current + 1));
        }
    });

    if (!ready) {
        return (
            <Box marginTop={1}>
                <Text color={theme.brand}>
                    <Spinner label="reading the funded-seed pool" />
                </Text>
            </Box>
        );
    }

    const balanceHint = balance != null ? `${fmtAmount(balance.toString())} qu` : undefined;
    const remaining = balance != null && amount.status === "ok" ? balance - BigInt(amount.qu as number) : null;
    const editing = stage === "edit";

    if (stage === "sending" || stage === "result") {
        return (
            <Box flexDirection="column" marginTop={1}>
                <SectionHeader title="wallet" detail="transfer" width={columns} />
                <SectionBody>
                    <KV
                        rows={[
                            ["from", from.identity ?? "—"],
                            ["to", to.identity ?? "—"],
                            ["amount", `${fmtAmount(String(amount.qu ?? 0))} qu`],
                            ["tick", targetTick != null ? String(targetTick) : "—"],
                        ]}
                    />
                    {stage === "sending" ? (
                        <Box marginTop={1}>
                            <Text color={theme.brand}>
                                <Spinner label={progress ? `settling — tick ${progress.tick} of ${progress.target}` : "broadcasting"} />
                            </Text>
                        </Box>
                    ) : (
                        <ResultBlock result={result} error={sendError} />
                    )}
                </SectionBody>
            </Box>
        );
    }

    return (
        <Box flexDirection="column" marginTop={1}>
            <SectionHeader
                title="wallet"
                detail="seed or identity · amounts in whole qu"
                error={poolError ? "funded-seed pool unavailable — identities cannot be resolved to seeds" : ""}
                width={columns}
            />
            <SectionBody>
                <TextPrompt
                    label="from — seed signs directly, identity is looked up in the funded pool"
                    // Seeded from state, not a fixed default: the prompts unmount while a transfer is in flight,
                    // so `n` remounts them and a fixed initial value would show one sender while another signs.
                    initial={fromInput}
                    isActive={editing && focus === 0}
                    onChange={setFromInput}
                    onSubmit={() => advance(0)}
                    hint={
                        <HintLine
                            state={from}
                            columns={columns}
                            extra={from.status === "ok" ? balanceHint : shapeHint(classifyWalletInput(fromInput.trim()), fromInput.trim())}
                        />
                    }
                />
                <TextPrompt
                    label="to — seed or identity"
                    initial={toInput}
                    isActive={editing && focus === 1}
                    onChange={setToInput}
                    onSubmit={() => advance(1)}
                    hint={<HintLine state={to} columns={columns} extra={shapeHint(classifyWalletInput(toInput.trim()), toInput.trim())} />}
                />
                <TextPrompt
                    label="amount — whole qu, or `max`"
                    isActive={editing && focus === 2}
                    onChange={setAmountInput}
                    onSubmit={() => advance(2)}
                    hint={<AmountHint amount={amount} remaining={remaining} />}
                />

                {editing ? (
                    <Text>
                        <Text bold color={theme.brand}>
                            ↑↓
                        </Text>
                        <Text>{" field"}</Text>
                        <Text dimColor>{"  ·  "}</Text>
                        <Text bold color={theme.brand}>
                            ↵
                        </Text>
                        <Text>{complete ? " review" : " next"}</Text>
                    </Text>
                ) : null}

                {stage === "review" ? (
                    <Box flexDirection="column" marginTop={1}>
                        <Text>
                            <Text color={theme.warn} bold>
                                review
                            </Text>
                            <Text dimColor>{"  ·  this moves real balance on the node"}</Text>
                        </Text>
                        <KV
                            rows={[
                                ["from", from.identity ?? "—"],
                                ["to", to.identity ?? "—"],
                                ["amount", `${fmtAmount(String(amount.qu ?? 0))} qu`],
                                ["leaves", remaining != null ? `${fmtAmount(remaining.toString())} qu` : "—"],
                                ["tick", targetTick != null ? String(targetTick) : "next tick + 3"],
                            ]}
                        />
                        {epochWarning ? <Text color={theme.warn}>{epochWarning}</Text> : null}
                        <Text>
                            <Text bold color={theme.brand}>
                                ↵
                            </Text>
                            <Text>{" send"}</Text>
                            <Text dimColor>{"  ·  "}</Text>
                            <Text bold color={theme.brand}>
                                esc
                            </Text>
                            <Text>{" edit"}</Text>
                        </Text>
                    </Box>
                ) : null}
            </SectionBody>
        </Box>
    );
}

function AmountHint({ amount, remaining }: { amount: AmountState; remaining: bigint | null }) {
    if (amount.status === "error") {
        return <Text color={theme.err}>{amount.message}</Text>;
    }
    if (amount.status !== "ok") {
        return <Text dimColor> </Text>;
    }

    return (
        <Text>
            <Text color={theme.ok}>{`${fmtAmount(String(amount.qu))} qu`}</Text>
            {remaining != null ? <Text dimColor>{`  ·  leaves ${fmtAmount(remaining.toString())}`}</Text> : null}
        </Text>
    );
}

// Broadcast is not confirmation on this chain, so the wording keeps the two apart.
function ResultBlock({ result, error }: { result: SubmittedTx | null; error: string }) {
    if (error) {
        return (
            <Box flexDirection="column" marginTop={1}>
                <Status ok={false} label="send failed" detail={error} />
                <Text dimColor> esc back</Text>
            </Box>
        );
    }
    if (!result) {
        return null;
    }

    const detail = !result.ok
        ? `FAIL${result.code != null ? ` code=${result.code}` : ""}`
        : result.confirmed && result.included
          ? "processed"
          : result.confirmed && !result.included
            ? "dropped — not included in the tick"
            : "broadcast · unconfirmed";
    const ok = result.ok && !(result.confirmed && !result.included);

    return (
        <Box flexDirection="column" marginTop={1}>
            <Status ok={ok} label={detail} />
            {result.moneyFlew != null ? <Text dimColor>{`money moved: ${result.moneyFlew ? "yes" : "no"}`}</Text> : null}
            <Text dimColor>{result.txId ?? "—"}</Text>
            <Text>
                {result.txId ? (
                    <Text>
                        <Text bold color={theme.brand}>
                            ↵
                        </Text>
                        <Text>{" open tx"}</Text>
                        <Text dimColor>{"  ·  "}</Text>
                    </Text>
                ) : null}
                <Text bold color={theme.brand}>
                    n
                </Text>
                <Text>{" new transfer"}</Text>
                <Text dimColor>{"  ·  "}</Text>
                <Text bold color={theme.brand}>
                    esc
                </Text>
                <Text>{" back"}</Text>
            </Text>
        </Box>
    );
}
