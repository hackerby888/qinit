import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { LiteRpc, type DynContract } from "@qinit/core";
import { callFunction, invokeProcedure } from "@qinit/proto";
import { existsSync, readFileSync } from "node:fs";
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

// Single-line text prompt (chars / backspace / enter).
function TextPrompt({ label, initial, onSubmit }: { label: string; initial?: string; onSubmit: (v: string) => void }) {
  const [v, setV] = useState(initial ?? "");
  useInput((input, key) => {
    if (key.return) onSubmit(v);
    else if (key.backspace || key.delete) setV((p) => p.slice(0, -1));
    else if (input && !key.ctrl && !key.meta) setV((p) => p + input);
  });
  return (
    <Box flexDirection="column">
      <Text><Text color={theme.accent} bold>? </Text><Text bold>{label}</Text></Text>
      <Text>  <Text color={theme.brand}>❯ </Text><Text color={theme.ok}>{v}</Text><Text inverse> </Text></Text>
    </Box>
  );
}

type Entry = { kind: "fn" | "proc"; inputType: number; inputSize: number; outputSize: number; name?: string; in?: string; out?: string };
type Stage = "loading" | "contract" | "entry" | "input" | "output" | "amount" | "seed" | "running" | "done";

export function CallInteractive({ rpcBase, seed }: { rpcBase: string; seed?: string }) {
  const { exit } = useApp();
  const [stage, setStage] = useState<Stage>("loading");
  const [contracts, setContracts] = useState<DynContract[]>([]);
  const [idl, setIdl] = useState<Idl>({});
  const [sel, setSel] = useState<{ c?: DynContract; e?: Entry; input?: string; amount?: string; seed?: string }>({});
  const [result, setResult] = useState<string[]>([]);
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
      if (e.kind === "fn") {
        const out = await callFunction(rpc, idx, e.inputType, s.input ?? "", e.out ?? "");
        add(`${labelFor(s.c!, e)} -> ${JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
      } else {
        const ti: any = await rpc.tickInfo();
        const tick = (ti.tick ?? 0) + 8;
        const r = await invokeProcedure({ seed: s.seed || seed || (await rpc.fundedSeed()) || "a".repeat(55), rpcBase, contractIndex: idx, procId: e.inputType, amount: Number(s.amount ?? 0), inFmt: s.input ?? "", tick });
        add(`${labelFor(s.c!, e)} @tick ${tick}: ${r.ok ? "ok " + (r.txId ?? "").slice(0, 16) : "FAIL " + (r.message ?? r.code)}`);
      }
    } catch (e: any) { add("ERROR: " + String(e?.message ?? e)); }
    setStage("done");
  };

  const labelFor = (c: DynContract, e: Entry) => `${nameOf(c)}.${e.name ?? (e.kind + "#" + e.inputType)}`;
  const nameOf = (c: DynContract) => c.name || idl[String(c.index)]?.name || `contract ${c.index}`;

  // ---- entries for the chosen contract (registry truth, merged with IDL names/formats) ----
  const entriesFor = (c: DynContract): Entry[] => {
    const di = idl[String(c.index)];
    const fns: Entry[] = (c.functions ?? []).map((f) => ({ kind: "fn", ...f, name: di?.functions?.[String(f.inputType)]?.name, in: di?.functions?.[String(f.inputType)]?.in, out: di?.functions?.[String(f.inputType)]?.out }));
    const pcs: Entry[] = (c.procedures ?? []).map((p) => ({ kind: "proc", ...p, name: di?.procedures?.[String(p.inputType)]?.name, in: di?.procedures?.[String(p.inputType)]?.in }));
    return [...fns, ...pcs];
  };

  const wrap = (el: React.ReactNode) => <Box flexDirection="column"><Header cmd="call" />{el}</Box>;

  if (stage === "loading") return wrap(<Spinner label="loading registry" />);
  if (stage === "running") return wrap(<Spinner label="calling" />);
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
    const items = entriesFor(sel.c!).map((e) => ({ label: `${e.kind === "fn" ? "fn  " : "proc"} ${e.name ?? "#" + e.inputType}  (in ${e.inputSize}B${e.kind === "fn" ? ", out " + e.outputSize + "B" : ""})`, value: e }));
    return wrap(<Select label={`${nameOf(sel.c!)} — pick a function/procedure:`} items={items} onSelect={(e) => { setSel((s) => ({ ...s, e })); setStage("input"); }} />);
  }

  if (stage === "input")
    return wrap(<TextPrompt label={`input (${sel.e!.kind === "fn" ? "values+type, e.g. 5uint64; empty=none" : "values+type"})`} initial={sel.e!.in ?? ""} onSubmit={(input) => { const ns = { ...sel, input }; setSel(ns); setStage(sel.e!.kind === "fn" ? "output" : "amount"); }} />);

  if (stage === "output")
    return wrap(<TextPrompt label="output format (types only, e.g. uint64 or { id, uint16 })" initial={sel.e!.out ?? ""} onSubmit={(out) => { const ns = { ...sel, out } as any; setSel(ns); run(ns); }} />);

  if (stage === "amount")
    return wrap(<TextPrompt label="amount (qus)" initial="0" onSubmit={(amount) => { setSel((s) => ({ ...s, amount })); setStage("seed"); }} />);

  if (stage === "seed")
    return wrap(<TextPrompt label="signer seed (55 lowercase)" initial={seed ?? ""} onSubmit={(sd) => { const ns = { ...sel, seed: sd }; setSel(ns); run(ns); }} />);

  return null;
}
