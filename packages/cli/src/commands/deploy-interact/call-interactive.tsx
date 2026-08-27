import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { LiteRpc, type DynamicContractRegistryEntry } from "@qinit/core";
import { callFunction, invokeProcedure, encodeInput, checkInputSize, hasOverlappingAbiType, zeroInputFormat, TX_TICK_OFFSET } from "@qinit/proto";
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

const entryLabel = (entry: Entry) => entry.name ?? entry.kind + "#" + entry.inputType;

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

type Contract = DynamicContractRegistryEntry;

// What the user has typed for the chosen entry; every field is still open until its prompt is answered.
type Draft = { input?: string; out?: string; amount?: string };

// The wizard carries its data with its stage, so a stage can only be entered with what it needs to render.
type Wizard =
    | { stage: "loading" }
    | { stage: "contract" }
    | { stage: "entry"; contract: Contract }
    | { stage: "input"; contract: Contract; entry: Entry; draft: Draft }
    | { stage: "output"; contract: Contract; entry: Entry; draft: Draft }
    | { stage: "amount"; contract: Contract; entry: Entry; draft: Draft }
    | { stage: "running"; contract: Contract; entry: Entry; draft: Draft }
    | { stage: "done" };

type Call = { contract: Contract; entry: Entry; draft: Draft };

export function CallInteractive({ rpcBaseUrl, seed }: { rpcBaseUrl: string; seed?: string }) {
    const { exit } = useApp();

    const [qpiHeader] = useState(() => {
        try {
            return loadConfiguredQpiHeader();
        } catch {
            return undefined;
        }
    });
    const [wizard, setWizard] = useState<Wizard>({ stage: "loading" });
    const [contracts, setContracts] = useState<Contract[]>([]);
    const [userCount, setUserCount] = useState(0);
    const [idlFile, setIdlFile] = useState<ContractIdlFile>(emptyContractIdlFile());
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
                    setWizard({ stage: "done" });
                    return;
                }

                setContracts(combined);
                setUserCount(deployed);
                setWizard({ stage: "contract" });
            } catch (error: any) {
                addResult("ERROR: " + String(error?.message ?? error));
                setWizard({ stage: "done" });
            }
        })();
    }, []);

    useEffect(() => {
        if (wizard.stage === "done") {
            const timer = setTimeout(() => exit(), 50);
            return () => clearTimeout(timer);
        }
    }, [wizard.stage]);

    const back = () => {
        setStatus("");
        if (wizard.stage === "entry") {
            setWizard({ stage: "contract" });
        } else if (wizard.stage === "input") {
            setWizard({ stage: "entry", contract: wizard.contract });
        } else if (wizard.stage === "output" || wizard.stage === "amount") {
            setWizard(noInput(wizard.entry) ? { stage: "entry", contract: wizard.contract } : { ...wizard, stage: "input" });
        } else if (wizard.stage === "contract") {
            exit();
        }
    };

    useInput((_i, key) => {
        if (key.escape) {
            back();
        }
    });

    const runCall = async ({ contract, entry, draft }: Call) => {
        setWizard({ stage: "running", contract, entry, draft });

        try {
            try {
                const encoded = await encodeInput(draft.input ?? "");
                if (entry.input) {
                    checkInputSize(entry.input, encoded, entryLabel(entry));
                }
            } catch (error: any) {
                addResult("✗ bad input: " + String(error?.message ?? error));
                const sample = zeroSample(entry);
                if (sample) {
                    addResult("all-zero sample: " + sample);
                }
                setWizard({ stage: "done" });
                return;
            }

            const rpc = new LiteRpc(rpcBaseUrl);
            const contractIndex = contract.index;
            addResult("≡ " + equivCmd(contract, entry, draft));

            if (entry.kind === "fn") {
                const output = await callFunction(rpc, contractIndex, entry.inputType, draft.input ?? "", entry.output ?? draft.out ?? "");
                // The IDL type wins over a typed-in format above, and it is the one that names the fields.
                const shown = entry.output ? formatStateValue(output, entry.output, false, true) : fmtVal(output);
                addResult(`${labelFor(contract, entry)} -> ${shown}`);
            } else {
                const tickInfo = await rpc.tickInfo();
                const tick = tickInfo.tick + TX_TICK_OFFSET;
                const procedure = await invokeProcedure({
                    seed: await resolveSeed(rpc, seed),
                    rpcBaseUrl: rpcBaseUrl,
                    contractIndex,
                    procedureId: entry.inputType,
                    amount: Number(draft.amount ?? 0),
                    inputFormat: draft.input ?? "",
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

        setWizard({ stage: "done" });
    };

    const noInput = (entry: Entry) => entry.input?.kind === AbiTypeKind.STRUCT && entry.input.fields.length === 0;

    const startEntry = (contract: Contract, entry: Entry) => {
        const next: Call = { contract, entry, draft: { input: "" } };
        if (!noInput(entry)) {
            setWizard({ ...next, stage: "input" });
            return;
        }
        afterInput(next);
    };

    const afterInput = (next: Call) => {
        if (next.entry.kind !== "fn") {
            setWizard({ ...next, stage: "amount" });
        } else if (next.entry.output !== undefined) {
            runCall(next);
        } else {
            setWizard({ ...next, stage: "output" });
        }
    };

    const labelFor = (contract: Contract, entry: Entry) => `${nameOf(contract)}.${entry.name ?? entry.kind + "#" + entry.inputType}`;

    const equivCmd = (contract: Contract, entry: Entry, draft: Draft) => {
        const entryName = entry.name ?? entry.inputType;
        const parts = ["qinit call", entry.kind === "fn" ? "--fn" : "--proc", String(nameOf(contract)), String(entryName)];

        const input = (draft.input ?? "").trim();
        if (input) {
            parts.push(`--in "${input}"`);
        }

        const outputFormat = entry.output?.format ?? draft.out ?? "";
        if (entry.kind === "fn" && outputFormat.trim()) {
            parts.push(`--out "${outputFormat.trim()}"`);
        }
        if (entry.kind === "proc" && Number(draft.amount ?? 0) > 0) {
            parts.push(`--amount ${draft.amount}`);
        }

        return parts.join(" ");
    };

    const nameOf = (contract: Contract) =>
        contract.name || contractIdlForSlot(idlFile, contract.index, contract.codeHash)?.name || `contract ${contract.index}`;

    const entriesFor = (contract: Contract): Entry[] => {
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
            <Box key={wizard.stage} flexDirection="column">
                {content}
            </Box>
        </Box>
    );

    if (wizard.stage === "loading") {
        return wrap(<Spinner label="loading registry" />);
    }
    if (wizard.stage === "running") {
        return wrap(<Spinner label={status || "calling"} />);
    }
    if (wizard.stage === "done") {
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

    if (wizard.stage === "contract") {
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

        return wrap(<Select label="Pick a contract:" items={items} onSelect={(contract) => setWizard({ stage: "entry", contract })} />);
    }

    if (wizard.stage === "entry") {
        const { contract } = wizard;
        const items = entriesFor(contract).map((entry) => {
            const kind = entry.kind === "fn" ? "fn  " : "proc";
            const name = entry.name ?? "#" + entry.inputType;
            const input = noInput(entry) ? "no input" : `in ${entry.inputSize}B`;
            const output = entry.kind === "fn" ? `, out ${entry.outputSize}B` : "";

            return {
                label: `${kind} ${name}  (${input}${output})`,
                value: entry,
            };
        });

        return wrap(<Select label={`${nameOf(contract)} — pick a function/procedure:`} items={items} onSelect={(entry) => startEntry(contract, entry)} />);
    }

    if (wizard.stage === "input") {
        const { entry, draft } = wizard;
        const structFields = entry.input?.kind === AbiTypeKind.STRUCT ? entry.input.fields : undefined;

        return wrap(
            <Box flexDirection="column">
                <SchemaBox kind="input" name={`${entryLabel(entry)}_input`} type={entry.input} />
                <TextPrompt
                    label={`value format, e.g. 5uint64 · [N; v…] arrays · ×N repeats${entry.kind === "fn" ? "  (empty = none)" : ""}`}
                    initial={draft.input ?? ""}
                    placeholder={structFields && !(entry.input && hasOverlappingAbiType(entry.input)) ? tmplOf(structFields) : (zeroSample(entry) ?? undefined)}
                    complete={completerFor(structFields, true)}
                    onSubmit={(input) => afterInput({ ...wizard, draft: { ...draft, input } })}
                />
            </Box>,
        );
    }

    if (wizard.stage === "output") {
        const { entry, draft } = wizard;
        const structFields = entry.output?.kind === AbiTypeKind.STRUCT ? entry.output.fields : undefined;

        return wrap(
            <Box flexDirection="column">
                <SchemaBox kind="output" name={`${entryLabel(entry)}_output`} type={entry.output} />
                <TextPrompt
                    label="output types only, e.g. uint64 or { id, uint16 }"
                    initial={entry.output?.format ?? ""}
                    placeholder={structFields?.length ? structFields.map((field) => field.type.format).join(", ") : entry.output?.format}
                    complete={completerFor(structFields)}
                    onSubmit={(out) => runCall({ ...wizard, draft: { ...draft, out } })}
                />
            </Box>,
        );
    }

    if (wizard.stage === "amount") {
        const { draft } = wizard;

        return wrap(
            <TextPrompt label="amount (qus)" initial={draft.amount ?? "0"} onSubmit={(amount) => runCall({ ...wizard, draft: { ...draft, amount } })} />,
        );
    }

    return null;
}
