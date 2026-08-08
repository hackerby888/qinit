import { useEffect, useState } from "react";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Box, Text, useApp } from "ink";
import {
  DEFAULT_RPC_BASE,
  LiteRpc,
  resolveTrapBacktrace,
  formatTrapBacktrace,
  type DebugEntry,
} from "@qinit/core";
import { activeNodeScratchDir } from "../../ops/node";
import {
  callFunction,
  invokeProcedure,
  encodeInput,
  encodeInputJson,
  zeroInputFormat,
  TX_TICK_OFFSET,
} from "@qinit/proto";
import {
  AbiTypeKind,
  type ContractEntry,
} from "@qinit/proto/contract-idl";
import { extractIdl } from "@qinit/build";
import {
  describeTrace,
  fmtVal,
  type DecodedTrace,
} from "../../trace/format";
import { TraceView } from "../../trace/views";
import { CallInteractive } from "./call-interactive";
import {
  loadConfig,
  loadConfiguredQpiHeader,
  resolveSeed,
} from "../../config";
import { loadContracts, resolveContract } from "../../contracts/registry";
import { contractIdlForSlot, loadContractIdlFile } from "../../contracts/idl-file";
import { Header, Spinner, Status, Bar, theme } from "../../ui";
import { invalidArgs, type CommandArguments } from "../../args";

type Result = {
  ok: boolean | null;
  label: string;
  detail?: string;
  rows?: [string, string][];
  err?: string;
};
type Trace = { e: DebugEntry; name: string; view: DecodedTrace };
type Confirm = { start: number; net: number; target: number };
type CallMode = "fn" | "proc";

// Non-interactive forms (qubic-cli style):
//   qinit call --fn   <idx> <functionId>   --in "<fmt>" --out "<fmt>"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function Call({ commandArgs }: { commandArgs: CommandArguments }) {
  const fn = commandArgs.has("fn");
  const proc = commandArgs.has("proc");
  if (fn && proc) {
    invalidArgs("choose either --fn or --proc");
  }

  const mode = fn ? "fn" : proc ? "proc" : undefined;
  const contract = commandArgs.positionals[0];
  const entryName = commandArgs.positionals[1];
  if (mode && (!contract || !entryName)) {
    invalidArgs(`${mode} requires <contract> and <entry>`);
  }
  const rpcBaseUrl = commandArgs.get("rpc") || loadConfig().rpc || DEFAULT_RPC_BASE;
  if (!mode) {
    return <CallInteractive rpcBaseUrl={rpcBaseUrl} seed={commandArgs.get("seed")} />;
  }
  return (
    <CallOneShot
      commandArgs={commandArgs}
      mode={mode}
      contract={contract!}
      entryName={entryName!}
      rpcBaseUrl={rpcBaseUrl}
    />
  );
}

function CallOneShot({
  commandArgs,
  mode,
  contract,
  entryName,
  rpcBaseUrl,
}: {
  commandArgs: CommandArguments;
  mode: CallMode;
  contract: string;
  entryName: string;
  rpcBaseUrl: string;
}) {
  const { exit } = useApp();
  const inputJson = commandArgs.get("args");
  const inputFormat = commandArgs.get("in");
  const outputFormat = commandArgs.get("out");
  const showAll = commandArgs.has("all");
  const wantTrace = commandArgs.has("trace");
  const settle = !commandArgs.has("no-settle");
  const seed = commandArgs.get("seed");
  const amount = commandArgs.get("amount");
  const [result, setResult] = useState<Result | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [note, setNote] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const rpc = new LiteRpc(rpcBaseUrl);
        const idlFile = loadContractIdlFile();

        // contract: resolve a name or index across user-deployed (first) then built-in system contracts.
        const sets = await loadContracts(rpc);
        const rc = resolveContract(contract, sets);
        if (!rc)
          throw new Error(
            `no contract '${contract}' (deployed or system — run \`qinit node run\` to load system contracts)`,
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
        let entries = mode === "fn" ? contractIdl?.functions : contractIdl?.procedures;
        if ((!entries || entries.length === 0) && rc.source) {
          contractIdl = extractIdl(rc.source, rc.name, {
            slot: idx,
            qpiHeader: loadConfiguredQpiHeader(),
          });
          entries = mode === "fn" ? contractIdl.functions : contractIdl.procedures;
        }
        entries ??= [];
        let entry = Number(entryName);
        let entryIdl: ContractEntry | undefined = entries.find(
          (candidate) => candidate.inputType === entry,
        );
        if (Number.isNaN(entry)) {
          entryIdl = entries.find(
            (candidate) =>
              candidate.name.toLowerCase() === entryName.toLowerCase(),
          );
          if (!entryIdl) {
            throw new Error(
              `no ${mode} named '${entryName}' on contract ${idx} (no local IDL and node has no source for this slot)`,
            );
          }
          entry = entryIdl.inputType;
        }
        // --args JSON encodes through the IDL schema; otherwise use raw --in format.
        let input: Uint8Array;
        if (inputJson !== undefined) {
          if (!entryIdl) {
            throw new Error(
              `--args needs the input schema for ${mode} ${idx}/${entry} (build/deploy locally, or the node must have the contract source)`,
            );
          }
          try {
            input = await encodeInputJson(
              entryIdl.input,
              JSON.parse(inputJson),
            );
          } catch (er: any) {
            throw new Error("--args: " + String(er?.message ?? er));
          }
        } else {
          try {
            input = await encodeInput(inputFormat ?? entryIdl?.input.format ?? "");
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
                z = zeroInputFormat(entryIdl.input);
              }
            } catch {}
            throw new Error(
              `bad input: ${enc?.message ?? enc}${z ? `\nall-zero sample: ${z}` : ""}`,
            );
          }
        }

        // --trace: capture the call in the node debug ring. Enable + note the latest seq BEFORE dispatch.
        // Entry seq is 1-based on both backends, so 0 means "everything captured from here on".
        let sinceSeq = 0;
        const traceSrc = rc.source;
        const traceName = rc.name;
        if (wantTrace) {
          try {
            await rpc.setDebug(true);
            sinceSeq = ((await rpc.debugTrace(0, 500)).entries ?? []).reduce(
              (mx, en) => Math.max(mx, en.seq),
              0,
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
            const log = join(activeNodeScratchDir(), "node.log");
            if (existsSync(log)) {
              const bt = resolveTrapBacktrace(readFileSync(log, "utf8"), { lineMapPath });
              if (bt?.frames.length) return formatTrapBacktrace(bt);
            }
          } catch {}
          return raw;
        };
        const label = `${contract}.${entryIdl?.name ?? (mode === "fn" ? "fn#" : "proc#") + entry}`;

        if (mode === "fn") {
          const out = await callFunction(
            rpc,
            idx,
            entry,
            input,
            outputFormat ?? entryIdl?.output ?? "",
          );
          const empty = out == null || (typeof out === "object" && Object.keys(out).length === 0);
          const ne = empty ? await nodeErr() : "";
          setResult({
            ok: ne ? false : true,
            label,
            rows: [["out", fmtVal(out, showAll)]],
            err: await enrichErr(ne),
          });
        } else {
          const tickInfo = await rpc.tickInfo();
          const tick = tickInfo.tick + TX_TICK_OFFSET;
          const r = await invokeProcedure({
            seed: await resolveSeed(rpc, seed),
            rpcBaseUrl: rpcBaseUrl,
            contractIndex: idx,
            procedureId: entry,
            amount: Number(amount ?? 0),
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
                  x.kind === (mode === "fn" ? 0 : 1) &&
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
