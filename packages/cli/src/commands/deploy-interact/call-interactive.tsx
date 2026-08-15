import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { LiteRpc, type DynamicContractRegistryEntry } from "@qinit/core";
import { callFunction, invokeProcedure, encodeInput, hasOverlappingAbiType, zeroInputFormat, TX_TICK_OFFSET } from "@qinit/proto";
import { AbiTypeKind, type AbiField, type AbiType, type ContractEntry, type ContractIdl, type ContractIdlFile } from "@qinit/proto/contract-idl";
import { extractIdl } from "@qinit/build";
import { loadConfiguredQpiHeader, resolveSeed } from "../../config";
import { loadContracts, mergeContracts } from "../../contracts/registry";
import { contractIdlForSlot, emptyContractIdlFile, loadContractIdlFile } from "../../contracts/idl-file";
import { fmtVal, formatStateValue } from "../../trace/state-format";
import { Header, Spinner, Panel, theme } from "../../ui";
import { Select, TextPrompt } from "../../ui/prompt";

export function formatContractPickerRows(
    rows: readonly {
        name: string;
        index: number;
        functionCount: number;
        procedureCount: number;
    }[],
): string[] {
    const nameWidth = Math.max(0, ...rows.map((row) => row.name.length));
    const indexWidth = Math.max(0, ...rows.map((row) => String(row.index).length));
    const functionWidth = Math.max(0, ...rows.map((row) => String(row.functionCount).length));
    const procedureWidth = Math.max(0, ...rows.map((row) => String(row.procedureCount).length));

    return rows.map(
        (row) =>
            `${row.name.padEnd(nameWidth)}  [idx ${String(row.index).padStart(indexWidth)}]  ` +
            `${String(row.functionCount).padStart(functionWidth)} fn / ` +
            `${String(row.procedureCount).padStart(procedureWidth)} proc`,
    );
}

const QPI_TYPES = ["uint64", "uint32", "uint16", "uint8", "sint64", "sint32", "sint16", "sint8", "id", "bit", "m256i"];

export function completerFor(fields?: AbiField[], completeBareValue = false) {
    return (value: string, idle = false): string | null => {
        const separator = value.lastIndexOf(",");
        const completed = value.slice(0, separator + 1);
        const current = value.slice(separator + 1);
        const fieldIndex = (completed.match(/,/g) || []).length;
        const expectedType = fields?.[fieldIndex]?.type.format;
        const fragment = current.match(/[a-z][a-z0-9]*$/);
        if (fragment) {
            const candidates = expectedType && QPI_TYPES.includes(expectedType) ? [expectedType, ...QPI_TYPES] : QPI_TYPES;
            const match = candidates.find((type) => type.startsWith(fragment[0]) && type !== fragment[0]);

            return match ? completed + current.slice(0, current.length - fragment[0].length) + match : null;
        }

        if (!idle || !completeBareValue || !expectedType || !QPI_TYPES.includes(expectedType)) {
            return null;
        }

        const integer = current.match(/^(\s*)(-?\d+)$/);
        if (!integer) {
            return null;
        }
        const number = integer[2];
        if (
            (expectedType.startsWith("uint") && number.startsWith("-")) ||
            (expectedType === "bit" && number !== "0" && number !== "1") ||
            ((expectedType === "id" || expectedType === "m256i") && number !== "0")
        ) {
            return null;
        }

        return completed + integer[1] + number + expectedType;
    };
}

export const tmplOf = (fields?: AbiField[]) => (fields && fields.length ? fields.map((field) => `<${field.name}>${field.type.format}`).join(", ") : undefined);

function SchemaBox({ kind, name, type }: { kind: "input" | "output"; name?: string; type?: AbiType }) {
    if (type === undefined) {
        return null;
    }

    const fields = type.kind === AbiTypeKind.STRUCT ? type.fields : undefined;
    return (
        <Panel title={`${kind}${name ? "  ·  " + name : ""}`} color={kind === "input" ? theme.info : theme.accent}>
            {fields === undefined ? (
                <Text color={theme.info}>{type.format}</Text>
            ) : fields.length === 0 ? (
                <Text dimColor>(no fields)</Text>
            ) : (
                fields.map((field, index) => (
                    <Text key={index}>
                        <Text color={theme.info}>{field.type.format.padEnd(10)}</Text> <Text bold>{field.name}</Text>
                    </Text>
                ))
            )}
        </Panel>
    );
}

type Entry = {
    kind: "fn" | "proc";
    inputType: number;
    inputSize: number;
    outputSize: number;
    name?: string;
    input?: ContractEntry["input"];
    output?: ContractEntry["output"];
    notification?: boolean;
};

export function zeroSample(entry: Entry): string | null {
    try {
        if (!entry.input || (entry.input.kind === AbiTypeKind.STRUCT && entry.input.fields.length === 0)) {
            return null;
        }

        return zeroInputFormat(entry.input);
    } catch {
        return null;
    }
}

type Stage = "loading" | "contract" | "entry" | "input" | "output" | "amount" | "running" | "done";

export function CallInteractive({ rpcBaseUrl, seed }: { rpcBaseUrl: string; seed?: string }) {
    const { exit } = useApp();

    const [qpiHeader] = useState(() => {
        try {
            return loadConfiguredQpiHeader();
        } catch {
            return undefined;
        }
    });
    const [stage, setStage] = useState<Stage>("loading");
    const [contracts, setContracts] = useState<DynamicContractRegistryEntry[]>([]);
    const [userCount, setUserCount] = useState(0);
    const [idlFile, setIdlFile] = useState<ContractIdlFile>(emptyContractIdlFile());
    const [selection, setSelection] = useState<{
        c?: DynamicContractRegistryEntry;
        e?: Entry;
        input?: string;
        out?: string;
        amount?: string;
        seed?: string;
    }>({});
    const [results, setResults] = useState<string[]>([]);
    const [status, setStatus] = useState("");
    const addResult = (result: string) => {
        setResults((current) => [...current, result]);
    };

    useEffect(() => {
        (async () => {
            try {
                setIdlFile(loadContractIdlFile());
                const { all: combined, userCount: deployed } = mergeContracts(await loadContracts(new LiteRpc(rpcBaseUrl)));

                if (!combined.length) {
                    addResult("no contracts — deploy one, or run `qinit node run` to load system contracts");
                    setStage("done");
                    return;
                }

                setContracts(combined);
                setUserCount(deployed);
                setStage("contract");
            } catch (error: any) {
                addResult("ERROR: " + String(error?.message ?? error));
                setStage("done");
            }
        })();
    }, []);

    useEffect(() => {
        if (stage === "done") {
            const timer = setTimeout(() => exit(), 50);
            return () => clearTimeout(timer);
        }
    }, [stage]);

    const back = () => {
        setStatus("");
        if (stage === "entry") {
            setStage("contract");
        } else if (stage === "input") {
            setStage("entry");
        } else if (stage === "output" || stage === "amount") {
            setStage(selection.e && !noInput(selection.e) ? "input" : "entry");
        } else if (stage === "contract") {
            exit();
        }
    };

    useInput((_i, key) => {
        if (key.escape) {
            back();
        }
    });

    const runCall = async (selected: typeof selection) => {
        setStage("running");

        try {
            try {
                await encodeInput(selected.input ?? "");
            } catch (error: any) {
                addResult("✗ bad input: " + String(error?.message ?? error));
                const sample = zeroSample(selected.e!);
                if (sample) {
                    addResult("all-zero sample: " + sample);
                }
                setStage("done");
                return;
            }

            const rpc = new LiteRpc(rpcBaseUrl);
            const contract = selected.c!;
            const entry = selected.e!;
            const contractIndex = contract.index;
            addResult("≡ " + equivCmd(contract, entry, selected));

            if (entry.kind === "fn") {
                const output = await callFunction(rpc, contractIndex, entry.inputType, selected.input ?? "", entry.output ?? selected.out ?? "");
                // The IDL type wins over a typed-in format above, and it is the one that names the fields.
                const shown = entry.output ? formatStateValue(output, entry.output, false, true) : fmtVal(output);
                addResult(`${labelFor(contract, entry)} -> ${shown}`);
            } else {
                const tickInfo = await rpc.tickInfo();
                const tick = tickInfo.tick + TX_TICK_OFFSET;
                const procedure = await invokeProcedure({
                    seed: await resolveSeed(rpc, selected.seed || seed),
                    rpcBaseUrl: rpcBaseUrl,
                    contractIndex,
                    procedureId: entry.inputType,
                    amount: Number(selected.amount ?? 0),
                    inputFormat: selected.input ?? "",
                    tick,
                    confirm: true,
                    rpc,
                    onProgress: ({ tick: net, target }) =>
                        setStatus(`confirming · tick ${net} → ${target}${net < target ? ` (${target - net} to go)` : " · processing"}`),
                });
                setStatus("");

                const verdict = !procedure.ok
                    ? `FAIL ${procedure.message ?? procedure.code ?? ""}`
                    : procedure.confirmed && procedure.included
                      ? "processed ✓"
                      : procedure.confirmed && !procedure.included
                        ? "DROPPED — not included"
                        : "broadcast (unconfirmed — no tx-status addon or timed out)";
                let contractError = "";

                try {
                    const deployed = (await rpc.dynRegistry()).contracts?.find((candidate) => candidate.index === contractIndex);
                    if (deployed?.lastError) {
                        contractError = ` · contract error: ${deployed.lastError}`;
                    }
                } catch {
                    // The procedure verdict remains useful if the registry is unavailable.
                }

                addResult(`${labelFor(contract, entry)} @tick ${tick}: ${verdict}  ${procedure.txId ?? ""}${contractError}`);
            }
        } catch (error: any) {
            addResult("ERROR: " + String(error?.message ?? error));
        }

        setStage("done");
    };

    const noInput = (entry: Entry) => entry.input?.kind === AbiTypeKind.STRUCT && entry.input.fields.length === 0;

    const startEntry = (entry: Entry) => {
        const next = { ...selection, e: entry, input: "" };
        setSelection(next);

        if (!noInput(entry)) {
            setStage("input");
            return;
        }

        if (entry.kind === "fn") {
            if (entry.output !== undefined) {
                runCall(next);
            } else {
                setStage("output");
            }
        } else {
            setStage("amount");
        }
    };

    const afterInput = (next: typeof selection) => {
        if (next.e!.kind === "fn") {
            if (next.e!.output !== undefined) {
                runCall(next);
            } else {
                setStage("output");
            }
        } else {
            setStage("amount");
        }
    };

    const labelFor = (contract: DynamicContractRegistryEntry, entry: Entry) => `${nameOf(contract)}.${entry.name ?? entry.kind + "#" + entry.inputType}`;

    const equivCmd = (contract: DynamicContractRegistryEntry, entry: Entry, selected: typeof selection) => {
        const entryName = entry.name ?? entry.inputType;
        const parts = ["qinit call", entry.kind === "fn" ? "--fn" : "--proc", String(nameOf(contract)), String(entryName)];

        if ((selected.input ?? "").trim()) {
            parts.push(`--in "${selected.input!.trim()}"`);
        }

        const outputFormat = entry.output?.format ?? selected.out ?? "";
        if (entry.kind === "fn" && outputFormat.trim()) {
            parts.push(`--out "${outputFormat.trim()}"`);
        }
        if (entry.kind === "proc" && Number(selected.amount ?? 0) > 0) {
            parts.push(`--amount ${selected.amount}`);
        }

        return parts.join(" ");
    };

    const nameOf = (contract: DynamicContractRegistryEntry) =>
        contract.name || contractIdlForSlot(idlFile, contract.index, contract.codeHash)?.name || `contract ${contract.index}`;

    const entriesFor = (contract: DynamicContractRegistryEntry): Entry[] => {
        const localIdl = contractIdlForSlot(idlFile, contract.index, contract.codeHash);
        let sourceIdl: ContractIdl | undefined;

        try {
            if (contract.source && qpiHeader) {
                sourceIdl = extractIdl(contract.source, contract.name || "Contract", {
                    slot: contract.index,
                    qpiHeader,
                });
            }
        } catch {
            // Registry metadata remains usable without source-derived names.
        }

        const entryIdl = (kind: "functions" | "procedures", inputType: number): ContractEntry | undefined =>
            localIdl?.[kind].find((entry) => entry.inputType === inputType) ?? sourceIdl?.[kind].find((entry) => entry.inputType === inputType);

        const byId = (left: Entry, right: Entry) => left.inputType - right.inputType;
        const functions: Entry[] = (contract.functions ?? [])
            .map((entry) => {
                const metadata = entryIdl("functions", entry.inputType);
                return {
                    kind: "fn" as const,
                    ...entry,
                    name: metadata?.name,
                    input: metadata?.input,
                    output: metadata?.output,
                };
            })
            .sort(byId);
        // Oracle-reply callbacks are dispatched by the node, never invoked by a user, so keep them out.
        const procedures: Entry[] = (contract.procedures ?? [])
            .map((entry) => {
                const metadata = entryIdl("procedures", entry.inputType);
                return {
                    kind: "proc" as const,
                    ...entry,
                    name: metadata?.name,
                    input: metadata?.input,
                    output: metadata?.output,
                    notification: metadata?.notification === true,
                };
            })
            .filter((entry) => !entry.notification)
            .sort(byId);

        return [...functions, ...procedures];
    };

    // Remount each stage so prompt-local cursor and selection state cannot leak.
    const wrap = (content: React.ReactNode) => (
        <Box flexDirection="column">
            <Header cmd="call" />
            <Box key={stage} flexDirection="column">
                {content}
            </Box>
        </Box>
    );

    if (stage === "loading") {
        return wrap(<Spinner label="loading registry" />);
    }
    if (stage === "running") {
        return wrap(<Spinner label={status || "calling"} />);
    }
    if (stage === "done") {
        return wrap(
            <Panel title="result" color={theme.ok}>
                {results.map((line, index) => (
                    <Text
                        key={index}
                        color={
                            line.startsWith("ERROR") || line.startsWith("✗") || line.includes("FAIL")
                                ? theme.err
                                : line.includes("->") || line.includes(": ok")
                                  ? theme.ok
                                  : undefined
                        }
                    >
                        {line}
                    </Text>
                ))}
            </Panel>,
        );
    }

    if (stage === "contract") {
        const labels = formatContractPickerRows(
            contracts.map((contract) => ({
                name: nameOf(contract),
                index: contract.index,
                functionCount: contract.functions.length,
                procedureCount: contract.procedures.length,
            })),
        );
        const contractItems = contracts.map((contract, index) => ({
            label: labels[index],
            value: contract,
        }));
        const deployed = contractItems.slice(0, userCount);
        const system = contractItems.slice(userCount);
        const items = [
            ...(deployed.length ? [{ label: "deployed", header: true }, ...deployed] : []),
            ...(system.length ? [{ label: "system", header: true }, ...system] : []),
        ];

        return wrap(
            <Select
                label="Pick a contract:"
                items={items}
                onSelect={(contract) => {
                    setSelection({ c: contract });
                    setStage("entry");
                }}
            />,
        );
    }

    if (stage === "entry") {
        const items = entriesFor(selection.c!).map((entry) => {
            const kind = entry.kind === "fn" ? "fn  " : "proc";
            const name = entry.name ?? "#" + entry.inputType;
            const input = noInput(entry) ? "no input" : `in ${entry.inputSize}B`;
            const output = entry.kind === "fn" ? `, out ${entry.outputSize}B` : "";

            return {
                label: `${kind} ${name}  (${input}${output})`,
                value: entry,
            };
        });

        return wrap(<Select label={`${nameOf(selection.c!)} — pick a function/procedure:`} items={items} onSelect={startEntry} />);
    }

    if (stage === "input") {
        return wrap(
            <Box flexDirection="column">
                <SchemaBox kind="input" name={`${selection.e!.name ?? selection.e!.kind + "#" + selection.e!.inputType}_input`} type={selection.e!.input} />
                <TextPrompt
                    label={`value format, e.g. 5uint64 · [N; v…] arrays · ×N repeats${selection.e!.kind === "fn" ? "  (empty = none)" : ""}`}
                    initial={selection.input ?? ""}
                    placeholder={
                        selection.e!.input && hasOverlappingAbiType(selection.e!.input)
                            ? (zeroSample(selection.e!) ?? undefined)
                            : selection.e!.input?.kind === AbiTypeKind.STRUCT
                              ? tmplOf(selection.e!.input.fields)
                              : (zeroSample(selection.e!) ?? undefined)
                    }
                    complete={completerFor(selection.e!.input?.kind === AbiTypeKind.STRUCT ? selection.e!.input.fields : undefined, true)}
                    onSubmit={(input) => {
                        const next = { ...selection, input };
                        setSelection(next);
                        afterInput(next);
                    }}
                />
            </Box>,
        );
    }

    if (stage === "output") {
        return wrap(
            <Box flexDirection="column">
                <SchemaBox kind="output" name={`${selection.e!.name ?? selection.e!.kind + "#" + selection.e!.inputType}_output`} type={selection.e!.output} />
                <TextPrompt
                    label="output types only, e.g. uint64 or { id, uint16 }"
                    initial={selection.e!.output?.format ?? ""}
                    placeholder={
                        selection.e!.output?.kind === AbiTypeKind.STRUCT && selection.e!.output.fields.length
                            ? selection.e!.output.fields.map((field) => field.type.format).join(", ")
                            : selection.e!.output?.format
                    }
                    complete={completerFor(selection.e!.output?.kind === AbiTypeKind.STRUCT ? selection.e!.output.fields : undefined)}
                    onSubmit={(out) => {
                        const next = { ...selection, out };
                        setSelection(next);
                        runCall(next);
                    }}
                />
            </Box>,
        );
    }

    if (stage === "amount") {
        return wrap(
            <TextPrompt
                label="amount (qus)"
                initial={selection.amount ?? "0"}
                onSubmit={(amount) => {
                    const next = { ...selection, amount };
                    setSelection(next);
                    runCall(next);
                }}
            />,
        );
    }

    return null;
}
