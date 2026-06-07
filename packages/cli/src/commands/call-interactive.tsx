import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { LiteRpc, type DynContract } from "@qinit/core";
import { callFunction, invokeProcedure, TX_TICK_OFFSET } from "@qinit/proto";
import { extractIdl } from "@qinit/build";
import { existsSync, readFileSync } from "node:fs";
import { resolveSeed } from "../config";
import { Header, Spinner, Panel, theme } from "../ui";

// Optional local IDL (names + format strings) keyed by contract index, merged over the registry.
//   { "28": { name, functions:{ "1":{name,in,out} }, procedures:{ "1":{name,in} } } }
type Idl = Record<string, {
  name?: string;
  functions?: Record<string, { name?: string; in?: string; out?: string }>;
  procedures?: Record<string, { name?: string; in?: string }>;
}>;
function loadIdl(path?: string): Idl {
  const p = path ?? "qinit.idl.json";
  try { if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")); } catch {}
  return {};
}

// Arrow-key single-select list.
function Select<T>({ label, items, onSelect }: { label: string; items: { label: string; value: T }[]; onSelect: (v: T) => void }) {
  const [i, setI] = useState(0);
  useInput((_in, key) => {
    if (key.upArrow) setI((p) => (p - 1 + items.length) % items.length);
    else if (key.downArrow) setI((p) => (p + 1) % items.length);
    else if (key.return && items.length) onSelect(items[i].value);
  });
  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>{label}</Text>
      <Box borderStyle="round" borderColor={theme.brand} paddingX={1} flexDirection="column">
        {items.map((it, k) => (
          <Text key={k}>
            {k === i ? <Text color={theme.brand} bold>▸ </Text> : <Text>  </Text>}
            <Text color={k === i ? theme.info : undefined} bold={k === i}>{it.label}</Text>
          </Text>
        ))}
        {!items.length && <Text dimColor>(none)</Text>}
      </Box>
      <Text dimColor>  ↑/↓ move · ↵ select</Text>
    </Box>
  );
}

// qpi value/type tokens — complete the trailing type fragment of the last comma-separated token (Tab to accept).
const QPI_TYPES = ["uint64", "uint32", "uint16", "uint8", "sint64", "sint32", "sint16", "sint8", "id", "bit", "m256i"];
function completeType(v: string): string | null {
  const cut = v.lastIndexOf(",");
  const head = v.slice(0, cut + 1), seg = v.slice(cut + 1);   // last token (may carry a leading space)
  const m = seg.match(/[a-z][a-z0-9]*$/);                     // trailing lowercase-led type fragment
  if (!m) return null;
  const hit = QPI_TYPES.find((t) => t.startsWith(m[0]) && t !== m[0]);
  return hit ? head + seg.slice(0, seg.length - m[0].length) + hit : null;
}

// Single-line text prompt (chars / backspace / enter). `complete` adds ghost-text type autocomplete + Tab.
function TextPrompt({ label, initial, onSubmit, complete }: { label: string; initial?: string; onSubmit: (v: string) => void; complete?: (v: string) => string | null }) {
  const [v, setV] = useState(initial ?? "");
  const ghost = complete?.(v) ?? null;
  const rest = ghost && ghost.length > v.length && ghost.startsWith(v) ? ghost.slice(v.length) : "";
  useInput((input, key) => {
    if (key.return) onSubmit(v);
    else if (key.tab && ghost) setV(ghost);
    else if (key.backspace || key.delete) setV((p) => p.slice(0, -1));
    else if (input && !key.ctrl && !key.meta) setV((p) => p + input);
  });
  return (
    <Box flexDirection="column">
      <Text><Text color={theme.accent} bold>? </Text><Text bold>{label}</Text></Text>
      <Text>  <Text color={theme.brand}>❯ </Text><Text color={theme.ok}>{v}</Text><Text color={theme.mute} dimColor>{rest}</Text><Text inverse> </Text></Text>
      {rest ? <Text dimColor>  ⇥ tab → {ghost}</Text> : null}
    </Box>
  );
}

// Friendly struct shape (field name + type) shown above the prompt so devs see the shape without the source.
const fieldStruct = (fields?: Field[]): string | null =>
  fields === undefined ? null : fields.length === 0 ? "{ }" : `{ ${fields.map((f) => `${f.type} ${f.name}`).join("; ")} }`;
function StructHint({ label, name, fields }: { label: string; name?: string; fields?: Field[] }) {
  const s = fieldStruct(fields);
  if (s === null) return null;
  return <Text>  <Text dimColor>{label}</Text> <Text color={theme.brand}>{name}</Text> <Text color={theme.info}>{s}</Text></Text>;
}

type Field = { name: string; type: string };
type Entry = { kind: "fn" | "proc"; inputType: number; inputSize: number; outputSize: number; name?: string; in?: string; out?: string; inFields?: Field[]; outFields?: Field[] };
type Stage = "loading" | "contract" | "entry" | "input" | "output" | "amount" | "seed" | "running" | "done";

export function CallInteractive({ rpcBase, seed }: { rpcBase: string; seed?: string }) {
  const { exit } = useApp();
  const [stage, setStage] = useState<Stage>("loading");
  const [contracts, setContracts] = useState<DynContract[]>([]);
  const [idl, setIdl] = useState<Idl>({});
  const [sel, setSel] = useState<{ c?: DynContract; e?: Entry; input?: string; amount?: string; seed?: string }>({});
  const [result, setResult] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const add = (s: string) => setResult((l) => [...l, s]);

  useEffect(() => {
    (async () => {
      try {
        setIdl(loadIdl());
        const reg = await new LiteRpc(rpcBase).dynRegistry();
        setContracts((reg.contracts ?? []).filter((c) => c.armed)); // only deployed slots, not free ones
        setStage("contract");
      } catch (e: any) { add("ERROR: " + String(e?.message ?? e)); setStage("done"); }
    })();
  }, []);
  useEffect(() => { if (stage === "done") { const t = setTimeout(() => exit(), 50); return () => clearTimeout(t); } }, [stage]);

  // ---- run the selected call ----
  const run = async (s: typeof sel) => {
    setStage("running");
    try {
      const rpc = new LiteRpc(rpcBase);
      const idx = s.c!.index, e = s.e!;
      add("≡ " + equivCmd(s.c!, e, s));   // the non-interactive equivalent — copy-paste to repeat this call
      if (e.kind === "fn") {
        const out = await callFunction(rpc, idx, e.inputType, s.input ?? "", e.out ?? "");
        add(`${labelFor(s.c!, e)} -> ${JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
      } else {
        const ti: any = await rpc.tickInfo();
        const tick = (ti.tick ?? 0) + TX_TICK_OFFSET;
        // confirm=true: wait until the tx is actually processed so the user sees success/dropped, not just "broadcast".
        const r = await invokeProcedure({
          seed: await resolveSeed(rpc, s.seed || seed), rpcBase, contractIndex: idx, procId: e.inputType,
          amount: Number(s.amount ?? 0), inFmt: s.input ?? "", tick, confirm: true, rpc,
          onProgress: ({ tick: net, target }) => setStatus(`confirming · tick ${net} → ${target}${net < target ? ` (${target - net} to go)` : " · processing"}`),
        });
        setStatus("");
        const verdict = !r.ok ? `FAIL ${r.message ?? r.code ?? ""}`
          : r.confirmed && r.included ? "processed ✓" : r.confirmed && !r.included ? "DROPPED — not included"
          : "broadcast (unconfirmed — no tx-status addon or timed out)";
        let ne = "";   // surface the contract's last trap reason if it failed
        try { const c2 = (await rpc.dynRegistry()).contracts?.find((x) => x.index === idx); if (c2?.lastError) ne = ` · contract error: ${c2.lastError}`; } catch {}
        add(`${labelFor(s.c!, e)} @tick ${tick}: ${verdict}  ${r.txId ?? ""}${ne}`);
      }
    } catch (e: any) { add("ERROR: " + String(e?.message ?? e)); }
    setStage("done");
  };

  // Skip prompts the IDL already answers: no input prompt when the input struct has zero fields (in===""), no
  // output prompt when the out fmt is known. A no-arg getter (in="", out known) thus runs with zero prompts.
  const noInput = (e: Entry) => e.in !== undefined && e.in.trim() === "";
  const startEntry = (e: Entry) => {
    const ns = { ...sel, e, input: "" };
    setSel(ns);
    if (!noInput(e)) { setStage("input"); return; }
    if (e.kind === "fn") { if (e.out !== undefined) run(ns); else setStage("output"); }
    else setStage("amount");
  };
  const afterInput = (ns: typeof sel) => {
    if (ns.e!.kind === "fn") { if (ns.e!.out !== undefined) run(ns); else setStage("output"); }
    else setStage("amount");
  };

  const labelFor = (c: DynContract, e: Entry) => `${nameOf(c)}.${e.name ?? (e.kind + "#" + e.inputType)}`;
  // the equivalent non-interactive command (name + entry both accept name-or-number in `qinit call`)
  const equivCmd = (c: DynContract, e: Entry, s: typeof sel) => {
    const entry = e.name ?? e.inputType;
    const parts = ["qinit call", e.kind === "fn" ? "--fn" : "--proc", String(nameOf(c)), String(entry)];
    if ((s.input ?? "").trim()) parts.push(`--in "${s.input!.trim()}"`);
    if (e.kind === "fn" && (e.out ?? "").trim()) parts.push(`--out "${e.out!.trim()}"`);
    if (e.kind === "proc" && Number(s.amount ?? 0) > 0) parts.push(`--amount ${s.amount}`);
    return parts.join(" ");
  };
  const nameOf = (c: DynContract) => c.name || idl[String(c.index)]?.name || `contract ${c.index}`;

  // ---- entries for the chosen contract (registry truth, merged with IDL names/formats) ----
  // names + in/out fmts: prefer the local qinit.idl.json, else derive from the node-stored contract source
  // (dyn-registry) via extractIdl — so the picker auto-fills in/out even without a local IDL.
  const entriesFor = (c: DynContract): Entry[] => {
    const di = idl[String(c.index)];
    let src: { functions?: Record<string, any>; procedures?: Record<string, any> } | null = null;
    try { if (c.source) src = extractIdl(c.source, c.name || "Contract"); } catch {}
    const fnIdl = (it: number) => di?.functions?.[String(it)] ?? src?.functions?.[String(it)];
    const pcIdl = (it: number) => di?.procedures?.[String(it)] ?? src?.procedures?.[String(it)];
    const fns: Entry[] = (c.functions ?? []).map((f) => ({ kind: "fn", ...f, name: fnIdl(f.inputType)?.name, in: fnIdl(f.inputType)?.in, out: fnIdl(f.inputType)?.out, inFields: fnIdl(f.inputType)?.inFields, outFields: fnIdl(f.inputType)?.outFields }));
    const pcs: Entry[] = (c.procedures ?? []).map((p) => ({ kind: "proc", ...p, name: pcIdl(p.inputType)?.name, in: pcIdl(p.inputType)?.in, inFields: pcIdl(p.inputType)?.inFields }));
    return [...fns, ...pcs];
  };

  const wrap = (el: React.ReactNode) => <Box flexDirection="column"><Header cmd="call" />{el}</Box>;

  if (stage === "loading") return wrap(<Spinner label="loading registry" />);
  if (stage === "running") return wrap(<Spinner label={status || "calling"} />);
  if (stage === "done")
    return wrap(
      <Panel title="result" color={theme.ok}>
        {result.map((l, i) => (
          <Text key={i} color={l.startsWith("ERROR") || l.includes("FAIL") ? theme.err : l.includes("->") || l.includes(": ok") ? theme.ok : undefined}>{l}</Text>
        ))}
      </Panel>,
    );

  if (stage === "contract")
    return wrap(<Select label="Pick a deployed contract:" items={contracts.map((c) => ({ label: `${nameOf(c)}  [idx ${c.index}] ${c.constructed ? "✓" : "armed"}  ${c.functions.length} fn / ${c.procedures.length} proc`, value: c }))} onSelect={(c) => { setSel({ c }); setStage("entry"); }} />);

  if (stage === "entry") {
    const items = entriesFor(sel.c!).map((e) => ({ label: `${e.kind === "fn" ? "fn  " : "proc"} ${e.name ?? "#" + e.inputType}  (${noInput(e) ? "no input" : "in " + e.inputSize + "B"}${e.kind === "fn" ? ", out " + e.outputSize + "B" : ""})`, value: e }));
    return wrap(<Select label={`${nameOf(sel.c!)} — pick a function/procedure:`} items={items} onSelect={(e) => startEntry(e)} />);
  }

  if (stage === "input")
    return wrap(
      <Box flexDirection="column">
        <StructHint label="input " name={`${sel.e!.name ?? sel.e!.kind + "#" + sel.e!.inputType}_input`} fields={sel.e!.inFields} />
        {/* input is never auto-filled — dev fills the values themselves (output below is auto-filled) */}
        <TextPrompt label={`input (${sel.e!.kind === "fn" ? "values+type, e.g. 5uint64; empty=none" : "values+type"})`} initial="" complete={completeType} onSubmit={(input) => { const ns = { ...sel, input }; setSel(ns); afterInput(ns); }} />
      </Box>,
    );

  if (stage === "output")
    return wrap(
      <Box flexDirection="column">
        <StructHint label="output" name={`${sel.e!.name ?? sel.e!.kind + "#" + sel.e!.inputType}_output`} fields={sel.e!.outFields} />
        <TextPrompt label="output format (types only, e.g. uint64 or { id, uint16 })" initial={sel.e!.out ?? ""} complete={completeType} onSubmit={(out) => { const ns = { ...sel, out } as any; setSel(ns); run(ns); }} />
      </Box>,
    );

  // amount is the last prompt — seed is auto-resolved (saved pick > node funded > default), no prompt.
  if (stage === "amount")
    return wrap(<TextPrompt label="amount (qus)" initial="0" onSubmit={(amount) => { const ns = { ...sel, amount }; setSel(ns); run(ns); }} />);

  return null;
}
