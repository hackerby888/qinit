import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { LiteRpc, type DynamicContractRegistryEntry } from "@qinit/core";
import { hasOverlappingAbiType, zeroInputFormat } from "@qinit/proto";
import { AbiTypeKind, type AbiField, type AbiType, type ContractEntry, type ContractIdl, type ContractIdlFile } from "@qinit/proto/contract-idl";
import { extractIdl } from "@qinit/build";
import { loadConfiguredQpiHeader } from "../../config";
import { loadContracts, mergeContracts, missingContractMessage } from "../../contracts/registry";
import { contractIdlForSlot, emptyContractIdlFile, loadContractIdlFile } from "../../contracts/idl-file";
import { Header, Spinner, Panel, Status, theme } from "../../ui";
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
    | { stage: "done"; error: string };

type Call = { contract: Contract; entry: Entry; draft: Draft };

// What the wizard collected, in the shape the one-shot path already takes: two positionals plus option strings.
export type CollectedCall = {
    mode: "fn" | "proc";
    contract: string;
    entry: string;
    overrides: Record<string, string | undefined>;
    hint: string;
};

export function CallInteractive({ rpcBaseUrl, onRun }: { rpcBaseUrl: string; onRun: (call: CollectedCall) => void }) {
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

    useEffect(() => {
        (async () => {
            try {
                setIdlFile(loadContractIdlFile());
                const sets = await loadContracts(new LiteRpc(rpcBaseUrl));
                const { all: combined, userCount: deployed } = mergeContracts(sets);

                if (!combined.length) {
                    setWizard({ stage: "done", error: missingContractMessage(sets) });
                    return;
                }

                setContracts(combined);
                setUserCount(deployed);
                setWizard({ stage: "contract" });
            } catch (error: any) {
                setWizard({ stage: "done", error: String(error?.message ?? error) });
            }
        })();
    }, []);

    // The wizard only reaches `done` when it never got as far as a call, so the exit is always a failure.
    useEffect(() => {
        if (wizard.stage === "done") {
            process.exitCode = 1;
            const timer = setTimeout(() => exit(), 50);
            return () => clearTimeout(timer);
        }
    }, [wizard.stage]);

    const back = () => {
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

    // The contract and entry stages mount a Select, which owns esc there — binding it here too would pop the
    // stage and leave its search at the same time. Listed positively so a new Select stage fails inert.
    useInput((_i, key) => {
        if (key.escape && (wizard.stage === "input" || wizard.stage === "output" || wizard.stage === "amount")) {
            back();
        }
    });

    // The wizard stops here: the one-shot path encodes, dispatches, and renders the answers collected above.
    const submit = ({ contract, entry, draft }: Call) => {
        // Only a registry name or a slot index resolves later, so the local IDL name that the picker shows is not usable here.
        const contractArg = contract.name || String(contract.index);
        const entryArg = entry.name ?? String(entry.inputType);

        onRun({
            mode: entry.kind,
            contract: contractArg,
            entry: entryArg,
            // Every key is present so a flag typed alongside the bare command cannot outlive the prompt that replaced it.
            overrides: { args: undefined, in: draft.input ?? "", out: draft.out, amount: draft.amount },
            hint: equivCmd(contractArg, entryArg, entry, draft),
        });
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
            submit(next);
        } else {
            setWizard({ ...next, stage: "output" });
        }
    };

    // Takes the resolvable positionals rather than the display name, so the echoed command is one the user can rerun.
    const equivCmd = (contractArg: string, entryArg: string, entry: Entry, draft: Draft) => {
        const parts = ["qinit call", entry.kind === "fn" ? "--fn" : "--proc", contractArg, entryArg];

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
    if (wizard.stage === "done") {
        return wrap(
            <Box flexDirection="column">
                <Status ok={false} label="call" pad={14} />
                <Box marginLeft={2}>
                    <Text color={theme.err}>{wizard.error}</Text>
                </Box>
            </Box>,
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

        return wrap(<Select label="Pick a contract:" items={items} onCancel={back} onSelect={(contract) => setWizard({ stage: "entry", contract })} />);
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

        return wrap(
            <Select
                label={`${nameOf(contract)} — pick a function/procedure:`}
                items={items}
                onCancel={back}
                onSelect={(entry) => startEntry(contract, entry)}
            />,
        );
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
                    onSubmit={(out) => submit({ ...wizard, draft: { ...draft, out } })}
                />
            </Box>,
        );
    }

    if (wizard.stage === "amount") {
        const { draft } = wizard;

        return wrap(
            <TextPrompt label="amount (qus)" initial={draft.amount ?? "0"} onSubmit={(amount) => submit({ ...wizard, draft: { ...draft, amount } })} />,
        );
    }

    return null;
}
