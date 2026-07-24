import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { LiteRpc, type DynContract } from "@qinit/core";
import {
  callFunction,
  invokeProcedure,
  encodeInput,
  hasOverlappingAbiType,
  zeroInputFmt,
  TX_TICK_OFFSET,
} from "@qinit/proto";
import {
  AbiTypeKind,
  type AbiField,
  type AbiType,
  type ContractEntry,
  type ContractIdl,
  type ContractIdlFile,
} from "@qinit/proto/contract-idl";
import { extractIdl } from "@qinit/build";
import { loadConfiguredQpiHeader, resolveSeed } from "../config";
import { loadContracts, systemAsDyn } from "../contracts";
import {
  contractIdlForSlot,
  emptyContractIdlFile,
  loadContractIdlFile,
} from "../idl-file";
import { fmtVal } from "../trace-format";
import { Header, Spinner, Panel, theme } from "../ui";

type SelItem<T> = { label: string; value?: T; header?: boolean };

function Select<T>({
  label,
  items,
  onSelect,
}: {
  label: string;
  items: SelItem<T>[];
  onSelect: (value: T) => void;
}) {
  const firstSelectable = Math.max(
    0,
    items.findIndex((item) => !item.header),
  );
  const [selected, setSelected] = useState(firstSelectable);

  const step = (direction: number) => {
    setSelected((current) => {
      let next = current;
      for (let i = 0; i < items.length; i++) {
        next = (next + direction + items.length) % items.length;
        if (!items[next].header) {
          return next;
        }
      }
      return current;
    });
  };

  useInput((_in, key) => {
    if (key.upArrow) {
      step(-1);
    } else if (key.downArrow) {
      step(1);
    } else if (key.return && items[selected] && !items[selected].header) {
      onSelect(items[selected].value as T);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        {label}
      </Text>
      <Box borderStyle="round" borderColor={theme.brand} paddingX={1} flexDirection="column">
        {items.map((item, index) =>
          item.header ? (
            <Text key={index} color={theme.mute} bold>
              {"  "}
              {item.label}
            </Text>
          ) : (
            <Text key={index}>
              {index === selected ? (
                <Text color={theme.brand} bold>
                  ▸{" "}
                </Text>
              ) : (
                <Text> </Text>
              )}
              <Text
                color={index === selected ? theme.info : undefined}
                bold={index === selected}
              >
                {item.label}
              </Text>
            </Text>
          ),
        )}
        {!items.length && <Text dimColor>(none)</Text>}
      </Box>
      <Text dimColor> ↑/↓ move · ↵ select · esc back</Text>
    </Box>
  );
}

const QPI_TYPES = [
  "uint64",
  "uint32",
  "uint16",
  "uint8",
  "sint64",
  "sint32",
  "sint16",
  "sint8",
  "id",
  "bit",
  "m256i",
];

export function completerFor(fields?: AbiField[]) {
  return (value: string): string | null => {
    const separator = value.lastIndexOf(",");
    const completed = value.slice(0, separator + 1);
    const current = value.slice(separator + 1);
    const fragment = current.match(/[a-z][a-z0-9]*$/);
    if (!fragment) {
      return null;
    }

    const fieldIndex = (completed.match(/,/g) || []).length;
    const expectedType = fields?.[fieldIndex]?.type.format;
    const candidates =
      expectedType && QPI_TYPES.includes(expectedType)
        ? [expectedType, ...QPI_TYPES]
        : QPI_TYPES;
    const match = candidates.find(
      (type) => type.startsWith(fragment[0]) && type !== fragment[0],
    );

    return match
      ? completed +
          current.slice(0, current.length - fragment[0].length) +
          match
      : null;
  };
}

export const tmplOf = (fields?: AbiField[]) =>
  fields && fields.length
    ? fields.map((field) => `<${field.name}>${field.type.format}`).join(", ")
    : undefined;

function TextPrompt({
  label,
  initial,
  onSubmit,
  complete,
  placeholder,
}: {
  label: string;
  initial?: string;
  onSubmit: (value: string) => void;
  complete?: (value: string) => string | null;
  placeholder?: string;
}) {
  const [value, setValue] = useState(initial ?? "");
  const [caret, setCaret] = useState((initial ?? "").length);
  const completion = complete?.(value) ?? null;
  const completionSuffix =
    completion && completion.length > value.length && completion.startsWith(value)
      ? completion.slice(value.length)
      : "";

  const update = (nextValue: string, nextCaret?: number) => {
    setValue(nextValue);
    setCaret(
      Math.max(0, Math.min(nextValue.length, nextCaret ?? nextValue.length)),
    );
  };

  useInput((input, key) => {
    if (key.return) {
      onSubmit(value);
    } else if (key.tab && completion) {
      update(completion);
    } else if (key.leftArrow) {
      setCaret((current) => Math.max(0, current - 1));
    } else if (key.rightArrow) {
      if (value === "" && placeholder) {
        update(placeholder);
      } else {
        setCaret((current) => Math.min(value.length, current + 1));
      }
    } else if (key.ctrl && input === "a") {
      setCaret(0);
    } else if (key.ctrl && input === "e") {
      setCaret(value.length);
    } else if (key.backspace || key.delete) {
      if (caret > 0) {
        update(
          value.slice(0, caret - 1) + value.slice(caret),
          caret - 1,
        );
      }
    } else if (input && !key.ctrl && !key.meta) {
      update(
        value.slice(0, caret) + input + value.slice(caret),
        caret + input.length,
      );
    }
  });

  const before = value.slice(0, caret);
  const atCaret = value.slice(caret, caret + 1) || " ";
  const after = value.slice(caret + 1);

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={theme.brand} paddingX={1}>
        {value === "" && placeholder ? (
          <Text>
            <Text color={theme.brand} bold>
              ❯{" "}
            </Text>
            <Text inverse> </Text>
            <Text color={theme.mute} dimColor>
              {placeholder}
            </Text>
          </Text>
        ) : (
          <Text>
            <Text color={theme.brand} bold>
              ❯{" "}
            </Text>
            <Text color={theme.ok}>{before}</Text>
            <Text inverse>{atCaret}</Text>
            <Text color={theme.ok}>{after}</Text>
            <Text color={theme.mute} dimColor>
              {completionSuffix}
            </Text>
          </Text>
        )}
      </Box>
      <Text dimColor>
        {" "}
        {label}
        {completionSuffix
          ? `    ⇥ tab → ${completion}`
          : value === "" && placeholder
            ? "    → fill template · ↵ submit"
            : "    ↵ submit"}{" "}
        esc back
      </Text>
    </Box>
  );
}

function SchemaBox({
  kind,
  name,
  type,
}: {
  kind: "input" | "output";
  name?: string;
  type?: AbiType;
}) {
  if (type === undefined) {
    return null;
  }

  const fields = type.kind === AbiTypeKind.STRUCT ? type.fields : undefined;
  return (
    <Panel
      title={`${kind}${name ? "  ·  " + name : ""}`}
      color={kind === "input" ? theme.info : theme.accent}
    >
      {fields === undefined ? (
        <Text color={theme.info}>{type.format}</Text>
      ) : fields.length === 0 ? (
        <Text dimColor>(no fields)</Text>
      ) : (
        fields.map((field, index) => (
          <Text key={index}>
            <Text color={theme.info}>{field.type.format.padEnd(10)}</Text>{" "}
            <Text bold>{field.name}</Text>
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
};

export function zeroSample(entry: Entry): string | null {
  try {
    if (
      !entry.input ||
      (entry.input.kind === AbiTypeKind.STRUCT && entry.input.fields.length === 0)
    ) {
      return null;
    }

    return zeroInputFmt(entry.input);
  } catch {
    return null;
  }
}

type Stage =
  | "loading"
  | "contract"
  | "entry"
  | "input"
  | "output"
  | "amount"
  | "running"
  | "done";

export function CallInteractive({ rpcBase, seed }: { rpcBase: string; seed?: string }) {
  const { exit } = useApp();

  const [qpiHeader] = useState(() => {
    try {
      return loadConfiguredQpiHeader();
    } catch {
      return undefined;
    }
  });
  const [stage, setStage] = useState<Stage>("loading");
  const [contracts, setContracts] = useState<DynContract[]>([]);
  const [userCount, setUserCount] = useState(0);
  const [idlFile, setIdlFile] = useState<ContractIdlFile>(emptyContractIdlFile());
  const [selection, setSelection] = useState<{
    c?: DynContract;
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
        const { user, system } = await loadContracts(new LiteRpc(rpcBase));
        const combined = [...user, ...system.map(systemAsDyn)];

        if (!combined.length) {
          addResult(
            "no contracts — deploy one, or run `qinit node run` to load system contracts",
          );
          setStage("done");
          return;
        }

        setContracts(combined);
        setUserCount(user.length);
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

      const rpc = new LiteRpc(rpcBase);
      const contract = selected.c!;
      const entry = selected.e!;
      const contractIndex = contract.index;
      addResult("≡ " + equivCmd(contract, entry, selected));

      if (entry.kind === "fn") {
        const output = await callFunction(
          rpc,
          contractIndex,
          entry.inputType,
          selected.input ?? "",
          entry.output ?? selected.out ?? "",
        );
        addResult(`${labelFor(contract, entry)} -> ${fmtVal(output)}`);
      } else {
        const tickInfo: any = await rpc.tickInfo();
        const tick = (tickInfo.tick ?? 0) + TX_TICK_OFFSET;
        const procedure = await invokeProcedure({
          seed: await resolveSeed(rpc, selected.seed || seed),
          rpcBase,
          contractIndex,
          procId: entry.inputType,
          amount: Number(selected.amount ?? 0),
          inFmt: selected.input ?? "",
          tick,
          confirm: true,
          rpc,
          onProgress: ({ tick: net, target }) =>
            setStatus(
              `confirming · tick ${net} → ${target}${net < target ? ` (${target - net} to go)` : " · processing"}`,
            ),
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
          const deployed = (await rpc.dynRegistry()).contracts?.find(
            (candidate) => candidate.index === contractIndex,
          );
          if (deployed?.lastError) {
            contractError = ` · contract error: ${deployed.lastError}`;
          }
        } catch {
          // The procedure verdict remains useful if the registry is unavailable.
        }

        addResult(
          `${labelFor(contract, entry)} @tick ${tick}: ${verdict}  ${
            procedure.txId ?? ""
          }${contractError}`,
        );
      }
    } catch (error: any) {
      addResult("ERROR: " + String(error?.message ?? error));
    }

    setStage("done");
  };

  const noInput = (entry: Entry) =>
    entry.input?.kind === AbiTypeKind.STRUCT &&
    entry.input.fields.length === 0;

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

  const labelFor = (contract: DynContract, entry: Entry) =>
    `${nameOf(contract)}.${entry.name ?? entry.kind + "#" + entry.inputType}`;

  const equivCmd = (
    contract: DynContract,
    entry: Entry,
    selected: typeof selection,
  ) => {
    const entryName = entry.name ?? entry.inputType;
    const parts = [
      "qinit call",
      entry.kind === "fn" ? "--fn" : "--proc",
      String(nameOf(contract)),
      String(entryName),
    ];

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

  const nameOf = (contract: DynContract) =>
    contract.name ||
    contractIdlForSlot(idlFile, contract.index, contract.codeHash)?.name ||
    `contract ${contract.index}`;

  const entriesFor = (contract: DynContract): Entry[] => {
    const localIdl = contractIdlForSlot(
      idlFile,
      contract.index,
      contract.codeHash,
    );
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

    const entryIdl = (
      kind: "functions" | "procedures",
      inputType: number,
    ): ContractEntry | undefined =>
      localIdl?.[kind].find((entry) => entry.inputType === inputType) ??
      sourceIdl?.[kind].find((entry) => entry.inputType === inputType);

    const byId = (left: Entry, right: Entry) =>
      left.inputType - right.inputType;
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
    const procedures: Entry[] = (contract.procedures ?? [])
      .map((entry) => {
        const metadata = entryIdl("procedures", entry.inputType);
        return {
          kind: "proc" as const,
          ...entry,
          name: metadata?.name,
          input: metadata?.input,
          output: metadata?.output,
        };
      })
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
              line.startsWith("ERROR") ||
              line.startsWith("✗") ||
              line.includes("FAIL")
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
    const item = (contract: DynContract) => ({
      label: `${nameOf(contract)}  [idx ${contract.index}]  ${
        contract.functions.length
      } fn / ${contract.procedures.length} proc`,
      value: contract,
    });
    const deployed = contracts.slice(0, userCount);
    const system = contracts.slice(userCount);
    const items = [
      ...(deployed.length
        ? [{ label: "deployed", header: true }, ...deployed.map(item)]
        : []),
      ...(system.length
        ? [{ label: "system", header: true }, ...system.map(item)]
        : []),
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

    return wrap(
      <Select
        label={`${nameOf(selection.c!)} — pick a function/procedure:`}
        items={items}
        onSelect={startEntry}
      />,
    );
  }

  if (stage === "input") {
    return wrap(
      <Box flexDirection="column">
        <SchemaBox
          kind="input"
          name={`${selection.e!.name ?? selection.e!.kind + "#" + selection.e!.inputType}_input`}
          type={selection.e!.input}
        />
        <TextPrompt
          label={`value format, e.g. 5uint64 · [N; v…] arrays · ×N repeats${
            selection.e!.kind === "fn" ? "  (empty = none)" : ""
          }`}
          initial={selection.input ?? ""}
          placeholder={
            selection.e!.input && hasOverlappingAbiType(selection.e!.input)
              ? zeroSample(selection.e!) ?? undefined
              : selection.e!.input?.kind === AbiTypeKind.STRUCT
              ? tmplOf(selection.e!.input.fields)
              : zeroSample(selection.e!) ?? undefined
          }
          complete={completerFor(
            selection.e!.input?.kind === AbiTypeKind.STRUCT
              ? selection.e!.input.fields
              : undefined,
          )}
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
        <SchemaBox
          kind="output"
          name={`${selection.e!.name ?? selection.e!.kind + "#" + selection.e!.inputType}_output`}
          type={selection.e!.output}
        />
        <TextPrompt
          label="output types only, e.g. uint64 or { id, uint16 }"
          initial={selection.e!.output?.format ?? ""}
          placeholder={
            selection.e!.output?.kind === AbiTypeKind.STRUCT &&
            selection.e!.output.fields.length
              ? selection.e!.output.fields.map((field) => field.type.format).join(", ")
              : selection.e!.output?.format
          }
          complete={completerFor(
            selection.e!.output?.kind === AbiTypeKind.STRUCT
              ? selection.e!.output.fields
              : undefined,
          )}
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
