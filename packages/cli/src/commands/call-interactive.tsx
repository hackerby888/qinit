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

// Arrow-key single-select list. `header` items are non-selectable group separators (skipped on navigation).
type SelItem<T> = { label: string; value?: T; header?: boolean };
function Select<T>({
  label,
  items,
  onSelect,
}: {
  label: string;
  items: SelItem<T>[];
  onSelect: (v: T) => void;
}) {
  const first = Math.max(
    0,
    items.findIndex((x) => !x.header),
  );
  const [i, setI] = useState(first);
  const step = (dir: number) =>
    setI((p) => {
      for (let k = 0, n = p; k < items.length; k++) {
        n = (n + dir + items.length) % items.length;
        if (!items[n].header) return n;
      }
      return p;
    });
  useInput((_in, key) => {
    if (key.upArrow) step(-1);
    else if (key.downArrow) step(1);
    else if (key.return && items[i] && !items[i].header) onSelect(items[i].value as T);
  });
  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        {label}
      </Text>
      <Box borderStyle="round" borderColor={theme.brand} paddingX={1} flexDirection="column">
        {items.map((it, k) =>
          it.header ? (
            <Text key={k} color={theme.mute} bold>
              {"  "}
              {it.label}
            </Text>
          ) : (
            <Text key={k}>
              {k === i ? (
                <Text color={theme.brand} bold>
                  ▸{" "}
                </Text>
              ) : (
                <Text> </Text>
              )}
              <Text color={k === i ? theme.info : undefined} bold={k === i}>
                {it.label}
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

// qpi value/type tokens — complete the trailing type fragment of the last comma-separated token (Tab to accept).
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
// Schema-aware completer: the field at the current comma position expects a known type, so prefer it
// (e.g. SC field is uint32 -> "1u" suggests uint32, not the generic-first uint64). Falls back to generic.
export function completerFor(fields?: AbiField[]) {
  return (v: string): string | null => {
    const cut = v.lastIndexOf(",");
    const head = v.slice(0, cut + 1),
      seg = v.slice(cut + 1); // last token (may carry a leading space)
    const m = seg.match(/[a-z][a-z0-9]*$/); // trailing lowercase-led type fragment
    if (!m) return null;
    const idx = (head.match(/,/g) || []).length; // current field index = commas before this token
    const exp = fields?.[idx]?.type.format;
    const cands = exp && QPI_TYPES.includes(exp) ? [exp, ...QPI_TYPES] : QPI_TYPES;
    const hit = cands.find((t) => t.startsWith(m[0]) && t !== m[0]);
    return hit ? head + seg.slice(0, seg.length - m[0].length) + hit : null;
  };
}

// Placeholder template: one "<field>type" token per field — shows the exact value+type syntax to type
// (greyed, vanishes once the dev types). undefined when the schema is unknown -> no placeholder.
export const tmplOf = (fields?: AbiField[]) =>
  fields && fields.length
    ? fields.map((field) => `<${field.name}>${field.type.format}`).join(", ")
    : undefined;

// Single-line text prompt (chars / backspace / enter). `complete` adds ghost-text type autocomplete + Tab.
// `placeholder` is shown greyed when the field is empty (input template hint) and disappears on first keystroke.
function TextPrompt({
  label,
  initial,
  onSubmit,
  complete,
  placeholder,
}: {
  label: string;
  initial?: string;
  onSubmit: (v: string) => void;
  complete?: (v: string) => string | null;
  placeholder?: string;
}) {
  const [v, setV] = useState(initial ?? "");
  const [cur, setCur] = useState((initial ?? "").length); // caret position (0..v.length)
  const ghost = complete?.(v) ?? null;
  const rest = ghost && ghost.length > v.length && ghost.startsWith(v) ? ghost.slice(v.length) : "";
  const set = (nv: string, nc?: number) => {
    setV(nv);
    setCur(Math.max(0, Math.min(nv.length, nc ?? nv.length)));
  };
  useInput((input, key) => {
    if (key.return) onSubmit(v);
    else if (key.tab && ghost)
      set(ghost); // accept type completion
    else if (key.leftArrow) setCur((c) => Math.max(0, c - 1));
    else if (key.rightArrow) {
      if (v === "" && placeholder) set(placeholder);
      else setCur((c) => Math.min(v.length, c + 1));
    } else if (key.ctrl && input === "a")
      setCur(0); // home
    else if (key.ctrl && input === "e")
      setCur(v.length); // end
    else if (key.backspace || key.delete) {
      if (cur > 0) set(v.slice(0, cur - 1) + v.slice(cur), cur - 1);
    } // delete char before caret
    else if (input && !key.ctrl && !key.meta)
      set(v.slice(0, cur) + input + v.slice(cur), cur + input.length); // insert at caret
  });
  // render the caret AT `cur`: text before + inverse char (or a space at EOL) + text after + dim ghost completion.
  const before = v.slice(0, cur),
    atChar = v.slice(cur, cur + 1) || " ",
    after = v.slice(cur + 1);
  return (
    <Box flexDirection="column">
      {/* eye-catching prompt: a rounded box with a bright caret, like the Claude Code input */}
      <Box borderStyle="round" borderColor={theme.brand} paddingX={1}>
        {v === "" && placeholder ? (
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
            <Text inverse>{atChar}</Text>
            <Text color={theme.ok}>{after}</Text>
            <Text color={theme.mute} dimColor>
              {rest}
            </Text>
          </Text>
        )}
      </Box>
      <Text dimColor>
        {" "}
        {label}
        {rest
          ? `    ⇥ tab → ${ghost}`
          : v === "" && placeholder
            ? "    → fill template · ↵ submit"
            : "    ↵ submit"}{" "}
        esc back
      </Text>
    </Box>
  );
}

// Friendly schema shown in a bordered, titled box above the prompt — so devs see the field shape at a glance.
function SchemaBox({
  kind,
  name,
  type,
}: {
  kind: "input" | "output";
  name?: string;
  type?: AbiType;
}) {
  if (type === undefined) return null;
  const fields = type.kind === AbiTypeKind.STRUCT
    ? type.fields
    : undefined;
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
        fields.map((f, i) => (
          <Text key={i}>
            <Text color={theme.info}>{f.type.format.padEnd(10)}</Text>{" "}
            <Text bold>{f.name}</Text>
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

// All-zero, schema-matched input sample for an entry — shown when the user's input fails to encode.
export function zeroSample(e: Entry): string | null {
  try {
    if (
      !e.input ||
      (
        e.input.kind === AbiTypeKind.STRUCT &&
        e.input.fields.length === 0
      )
    ) {
      return null;
    }
    return zeroInputFmt(e.input);
  } catch {
    return null;
  }
}
type Stage =
  "loading" | "contract" | "entry" | "input" | "output" | "amount" | "seed" | "running" | "done";

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
  const [userCount, setUserCount] = useState(0); // contracts[0..userCount) = deployed, rest = system
  const [idl, setIdl] = useState<ContractIdlFile>(emptyContractIdlFile());
  const [sel, setSel] = useState<{
    c?: DynContract;
    e?: Entry;
    input?: string;
    out?: string;
    amount?: string;
    seed?: string;
  }>({});
  const [result, setResult] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const add = (s: string) => setResult((l) => [...l, s]);

  useEffect(() => {
    (async () => {
      try {
        setIdl(loadContractIdlFile());
        const { user, system } = await loadContracts(new LiteRpc(rpcBase)); // deployed first, then system (catalog)
        const combined = [...user, ...system.map(systemAsDyn)];
        if (!combined.length) {
          add("no contracts — deploy one, or run `qinit node run` to load system contracts");
          setStage("done");
          return;
        }
        setContracts(combined);
        setUserCount(user.length);
        setStage("contract");
      } catch (e: any) {
        add("ERROR: " + String(e?.message ?? e));
        setStage("done");
      }
    })();
  }, []);
  useEffect(() => {
    if (stage === "done") {
      const t = setTimeout(() => exit(), 50);
      return () => clearTimeout(t);
    }
  }, [stage]);

  // Esc = go back one step (contract = first step -> quit). Parent-level so it works in every stage; Select/
  // TextPrompt don't consume Esc, so this fires without clashing with their own keys. Mid-call/terminal: ignored.
  const back = () => {
    setStatus("");
    if (stage === "entry") setStage("contract");
    else if (stage === "input") setStage("entry");
    else if (stage === "output" || stage === "amount")
      setStage(sel.e && !noInput(sel.e) ? "input" : "entry");
    else if (stage === "contract") exit();
  };
  useInput((_i, key) => {
    if (key.escape) back();
  });

  // ---- run the selected call ----
  const run = async (s: typeof sel) => {
    setStage("running");
    try {
      // pre-validate the input encodes; on failure show a schema-matched all-zero sample (no tx is sent)
      try {
        await encodeInput(s.input ?? "");
      } catch (enc: any) {
        add("✗ bad input: " + String(enc?.message ?? enc));
        const z = zeroSample(s.e!);
        if (z) add("all-zero sample: " + z);
        setStage("done");
        return;
      }
      const rpc = new LiteRpc(rpcBase);
      const idx = s.c!.index,
        e = s.e!;
      add("≡ " + equivCmd(s.c!, e, s)); // the non-interactive equivalent — copy-paste to repeat this call
      if (e.kind === "fn") {
        const out = await callFunction(
          rpc,
          idx,
          e.inputType,
          s.input ?? "",
          e.output ?? s.out ?? "",
        );
        add(`${labelFor(s.c!, e)} -> ${fmtVal(out)}`);
      } else {
        const ti: any = await rpc.tickInfo();
        const tick = (ti.tick ?? 0) + TX_TICK_OFFSET;
        // confirm=true: wait until the tx is actually processed so the user sees success/dropped, not just "broadcast".
        const r = await invokeProcedure({
          seed: await resolveSeed(rpc, s.seed || seed),
          rpcBase,
          contractIndex: idx,
          procId: e.inputType,
          amount: Number(s.amount ?? 0),
          inFmt: s.input ?? "",
          tick,
          confirm: true,
          rpc,
          onProgress: ({ tick: net, target }) =>
            setStatus(
              `confirming · tick ${net} → ${target}${net < target ? ` (${target - net} to go)` : " · processing"}`,
            ),
        });
        setStatus("");
        const verdict = !r.ok
          ? `FAIL ${r.message ?? r.code ?? ""}`
          : r.confirmed && r.included
            ? "processed ✓"
            : r.confirmed && !r.included
              ? "DROPPED — not included"
              : "broadcast (unconfirmed — no tx-status addon or timed out)";
        let ne = ""; // surface the contract's last trap reason if it failed
        try {
          const c2 = (await rpc.dynRegistry()).contracts?.find((x) => x.index === idx);
          if (c2?.lastError) ne = ` · contract error: ${c2.lastError}`;
        } catch {}
        add(`${labelFor(s.c!, e)} @tick ${tick}: ${verdict}  ${r.txId ?? ""}${ne}`);
      }
    } catch (e: any) {
      add("ERROR: " + String(e?.message ?? e));
    }
    setStage("done");
  };

  // Skip prompts whose layouts are known from the IDL.
  const noInput = (e: Entry) =>
    e.input?.kind === AbiTypeKind.STRUCT &&
    e.input.fields.length === 0;
  const startEntry = (e: Entry) => {
    const ns = { ...sel, e, input: "" };
    setSel(ns);
    if (!noInput(e)) {
      setStage("input");
      return;
    }
    if (e.kind === "fn") {
      if (e.output !== undefined) run(ns);
      else setStage("output");
    } else setStage("amount");
  };
  const afterInput = (ns: typeof sel) => {
    if (ns.e!.kind === "fn") {
      if (ns.e!.output !== undefined) run(ns);
      else setStage("output");
    } else setStage("amount");
  };

  const labelFor = (c: DynContract, e: Entry) =>
    `${nameOf(c)}.${e.name ?? e.kind + "#" + e.inputType}`;
  // the equivalent non-interactive command (name + entry both accept name-or-number in `qinit call`)
  const equivCmd = (c: DynContract, e: Entry, s: typeof sel) => {
    const entry = e.name ?? e.inputType;
    const parts = [
      "qinit call",
      e.kind === "fn" ? "--fn" : "--proc",
      String(nameOf(c)),
      String(entry),
    ];
    if ((s.input ?? "").trim()) parts.push(`--in "${s.input!.trim()}"`);
    const outputFormat = e.output?.format ?? s.out ?? "";
    if (e.kind === "fn" && outputFormat.trim()) {
      parts.push(`--out "${outputFormat.trim()}"`);
    }
    if (e.kind === "proc" && Number(s.amount ?? 0) > 0) parts.push(`--amount ${s.amount}`);
    return parts.join(" ");
  };
  const nameOf = (c: DynContract) =>
    c.name ||
    contractIdlForSlot(idl, c.index, c.codeHash)?.name ||
    `contract ${c.index}`;

  // ---- entries for the chosen contract (registry truth, merged with IDL names/formats) ----
  // names + in/out fmts: prefer the local qinit.idl.json, else derive from the node-stored contract source
  const entriesFor = (c: DynContract): Entry[] => {
    const localIdl = contractIdlForSlot(idl, c.index, c.codeHash);
    let sourceIdl: ContractIdl | undefined;
    try {
      if (c.source && qpiHeader) {
        sourceIdl = extractIdl(c.source, c.name || "Contract", {
          slot: c.index,
          qpiHeader,
        });
      }
    } catch {}
    const entryIdl = (
      kind: "functions" | "procedures",
      inputType: number,
    ): ContractEntry | undefined =>
      localIdl?.[kind].find((entry) => entry.inputType === inputType) ??
      sourceIdl?.[kind].find((entry) => entry.inputType === inputType);
    // sort by inputType (registration id) — node dyn-registry returns entries hashmap-ordered (looks random);
    // stable ascending order makes the first-listed entry deterministic and matches source declaration order.
    const byId = (a: Entry, b: Entry) => a.inputType - b.inputType;
    const fns: Entry[] = (c.functions ?? [])
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
    const pcs: Entry[] = (c.procedures ?? [])
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
    return [...fns, ...pcs];
  };

  // key the stage subtree by `stage` so each step REMOUNTS fresh — otherwise React reuses the same Select/
  // TextPrompt across stages and its useState (cursor index / typed value) leaks over (stale/no default select).
  const wrap = (el: React.ReactNode) => (
    <Box flexDirection="column">
      <Header cmd="call" />
      <Box key={stage} flexDirection="column">
        {el}
      </Box>
    </Box>
  );

  if (stage === "loading") return wrap(<Spinner label="loading registry" />);
  if (stage === "running") return wrap(<Spinner label={status || "calling"} />);
  if (stage === "done")
    return wrap(
      <Panel title="result" color={theme.ok}>
        {result.map((l, i) => (
          <Text
            key={i}
            color={
              l.startsWith("ERROR") || l.startsWith("✗") || l.includes("FAIL")
                ? theme.err
                : l.includes("->") || l.includes(": ok")
                  ? theme.ok
                  : undefined
            }
          >
            {l}
          </Text>
        ))}
      </Panel>,
    );

  if (stage === "contract") {
    const item = (c: DynContract) => ({
      label: `${nameOf(c)}  [idx ${c.index}]  ${c.functions.length} fn / ${c.procedures.length} proc`,
      value: c,
    });
    const u = contracts.slice(0, userCount),
      s = contracts.slice(userCount);
    const items = [
      ...(u.length ? [{ label: "deployed", header: true }, ...u.map(item)] : []),
      ...(s.length ? [{ label: "system", header: true }, ...s.map(item)] : []),
    ];
    return wrap(
      <Select
        label="Pick a contract:"
        items={items}
        onSelect={(c) => {
          setSel({ c });
          setStage("entry");
        }}
      />,
    );
  }

  if (stage === "entry") {
    const items = entriesFor(sel.c!).map((e) => ({
      label: `${e.kind === "fn" ? "fn  " : "proc"} ${e.name ?? "#" + e.inputType}  (${noInput(e) ? "no input" : "in " + e.inputSize + "B"}${e.kind === "fn" ? ", out " + e.outputSize + "B" : ""})`,
      value: e,
    }));
    return wrap(
      <Select
        label={`${nameOf(sel.c!)} — pick a function/procedure:`}
        items={items}
        onSelect={(e) => startEntry(e)}
      />,
    );
  }

  if (stage === "input")
    return wrap(
      <Box flexDirection="column">
        <SchemaBox
          kind="input"
          name={`${sel.e!.name ?? sel.e!.kind + "#" + sel.e!.inputType}_input`}
          type={sel.e!.input}
        />
        {/* input is never auto-filled — the schema shows as a greyed placeholder template, the dev types the values */}
        <TextPrompt
          label={`value format, e.g. 5uint64 · [N; v…] arrays · ×N repeats${sel.e!.kind === "fn" ? "  (empty = none)" : ""}`}
          initial={sel.input ?? ""}
          placeholder={
            sel.e!.input && hasOverlappingAbiType(sel.e!.input)
              ? zeroSample(sel.e!) ?? undefined
              : sel.e!.input?.kind === AbiTypeKind.STRUCT
              ? tmplOf(sel.e!.input.fields)
              : zeroSample(sel.e!) ?? undefined
          }
          complete={completerFor(
            sel.e!.input?.kind === AbiTypeKind.STRUCT
              ? sel.e!.input.fields
              : undefined,
          )}
          onSubmit={(input) => {
            const ns = { ...sel, input };
            setSel(ns);
            afterInput(ns);
          }}
        />
      </Box>,
    );

  if (stage === "output")
    return wrap(
      <Box flexDirection="column">
        <SchemaBox
          kind="output"
          name={`${sel.e!.name ?? sel.e!.kind + "#" + sel.e!.inputType}_output`}
          type={sel.e!.output}
        />
        <TextPrompt
          label="output types only, e.g. uint64 or { id, uint16 }"
          initial={sel.e!.output?.format ?? ""}
          placeholder={
            sel.e!.output?.kind === AbiTypeKind.STRUCT &&
            sel.e!.output.fields.length
              ? sel.e!.output.fields.map((field) => field.type.format).join(", ")
              : sel.e!.output?.format
          }
          complete={completerFor(
            sel.e!.output?.kind === AbiTypeKind.STRUCT
              ? sel.e!.output.fields
              : undefined,
          )}
          onSubmit={(out) => {
            const ns = { ...sel, out };
            setSel(ns);
            run(ns);
          }}
        />
      </Box>,
    );

  // amount is the last prompt — seed is auto-resolved (saved pick > node funded > default), no prompt.
  if (stage === "amount")
    return wrap(
      <TextPrompt
        label="amount (qus)"
        initial={sel.amount ?? "0"}
        onSubmit={(amount) => {
          const ns = { ...sel, amount };
          setSel(ns);
          run(ns);
        }}
      />,
    );

  return null;
}
