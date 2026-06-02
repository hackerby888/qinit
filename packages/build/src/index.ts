// qinit build: contract .h -> .so + K12 hash + undefined-QPI-symbol report.
// The undefined-symbol list drives which QpiContext forwarders lite_dyn_abi.h still needs.
import { statSync, readFileSync } from "node:fs";
import { compile, type BuildOpts } from "./recipe";
import { extractIdl, type ContractIdl } from "./idl";
import { k12Hex } from "@qinit/core";

export type { BuildOpts } from "./recipe";
export { extractIdl } from "./idl";
export type { ContractIdl, IdlEntry } from "./idl";

export interface BuildResult {
  ok: boolean;
  so?: string;
  size?: number;
  hash?: string;
  undef?: string[];
  idl?: ContractIdl;
  stderr?: string;
}

export async function buildContract(o: BuildOpts): Promise<BuildResult> {
  const c = await compile(o);
  if (!c.ok) return { ok: false, so: c.so, stderr: c.stderr };
  const size = statSync(c.so).size;
  let hash: string | undefined;
  try {
    hash = await k12Hex(new Uint8Array(readFileSync(c.so)));
  } catch {
    // Works in dev; pending in the --compile binary (the libFourQ_K12 wasm inits
    // QubicHelper's crypto instance, not a second direct import). Fix in M2 (deploy
    // needs the hash) — likely route K12 through the helper's instance or vendor KT128.
    hash = undefined;
  }
  const undef = await undefinedQpiSymbols(c.so);
  let idl: ContractIdl | undefined;
  try { idl = extractIdl(readFileSync(o.contractPath, "utf8"), o.name); } catch { idl = undefined; }
  return { ok: true, so: c.so, size, hash, undef, idl };
}

// QPI symbols left unresolved in the .so — must be provided by lite_dyn_abi.h
// (resolved at dlopen via the host vtable; missing ones fail at load, not build).
async function undefinedQpiSymbols(so: string): Promise<string[]> {
  const p = Bun.spawn(["nm", "-D", "-u", "-C", so], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const re = /(QPI::|QpiContext|__qpi|__log|__beginFunction|__endFunction|__markContract|__pauseLog|__resumeLog|__acquireScratch|__releaseScratch|K12)/;
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("U ") && re.test(l))
    .map((l) => l.slice(2).trim());
}
