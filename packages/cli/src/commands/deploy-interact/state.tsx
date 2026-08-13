import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { DEFAULT_RPC_BASE, LiteRpc, type DynamicContractRegistryEntry } from "@qinit/core";
import {
    LARGE_STATE_CONTAINER_BYTES,
    loadStateContainer,
    readState,
    stateIsComplete,
    type DecodedState,
    type StateContainer,
} from "../../trace/format";
import { StateView } from "../../trace/views";
import { loadConfig, loadConfiguredQpiHeader } from "../../config";
import { loadContracts, mergeContracts } from "../../contracts/registry";
import { Header, Spinner, GradLine, Panel, KV, fmtCompact, theme } from "../../ui";
import { invalidArgs, output, type CommandArguments } from "../../args";
import { readStateDigest, type StateDigestResult } from "../../contracts/state-digest";
import { dumpContractState, type StateDumpResult } from "../../contracts/state-dump";

type DigestOutput = StateDigestResult | { ok: false; error: string };
type DumpOutput = StateDumpResult | { ok: false; error: string };
type Phase = "loading" | "pick" | "show" | "browse" | "done";

const CONTAINER_INPUT_DELAY_MS = 500;

function parseContainerIndexes(values: readonly string[]): Set<number> {
    const indexes = new Set<number>();
    for (const value of values) {
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
            invalidArgs(`--container must be a positive safe integer (got '${value}')`);
        }
        indexes.add(Number(value));
    }
    return indexes;
}

export function State({ commandArgs }: { commandArgs: CommandArguments }) {
    const containerIndexes = parseContainerIndexes(commandArgs.getAll("container"));
    const o = {
        target: commandArgs.positionals[0] ?? "",
        rpc: commandArgs.get("rpc"),
        digest: commandArgs.has("digest"),
        dump: commandArgs.has("dump"),
        out: commandArgs.get("out"),
        all: commandArgs.has("all"),
    };
    if (o.out && !o.dump) {
        invalidArgs("--out only applies with --dump");
    }
    if (o.all && containerIndexes.size) {
        invalidArgs("--all cannot be combined with --container");
    }
    if ((o.all || containerIndexes.size) && (o.digest || o.dump)) {
        invalidArgs("--all and --container only apply to decoded state output");
    }
    const explicitContainerSelection = o.all || containerIndexes.size > 0;
    const rpcBaseUrl = o.rpc || loadConfig().rpc || DEFAULT_RPC_BASE;
    const { exit } = useApp();
    const [lines, setLines] = useState<string[]>([]);
    const [decodedState, setDecodedState] = useState<DecodedState | null>(null);
    const [name, setName] = useState("");
    const [contracts, setContracts] = useState<DynamicContractRegistryEntry[]>([]);
    const [userCount, setUserCount] = useState(0); // contracts[0..userCount) deployed, rest system
    const [i, setI] = useState(0);
    const [phase, setPhase] = useState<Phase>("loading");
    const [digest, setDigest] = useState<DigestOutput | null>(null);
    const [dump, setDump] = useState<DumpOutput | null>(null);
    const [progress, setProgress] = useState("");
    const [containerInput, setContainerInput] = useState("");
    const [containerHint, setContainerHint] = useState("");
    const [hiddenContainerIndexes, setHiddenContainerIndexes] = useState<Set<number>>(new Set());
    const decodedStateRef = useRef<DecodedState | null>(null);
    const containerInputRef = useRef("");
    const containerInputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const loadInFlightRef = useRef<number | null>(null);
    const contractIndexRef = useRef<number | null>(null);
    const exitingRef = useRef(false);
    const add = (s: string) => setLines((l) => [...l, s]);

    const setCurrentState = (state: DecodedState) => {
        decodedStateRef.current = state;
        setDecodedState(state);
    };

    const replaceContainer = (
        container: StateContainer,
        recomputeComplete = false,
    ): DecodedState | null => {
        const current = decodedStateRef.current;
        if (!current) {
            return null;
        }
        const containers = current.containers.map((candidate) =>
            candidate.index === container.index ? container : candidate,
        );
        const next = {
            ...current,
            containers,
            complete: recomputeComplete
                ? stateIsComplete({ fields: current.fields, containers })
                : current.complete,
        };
        setCurrentState(next);
        return next;
    };

    // What the user would have typed to skip the picker, echoed the way `qinit call` echoes its own.
    const equivCmd = (c: DynamicContractRegistryEntry) => {
        const parts = ["qinit state", c.name || String(c.index)];
        if (o.dump) {
            parts.push("--dump");
        }
        if (o.out) {
            parts.push(`--out ${o.out}`);
        }
        for (const index of containerIndexes) {
            parts.push(`--container ${index}`);
        }
        if (o.all) {
            parts.push("--all");
        }
        if (o.rpc) {
            parts.push(`--rpc ${o.rpc}`);
        }
        return parts.join(" ");
    };

    // Exact bytes, because that is what `--digest` reports, plus a compact hint once it stops being readable.
    const dumpSize = (size: number) => {
        const compact = fmtCompact(String(size));
        return compact === String(size) ? `${size} bytes` : `${size} bytes (${compact}B)`;
    };

    const runDump = async (slot: number, label: string) => {
        setDump(
            await dumpContractState(new LiteRpc(rpcBaseUrl), slot, label, {
                out: o.out,
                onProgress: (writtenBytes, totalBytes) => {
                    const percent = totalBytes
                        ? Math.floor((writtenBytes * 100) / totalBytes)
                        : 100;
                    setProgress(`dumping ${label} · ${percent}%`);
                },
            }),
        );
    };

    const load = async (c: DynamicContractRegistryEntry) => {
        setPhase("loading");
        setProgress("");
        contractIndexRef.current = c.index;
        try {
            const label = c.name || String(c.index);
            setName(label);
            if (o.dump) {
                await runDump(c.index, label);
                return;
            }
            if (!c.source)
                throw new Error(`node has no source for slot ${c.index} — cannot decode state`);
            const rpc = new LiteRpc(rpcBaseUrl);
            await rpc.tickInfo(); // fail fast + loud if the node is unreachable (else readState silently fills "(read failed)")
            const state = await readState(
                rpc,
                c.index,
                c.source,
                c.name || "Contract",
                loadConfiguredQpiHeader(),
                (field, completedBytes, totalBytes) => {
                    const percent = totalBytes
                        ? Math.floor((completedBytes * 100) / totalBytes)
                        : 100;
                    setProgress(`reading ${field} · ${percent}%`);
                },
                {
                    collapseContainersAtBytes: LARGE_STATE_CONTAINER_BYTES,
                    containerIndexes,
                    loadAllContainers: o.all,
                },
            );
            setCurrentState(state);
            setProgress("");
            process.exitCode = state.complete ? 0 : 1;
            const browse =
                !explicitContainerSelection &&
                !output.json &&
                Boolean(process.stdin.isTTY) &&
                Boolean(process.stdout.isTTY) &&
                state.containers.some((container) => container.status === "collapsed");
            setPhase(browse ? "browse" : "show");
        } catch (e: any) {
            const message = String(e?.message ?? e);
            if (o.dump) {
                setDump({ ok: false, error: message });
                return;
            }
            add("ERROR: " + message);
            setPhase("done");
        }
    };

    const activateContainer = async (rawIndex: string) => {
        const index = Number(rawIndex);
        const state = decodedStateRef.current;
        const container = state?.containers.find((candidate) => candidate.index === index);
        if (!Number.isSafeInteger(index) || index < 1 || !container) {
            setContainerHint(`no state container ${rawIndex}`);
            return;
        }

        if (container.status === "loaded") {
            setHiddenContainerIndexes((current) => {
                const next = new Set(current);
                if (next.has(index)) {
                    next.delete(index);
                } else {
                    next.add(index);
                }
                return next;
            });
            setContainerHint(`container ${index} toggled from cache`);
            return;
        }

        if (container.status === "loading") {
            setContainerHint(`loading container ${index}`);
            return;
        }
        if (loadInFlightRef.current !== null) {
            setContainerHint(`loading container ${loadInFlightRef.current}`);
            return;
        }

        const contractIndex = contractIndexRef.current;
        if (contractIndex === null) {
            setContainerHint("contract state is not ready");
            return;
        }

        loadInFlightRef.current = index;
        setHiddenContainerIndexes((current) => {
            const next = new Set(current);
            next.delete(index);
            return next;
        });
        replaceContainer({ ...container, status: "loading", error: undefined });
        setContainerHint(`loading container ${index}`);
        setProgress("");

        let loaded: StateContainer;
        try {
            const rpc = new LiteRpc(rpcBaseUrl);
            loaded = await loadStateContainer(
                {
                    stateRead: async (slot, offset, length) => {
                        if (exitingRef.current) {
                            throw new Error("state view closed");
                        }
                        const result = await rpc.stateRead(slot, offset, length);
                        if (exitingRef.current) {
                            throw new Error("state view closed");
                        }
                        return result;
                    },
                },
                contractIndex,
                container,
                (field, completedBytes, totalBytes) => {
                    const percent = totalBytes
                        ? Math.floor((completedBytes * 100) / totalBytes)
                        : 100;
                    setProgress(`reading ${field} · ${percent}%`);
                },
            );
        } catch (error: any) {
            if (exitingRef.current) {
                return;
            }
            loaded = {
                ...container,
                status: "error",
                occupiedSlots: 0,
                totalEntries: 0,
                lines: [],
                error: String(error?.message ?? error),
            };
        } finally {
            loadInFlightRef.current = null;
        }

        const next = replaceContainer(loaded, true);
        if (next) {
            process.exitCode = next.complete ? 0 : 1;
        }
        setProgress("");
        setContainerHint(
            loaded.status === "loaded"
                ? `container ${index} loaded`
                : `container ${index} failed · press ${index} to retry`,
        );
    };

    const clearContainerInputTimer = () => {
        if (containerInputTimerRef.current) {
            clearTimeout(containerInputTimerRef.current);
            containerInputTimerRef.current = null;
        }
    };

    const commitContainerInput = () => {
        const value = containerInputRef.current;
        clearContainerInputTimer();
        containerInputRef.current = "";
        setContainerInput("");
        if (value) {
            void activateContainer(value);
        }
    };

    const updateContainerInput = (value: string) => {
        clearContainerInputTimer();
        containerInputRef.current = value;
        setContainerInput(value);
        setContainerHint("");
        if (value) {
            containerInputTimerRef.current = setTimeout(
                commitContainerInput,
                CONTAINER_INPUT_DELAY_MS,
            );
        }
    };

    const close = () => {
        exitingRef.current = true;
        clearContainerInputTimer();
        exit();
    };

    useEffect(() => {
        (async () => {
            try {
                const rpc = new LiteRpc(rpcBaseUrl);
                if (o.digest) {
                    setDigest(await readStateDigest(o.target, rpc));
                    return;
                }
                const { all, userCount: deployed } = mergeContracts(await loadContracts(rpc));
                if (o.target) {
                    const c = all.find(
                        (x) =>
                            String(x.index) === o.target ||
                            (x.name || "").toLowerCase() === o.target.toLowerCase(),
                    );
                    if (!c) {
                        // A dump needs neither IDL nor source, so a slot the registry does not list is still one
                        // the node can hand over byte for byte.
                        if (o.dump && /^\d+$/.test(o.target.trim())) {
                            await runDump(Number(o.target.trim()), o.target.trim());
                            return;
                        }
                        throw new Error(
                            `no contract '${o.target}' (deployed or system — run \`qinit node run\` for system)`,
                        );
                    }
                    await load(c);
                    return;
                }
                if (!all.length)
                    throw new Error(
                        "no contracts — deploy one, or run `qinit node run` to load system contracts",
                    );
                // `--json` renders nothing, so the picker would be an invisible prompt.
                if (!process.stdin.isTTY || output.json)
                    throw new Error(
                        `specify a contract: qinit state <name|slot> (${all.map((c) => c.name || c.index).join(", ")})`,
                    );
                setContracts(all);
                setUserCount(deployed);
                setPhase("pick");
            } catch (e: any) {
                if (o.dump) {
                    setDump({ ok: false, error: String(e?.message ?? e) });
                    return;
                }
                if (o.digest) {
                    setDigest({ ok: false, error: String(e?.message ?? e) });
                    return;
                }
                add("ERROR: " + String(e?.message ?? e));
                setPhase("done");
            }
        })();
    }, []);
    useEffect(() => {
        if (dump) {
            if (output.json) process.stdout.write(JSON.stringify(dump) + "\n");
            process.exitCode = dump.ok ? 0 : 1;
            const t = setTimeout(() => exit(), 50);
            return () => clearTimeout(t);
        }
        if (digest) {
            if (output.json) process.stdout.write(JSON.stringify(digest) + "\n");
            process.exitCode = digest.ok ? 0 : 1;
            const t = setTimeout(() => exit(), 50);
            return () => clearTimeout(t);
        }
        if (!o.digest && !o.dump && (phase === "show" || phase === "done")) {
            if (lines.some((l) => l.startsWith("ERROR")) || decodedState?.complete === false) {
                process.exitCode = 1;
            }
            const t = setTimeout(() => exit(), 50);
            return () => clearTimeout(t);
        }
    }, [phase, digest, dump, decodedState]);
    useEffect(() => {
        exitingRef.current = false;
        return () => {
            exitingRef.current = true;
            clearContainerInputTimer();
        };
    }, []);

    useInput(
        (input, key) => {
            if (phase === "pick") {
                if (input === "q" || key.escape) {
                    close();
                } else if (key.upArrow) {
                    setI((p) => (p - 1 + contracts.length) % contracts.length);
                } else if (key.downArrow) {
                    setI((p) => (p + 1) % contracts.length);
                } else if (key.return) {
                    add("≡ " + equivCmd(contracts[i]));
                    load(contracts[i]);
                }
                return;
            }

            if (phase !== "browse") {
                return;
            }
            if (input === "q") {
                close();
            } else if (key.escape) {
                if (containerInputRef.current) {
                    updateContainerInput("");
                } else {
                    close();
                }
            } else if (key.return) {
                commitContainerInput();
            } else if (key.backspace || key.delete) {
                updateContainerInput(containerInputRef.current.slice(0, -1));
            } else if (/^\d+$/.test(input) && !key.ctrl && !key.meta) {
                updateContainerInput(containerInputRef.current + input);
            }
        },
        { isActive: Boolean(process.stdin.isTTY) },
    );

    if ((o.digest || o.dump) && output.json) return null;
    if (o.dump && phase !== "pick") {
        return (
            <Box flexDirection="column">
                <Header cmd="state" />
                {lines.map((l, k) => (
                    <Text key={k}>{l}</Text>
                ))}
                {!dump ? (
                    <Spinner label={progress || "dumping state"} />
                ) : dump.ok ? (
                    <Panel title="state dump ✓" color={theme.ok}>
                        <KV
                            full
                            rows={[
                                ["slot", String(dump.slot)],
                                ["contract", dump.name],
                                ["size", dumpSize(dump.size)],
                                ["path", dump.path],
                            ]}
                        />
                    </Panel>
                ) : (
                    <Panel title="state dump failed" color={theme.err}>
                        <Text>{dump.error}</Text>
                    </Panel>
                )}
            </Box>
        );
    }
    if (o.digest) {
        return (
            <Box flexDirection="column">
                <Header cmd="state" />
                {!digest ? (
                    <Spinner label="reading state digest" />
                ) : digest.ok ? (
                    <Panel title="state digest ✓" color={theme.ok}>
                        <KV
                            rows={[
                                ["slot", String(digest.slot)],
                                ["state size", String(digest.stateSize)],
                                ["digest", digest.digest],
                            ]}
                        />
                    </Panel>
                ) : (
                    <Panel title="state digest failed" color={theme.err}>
                        <Text>{digest.error}</Text>
                    </Panel>
                )}
            </Box>
        );
    }

    return (
        <Box flexDirection="column">
            <Header cmd="state" />
            {lines.map((l, k) => (
                <Text key={k} color={l.startsWith("ERROR") ? theme.err : undefined}>
                    {l}
                </Text>
            ))}
            {phase === "pick" && (
                <Box flexDirection="column">
                    <Text dimColor>↑/↓ select · ↵ show state · q quit</Text>
                    <Box
                        borderStyle="round"
                        borderColor={theme.brand}
                        paddingX={1}
                        flexDirection="column"
                    >
                        {(() => {
                            const row = (c: DynamicContractRegistryEntry, idx: number) => {
                                const sel = idx === i;
                                const detail = `idx ${c.index} · ${c.functions?.length ?? 0}fn/${c.procedures?.length ?? 0}proc`;
                                return sel ? (
                                    <GradLine
                                        key={c.index}
                                        text={`▸ ${(c.name || "—").padEnd(16)} ${detail}`}
                                    />
                                ) : (
                                    <Text key={c.index}>
                                        {"  "}
                                        <Text color={theme.brand}>
                                            {(c.name || "—").padEnd(16)}
                                        </Text>{" "}
                                        <Text dimColor>{detail}</Text>
                                    </Text>
                                );
                            };
                            const out: React.ReactNode[] = [];
                            if (userCount > 0) {
                                out.push(
                                    <Text key="hu" color={theme.mute} bold>
                                        {" "}
                                        deployed
                                    </Text>,
                                );
                                contracts
                                    .slice(0, userCount)
                                    .forEach((c, k) => out.push(row(c, k)));
                            }
                            if (contracts.length > userCount) {
                                out.push(
                                    <Text key="hs" color={theme.mute} bold>
                                        {" "}
                                        system
                                    </Text>,
                                );
                                contracts
                                    .slice(userCount)
                                    .forEach((c, k) => out.push(row(c, userCount + k)));
                            }
                            return out;
                        })()}
                    </Box>
                </Box>
            )}
            {phase === "loading" && <Spinner label={progress || "reading state"} />}
            {phase === "browse" ? (
                <Box flexDirection="column">
                    <Text dimColor>
                        type container # · wait 0.5s or ↵ · loaded toggles · Esc/q quit
                    </Text>
                    {containerInput || progress || containerHint ? (
                        <Text color={progress ? theme.info : undefined}>
                            {containerInput
                                ? `container ${containerInput}…`
                                : progress || containerHint}
                        </Text>
                    ) : null}
                </Box>
            ) : decodedState?.containers.some((container) => container.status === "collapsed") ? (
                <Text dimColor>
                    rerun with --container &lt;index&gt; (repeatable) or --all to load large
                    containers
                </Text>
            ) : null}
            {decodedState ? (
                <StateView
                    name={name}
                    state={decodedState}
                    hiddenContainerIndexes={hiddenContainerIndexes}
                    interactive={phase === "browse"}
                />
            ) : null}
        </Box>
    );
}
