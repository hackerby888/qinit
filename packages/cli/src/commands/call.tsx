import { useEffect, useState } from "react";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Box, Text, useApp } from "ink";
import { LiteRpc, resolveTrapBacktrace, formatTrapBacktrace, type DebugEntry } from "@qinit/core";
import { scratchDir } from "../node-ops";
import {
  callFunction,
  invokeProcedure,
  encodeInput,
  encodeInputJson,
  zeroInputFmt,
  TX_TICK_OFFSET,
} from "@qinit/proto";
import {
  AbiTypeKind,
  type ContractEntry,
} from "@qinit/proto/contract-idl";
import { extractIdl } from "@qinit/build";
import { describeTrace, jstr, fmtVal, type TraceView as TraceData } from "../trace-format";
import { TraceView } from "../views";
import { CallInteractive } from "./call-interactive";
import {
  loadConfig,
  loadConfiguredQpiHeader,
  resolveSeed,
} from "../config";
import { loadContracts, resolveContract } from "../contracts";
import { contractIdlForSlot, loadContractIdlFile } from "../idl-file";
import { Header, Spinner, Status, Bar, theme } from "../ui";

type Result = {
  ok: boolean | null;
  label: string;
  detail?: string;
  rows?: [string, string][];
  err?: string;
};
type Trace = { e: DebugEntry; name: string; view: TraceData };
type Confirm = { start: number; net: number; target: number };

// Non-interactive forms (qubic-cli style):
//   qinit call --fn   <idx> <fnId>   --in "<fmt>" --out "<fmt>"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--fn" || a === "--proc") {
      o.mode = a.slice(2);
      o.idx = args[++i];
      o.entry = args[++i];
    } else if (a.startsWith("--")) {
      const next = args[i + 1];
      o[a.slice(2)] = next === undefined || next.startsWith("--") ? "" : args[++i];
    }
  }
  return o;
}

export function Call({ args }: { args: string[] }) {
  const o = parse(args);
  const rpcBase = o.rpc || loadConfig().rpc || "http://127.0.0.1:41841";
  if (o.mode !== "fn" && o.mode !== "proc")
    return <CallInteractive rpcBase={rpcBase} seed={o.seed} />;
  return <CallOneShot o={o} rpcBase={rpcBase} />;
}

function CallOneShot({ o, rpcBase }: { o: Record<string, string>; rpcBase: string }) {
  const { exit } = useApp();
  const [result, setResult] = useState<Result | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [note, setNote] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const rpc = new LiteRpc(rpcBase);
        const idlFile = loadContractIdlFile();

        // contract: resolve a name or index across user-deployed (first) then built-in system contracts.
        const sets = await loadContracts(rpc);
        const rc = resolveContract(String(o.idx), sets);
        if (!rc)
          throw new Error(
            `no contract '${o.idx}' (deployed or system — run \`qinit node run\` to load system contracts)`,
          );
        const idx = rc.index;
        // entry: accept a fn/proc name or an inputType number. Prefer local qinit.idl.json, else derive from the
        // contract source (node dyn-registry source for user contracts, snapshot source for system contracts).
        const localContractIdl = contractIdlForSlot(
          idlFile,
          idx,
          rc.codeHash,
        );
        let contractIdl = localContractIdl;
        let entries = o.mode === "fn" ? contractIdl?.functions : contractIdl?.procedures;
        if ((!entries || entries.length === 0) && rc.source) {
          contractIdl = extractIdl(rc.source, rc.name, {
            slot: idx,
            qpiHeader: loadConfiguredQpiHeader(),
          });
          entries = o.mode === "fn" ? contractIdl.functions : contractIdl.procedures;
        }
        entries ??= [];
        let entry = Number(o.entry);
        let entryIdl: ContractEntry | undefined = entries.find(
          (candidate) => candidate.inputType === entry,
        );
        if (Number.isNaN(entry)) {
          entryIdl = entries.find(
            (candidate) =>
              candidate.name.toLowerCase() === String(o.entry).toLowerCase(),
          );
          if (!entryIdl) {
            throw new Error(
              `no ${o.mode} named '${o.entry}' on contract ${idx} (no local IDL and node has no source for this slot)`,
            );
          }
          entry = entryIdl.inputType;
        }
        // --args JSON encodes through the IDL schema; otherwise use raw --in format.
        let input: Uint8Array;
        if (o.args !== undefined) {
          if (!entryIdl) {
            throw new Error(
              `--args needs the input schema for ${o.mode} ${idx}/${entry} (build/deploy locally, or the node must have the contract source)`,
            );
          }
          try {
            input = await encodeInputJson(
              entryIdl.input,
              JSON.parse(o.args),
            );
          } catch (er: any) {
            throw new Error("--args: " + String(er?.message ?? er));
          }
        } else {
          try {
            input = await encodeInput(o.in ?? entryIdl?.input.format ?? "");
          } catch (enc: any) {
            let z = "";
            try {
              if (
                entryIdl &&
                !(
                  entryIdl.input.kind === AbiTypeKind.STRUCT &&
                  entryIdl.input.fields.length === 0
                )
              ) {
                z = zeroInputFmt(entryIdl.input);
              }
            } catch {}
            throw new Error(
              `bad input: ${enc?.message ?? enc}${z ? `\nall-zero sample: ${z}` : ""}`,
            );
          }
        }

        // --trace: capture the call in the node debug ring. Enable + note the latest seq BEFORE dispatch.
        const wantTrace = o.trace !== undefined;
        // Baseline -1, not 0: entry seq is 0-based, and on a freshly-enabled debug ring (the common case) the
        // first captured entry is seq 0 — `seq > sinceSeq` with sinceSeq=0 would drop it ("no trace captured").
        let sinceSeq = -1;
        const traceSrc = rc.source;
        const traceName = rc.name;
        if (wantTrace) {
          try {
            await rpc.setDebug(true);
            sinceSeq = ((await rpc.debugTrace(0, 500)).entries ?? []).reduce(
              (mx, en) => Math.max(mx, en.seq),
              -1,
            );
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
            const log = join(scratchDir(), "node.log");
            if (existsSync(log)) {
              const bt = resolveTrapBacktrace(readFileSync(log, "utf8"), { lineMapPath });
              if (bt?.frames.length) return formatTrapBacktrace(bt);
            }
          } catch {}
          return raw;
        };
        const label = `${o.idx}.${entryIdl?.name ?? (o.mode === "fn" ? "fn#" : "proc#") + entry}`;

        if (o.mode === "fn") {
          const out = await callFunction(
            rpc,
            idx,
            entry,
            input,
            o.out ?? entryIdl?.output ?? "",
          );
          const empty = out == null || (typeof out === "object" && Object.keys(out).length === 0);
          const ne = empty ? await nodeErr() : "";
          setResult({
            ok: ne ? false : true,
            label,
            rows: [["out", fmtVal(out, o.all !== undefined)]],
            err: await enrichErr(ne),
          });
        } else {
          const ti: any = await rpc.tickInfo();
          const tick = (ti.tick ?? ti.currentTick ?? 0) + TX_TICK_OFFSET;
          const settle = o["no-settle"] === undefined; // default: wait until the proc actually ran; --no-settle to skip
          const r = await invokeProcedure({
            seed: await resolveSeed(rpc, o.seed),
            rpcBase,
            contractIndex: idx,
            procId: entry,
            amount: Number(o.amount ?? 0),
            input,
            tick,
            confirm: settle,
            rpc,
            onProgress: ({ tick: net, target }) =>
              setConfirm((c) => ({ start: c?.start ?? net, net, target })),
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
          setResult({
            ok,
            label,
            detail,
            rows: [
              ["tx", txs],
              ["tick", String(tick)],
            ],
            err: (await enrichErr(await nodeErr())) || (!r.ok ? r.message : undefined),
          });
        }

        if (wantTrace) {
          let te: DebugEntry | undefined;
          for (let i = 0; i < 12 && !te; i++) {
            const t = await rpc.debugTrace(sinceSeq, 200);
            te = (t.entries ?? [])
              .filter(
                (x) =>
                  x.index === idx &&
                  x.seq > sinceSeq &&
                  x.kind === (o.mode === "fn" ? 0 : 1) &&
                  x.entry === entry,
              )
              .pop();
            if (!te) await sleep(700);
          }
          if (te)
            setTrace({
              e: te,
              name: traceName,
              view: await describeTrace(
                te,
                traceSrc,
                traceName,
                rpc,
                traceSrc ? loadConfiguredQpiHeader() : undefined,
              ),
            });
          else setNote("(no trace captured — is the debug toggle available on this node?)");
          try {
            await rpc.setDebug(false);
          } catch {}
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
      if (result?.ok === false) process.exitCode = 1;
      exit();
    }
  }, [done]); // failure -> non-zero for scripts/CI

  const rw = Math.max(2, ...(result?.rows ?? []).map(([k]) => k.length));
  const pct =
    confirm && confirm.target > confirm.start
      ? (confirm.net - confirm.start) / (confirm.target - confirm.start)
      : 1;
  return (
    <Box flexDirection="column">
      <Header cmd="call" />
      {result && (
        <Box flexDirection="column">
          <Status
            ok={result.ok}
            label={result.label}
            detail={result.detail}
            pad={Math.max(14, result.label.length + 2)}
          />
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
          <TraceView e={trace.e} name={trace.name} view={trace.view} />
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
    </Box>
  );
}
