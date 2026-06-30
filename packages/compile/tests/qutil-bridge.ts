// Shared bridge for driving the upstream contract_qutil.cpp gtest corpus against deployable QUTIL+QX
// wasm. The runner (clang) is mode-independent; only the deployed contract wasm swaps between backends.
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sim, KIND, type Contract } from "@qinit/engine";
import { compileContract, loadQpiHeader, type CompileResult } from "../src/index";
import { buildContract } from "@qinit/build";

export const CORE = "/home/kali/Projects/core-lite";
export const QUTIL_IDX = 4;
export const QX_IDX = 1;

export interface TR {
  name: string;
  passed: boolean;
  message: string;
}

// The lite ContractTesting shim — injected ahead of the stripped contract_qutil.cpp body. Provides the same
// class + free-function surface the upstream test uses, but every operation is a "thost" import bound in JS.
export const SHIM = String.raw`
#include <vector>
#include <set>
#include <map>
#include <unordered_map>
#include <string>
#include <algorithm>
#define TQ(n) __attribute__((import_module("thost"), import_name(#n)))
extern "C" {
TQ(q_reset)   void         bq_reset();
TQ(q_init)    void         bq_init(unsigned int idx);
TQ(q_invoke)  unsigned int bq_invoke(unsigned int idx, unsigned int it, const void* in, unsigned int inLen, long long amount, const void* origin32, void* out, unsigned int outCap);
TQ(q_query)   unsigned int bq_query(unsigned int idx, unsigned int it, const void* in, unsigned int inLen, void* out, unsigned int outCap);
TQ(q_sysproc) void         bq_sysproc(unsigned int idx, unsigned int sp);
TQ(q_fund)    void         bq_fund(const void* id32, long long amount);
TQ(q_balance) long long    bq_balance(const void* id32);
TQ(q_shares)  long long    bq_shares(const void* issuer32, unsigned long long assetName);
TQ(q_possessed) long long  bq_possessed(unsigned long long name, const void* issuer32, const void* owner32, const void* possessor32, unsigned int om, unsigned int pm);
TQ(q_spectrum)  int         bq_spectrum(const void* id32);
TQ(q_decrease)  void        bq_decrease(int idx, long long amount);
}
#undef TQ

enum SystemProcedureID { INITIALIZE = 0, BEGIN_EPOCH = 1, END_EPOCH = 2, BEGIN_TICK = 3, END_TICK = 4 };

class ContractTesting {
public:
    ContractTesting() { bq_reset(); }
    void initEmptySpectrum() {}
    void initEmptyUniverse() {}

    template <typename InputType, typename OutputType>
    unsigned int callFunction(unsigned int contractIndex, unsigned short fnInputType, const InputType& input, OutputType& output, bool checkInputSize = true, bool expectSuccess = true) const {
        bq_query(contractIndex, fnInputType, &input, sizeof(input), &output, sizeof(output));
        return 0;
    }

    template <typename InputType, typename OutputType>
    bool invokeUserProcedure(unsigned int contractIndex, unsigned short procInputType, const InputType& input, OutputType& output, const QPI::id& user, QPI::sint64 amount, bool checkInputSize = true, bool expectSuccess = true) {
        setMem(&output, sizeof(output), 0);
        bq_invoke(contractIndex, procInputType, &input, sizeof(input), (long long)amount, &user, &output, sizeof(output));
        return true;
    }

    void callSystemProcedure(unsigned int contractIndex, SystemProcedureID sysProcId, bool expectSuccess = true) {
        bq_sysproc(contractIndex, (unsigned int)sysProcId);
    }
};

// Free helpers the upstream test calls at file scope.
static inline void increaseEnergy(const QPI::id& who, QPI::sint64 amount) { bq_fund(&who, (long long)amount); }
static inline long long getBalance(const QPI::id& who) { return bq_balance(&who); }
static inline int spectrumIndex(const QPI::id& who) { return bq_spectrum(&who); }
static inline bool decreaseEnergy(int idx, QPI::sint64 amount) { bq_decrease(idx, (long long)amount); return true; }
static inline QPI::sint64 numberOfShares(const QPI::Asset& a) { return bq_shares(&a.issuer, a.assetName); }
static inline unsigned long long assetNameFromString(const char* s) { unsigned long long n = 0; for (int i = 0; i < 8 && s[i]; ++i) n |= (unsigned long long)(unsigned char)s[i] << (8 * i); return n; }
static inline long long numberOfPossessedShares(unsigned long long name, const QPI::id& issuer, const QPI::id& owner, const QPI::id& possessor, unsigned int om, unsigned int pm) { return bq_possessed(name, &issuer, &owner, &possessor, om, pm); }

#define INIT_CONTRACT(name) bq_init(name##_CONTRACT_INDEX)
`;

export function wasiAvailable(): boolean {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project");
    return existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
}

function calleeIdlFrom(name: string, index: number, r: CompileResult) {
  const fns = Object.fromEntries(r.idl.functions.map((f) => [f.name, { inputType: f.inputType, inSize: f.inSize, outSize: f.outSize }]));
  const procs = Object.fromEntries(r.idl.procedures.map((p) => [p.name, { inputType: p.inputType, inSize: p.inSize, outSize: p.outSize }]));
  return { name, index, functions: fns, procedures: procs };
}

// Phase 0: the clang runner wasm (test logic + a dead QUTIL copy for types). Built once, mode-independent.
export async function buildRunner(core: string): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "qutil-upstream-"));
  const rawTest = readFileSync(`${core}/test/contract_qutil.cpp`, "utf8");
  const strippedTest = rawTest.replace(/^\s*#include\s+"contract_testing\.h".*$/m, "");
  const testSource = `${SHIM}\n${strippedTest}`;

  const built = await buildContract({
    contractPath: `${core}/src/contracts/QUtil.h`, name: "QUTIL", stateType: "QUTIL", slot: QUTIL_IDX,
    corePath: core, outDir: dir, arenaSz: 8 * 1024 * 1024, skipVerify: true,
    testSource, testPath: "contract_qutil.cpp",
  });
  if (!built.ok) {
    const lines = (built.stderr ?? "").split("\n").filter((l) => / error:| undefined | cannot |fatal|ld\.lld|wasm-ld/i.test(l));
    throw new Error("runner build failed:\n" + lines.slice(0, 30).join("\n"));
  }
  return new Uint8Array(readFileSync(built.so!));
}

// Phase 1 (ours): QUTIL+QX compiled by our TS compiler. QUTIL gets QX's IDL + source so its
// CALL_OTHER_CONTRACT(QX, ...) calls resolve.
export async function buildContractsOurs(core: string): Promise<Record<number, Uint8Array>> {
  const headers = loadQpiHeader(core);
  const qutilSrc = readFileSync(`${core}/src/contracts/QUtil.h`, "utf8");
  const qxSrc = readFileSync(`${core}/src/contracts/Qx.h`, "utf8");

  const mineQx = await compileContract({ source: qxSrc, name: "QX", slot: QX_IDX, qpiHeader: headers, arenaSz: 8 * 1024 * 1024 });
  const callees = [calleeIdlFrom("QX", QX_IDX, mineQx)];
  const calleeSources = [{ name: "QX", source: qxSrc }];
  const mineQutil = await compileContract({ source: qutilSrc, name: "QUTIL", slot: QUTIL_IDX, qpiHeader: headers, arenaSz: 8 * 1024 * 1024, callees, calleeSources });

  const qxErrs = mineQx.diagnostics.filter((d) => d.severity === "error");
  const qutilErrs = mineQutil.diagnostics.filter((d) => d.severity === "error");
  if (qxErrs.length || qutilErrs.length) {
    throw new Error("ours compile errors: QX=" + qxErrs.length + " QUTIL=" + qutilErrs.length);
  }
  return { [QUTIL_IDX]: mineQutil.wasm, [QX_IDX]: mineQx.wasm };
}

// Phase 1 (native): added in Task 2. Stub keeps the production test's import resolvable.
export async function buildContractsNative(_core: string): Promise<Record<number, Uint8Array>> {
  throw new Error("native backend not implemented yet (Task 2)");
}

// Instantiate the runner wasm, bind the thost table to a fresh Sim with the contracts deployed, drive each test.
export async function runUpstream(runnerWasm: Uint8Array, contracts: Record<number, Uint8Array>): Promise<TR[]> {
  const dec = new TextDecoder();
  const results: TR[] = [];
  let sim: Sim;
  let handles: Record<number, Contract> = {};
  let spectrumIds: string[] = [];
  let spectrumBytes: Uint8Array[] = [];
  let runner: WebAssembly.Instance;
  const mem = () => new Uint8Array((runner.exports.memory as WebAssembly.Memory).buffer);
  const read = (off: number, len: number) => mem().slice(off >>> 0, (off >>> 0) + (len >>> 0));
  const write = (off: number, b: Uint8Array) => mem().set(b, off >>> 0);
  const id32 = (p: number) => read(p, 32);
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const decodeName = (n: bigint): string => {
    let s = "";
    for (let i = 0; i < 8; i++) { const c = Number((n >> BigInt(8 * i)) & 0xffn); if (c) s += String.fromCharCode(c); }
    return s;
  };

  const deployAll = () => {
    sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
    handles = {};
    spectrumIds = [];
    spectrumBytes = [];
    for (const [idx, wasm] of Object.entries(contracts)) handles[Number(idx)] = sim.deploy(Number(idx), wasm);
  };
  deployAll();

  const thost = {
    q_reset: () => { deployAll(); },
    q_init: (_idx: number) => { /* contracts pre-deployed in deployAll */ },
    q_invoke: (idx: number, it: number, inPtr: number, inLen: number, amount: bigint, originPtr: number, outPtr: number, outCap: number): number => {
      const input = read(inPtr, inLen);
      const origin = id32(originPtr);
      // The native harness debits the invocator the reward (decreaseEnergy) before invoking; sim.procedure
      // only credits the contract, so mirror the debit here for faithful fee accounting.
      if (amount > 0n) sim.debit(origin, BigInt(amount));
      const out = sim.procedure(idx >>> 0, it >>> 0, input, { reward: BigInt(amount), invocator: origin, originator: origin });
      const n = Math.min(out.length, outCap >>> 0);
      if (n) write(outPtr, out.subarray(0, n));
      return n >>> 0;
    },
    q_query: (idx: number, it: number, inPtr: number, inLen: number, outPtr: number, outCap: number): number => {
      const out = sim.query(idx >>> 0, it >>> 0, read(inPtr, inLen));
      const n = Math.min(out.length, outCap >>> 0);
      if (n) write(outPtr, out.subarray(0, n));
      return n >>> 0;
    },
    q_sysproc: (idx: number, sp: number) => {
      const c = handles[idx >>> 0];
      if (c && c.hasSysproc(sp >>> 0)) c.invoke(KIND.SYSPROC, sp >>> 0, new Uint8Array(0), { entryPoint: sp >>> 0 });
    },
    q_fund: (idPtr: number, amount: bigint) => { sim.fund(id32(idPtr), BigInt(amount)); },
    q_balance: (idPtr: number): bigint => sim.balance(id32(idPtr)),
    // spectrumIndex/decreaseEnergy: the native harness reduces an entity's energy by spectrum index. Map each
    // queried id to a stable index, then decreaseEnergy(idx, amt) debits it (so the voter-eligibility tests
    // that drop a voter below min_amount actually invalidate the voter).
    q_spectrum: (idPtr: number): number => {
      const h = hex(id32(idPtr));
      let i = spectrumIds.indexOf(h);
      if (i < 0) { i = spectrumIds.length; spectrumIds.push(h); spectrumBytes.push(id32(idPtr)); }
      return i;
    },
    q_decrease: (idx: number, amount: bigint) => { const b = spectrumBytes[idx >>> 0]; if (b) sim.debit(b, BigInt(amount)); },
    q_shares: (issuerPtr: number, _assetName: bigint): bigint => {
      const issuerHex = hex(id32(issuerPtr));
      let sum = 0n;
      for (const a of sim.assetUniverse()) if (a.issuer === issuerHex) for (const h of a.holdings) sum += BigInt(h.shares);
      return sum;
    },
    q_possessed: (name: bigint, issuerPtr: number, ownerPtr: number, possessorPtr: number, om: number, pm: number): bigint =>
      (sim as any).assets.numberOfPossessedShares(BigInt(name), id32(issuerPtr), id32(ownerPtr), id32(possessorPtr), om >>> 0, pm >>> 0),
    // lite_test.h reports each EXPECT_* outcome through thost.t_report.
    t_report: (namePtr: number, nameLen: number, passed: number, msgPtr: number, msgLen: number) => {
      results.push({ name: dec.decode(read(namePtr, nameLen)), passed: (passed >>> 0) !== 0, message: dec.decode(read(msgPtr, msgLen)) });
    },
  };

  // clang routes undefined non-thost symbols (e.g. _rdrand64_step) to module "env".
  let rng = 0x9e3779b97f4a7c15n;
  const env = {
    _rdrand64_step: (outPtr: number): number => {
      rng = (rng * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      new DataView(mem().buffer).setBigUint64(outPtr >>> 0, rng, true);
      return 1;
    },
  };

  // The runner embeds a compiled QUTIL contract module (for types + the test runner) that imports "lhost" for
  // its own qpi.* calls. That copy is dead — driving goes through thost → Sim → my separately-deployed wasm —
  // so any lhost/wasi import is a never-called no-op. Real tables: thost (drives Sim) + env (_rdrand64_step).
  const noopModule = new Proxy({}, { get: () => () => 0 });
  // env carries _rdrand64_step but the compiled-in QUTIL also pulls misc env symbols (addDebugMessageAssert,
  // …) — fall back to a no-op for any name not explicitly provided.
  const envProxy = new Proxy(env, { get: (t, k: string) => (k in t ? (t as any)[k] : () => 0), has: () => true });
  const imports = new Proxy({ thost, env: envProxy } as Record<string, unknown>, {
    get: (t, m: string) => (m in t ? (t as any)[m] : noopModule),
    has: () => true,
  });
  const mod = await WebAssembly.compile(runnerWasm);
  runner = await WebAssembly.instantiate(mod, imports as any);
  (runner.exports._initialize as Function)?.();

  // No tests hang any more (the END_EPOCH ProposalVoting loops and the asset-ownership-iterator loop are both
  // lowered now), so every case runs in-process.
  const count = (runner.exports.test_count as Function)() >>> 0;
  for (let i = 0; i < count; i++) {
    (runner.exports.run_test as Function)(i);
  }
  return results;
}
