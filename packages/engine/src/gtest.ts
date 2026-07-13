// Run core-lite contract_testing.h-style suites against contracts deployed in an isolated virtual node.
import { Sim } from "./sim";
import { Contract, KIND, dateFields, packDateAndTime } from "./runtime";
import { initK12, k12Bytes } from "./k12";
import { EntityRecord, M256i } from "./wire";

export interface TestResult {
  name: string; // "Suite.Name"
  passed: boolean;
  message: string; // failure detail (empty when passed)
}

// Generic multi-contract test host binding. The runner Wasm is compiled from standard core-lite gtest source;
// `contracts` maps contract-index → deployable Wasm. Every
export async function runContractTesting(
  runnerWasm: Uint8Array,
  contracts: Record<number, Uint8Array>,
  opts: {
    mainSlot?: number;
    onResult?: (r: TestResult) => void | Promise<void>;
    assetNames?: Record<number, string | bigint>;
  } = {},
): Promise<TestResult[]> {
  await initK12();
  // In-runner qpi mutations (a corpus drives contract procedures through its own QpiContext objects) act on
  // behalf of the contract under test; the lhost transfer ABI carries no index, so it must be told.
  const mainSlot = opts.mainSlot ?? Math.max(...Object.keys(contracts).map(Number));
  const dec = new TextDecoder();
  const results: TestResult[] = [];

  let sim: Sim;
  let handles: Record<number, Contract> = {};
  let spectrumIds: string[] = [];
  let spectrumBytes: Uint8Array[] = [];
  let runner: WebAssembly.Instance;
  // State-sync between the runner's getState() shadow buffers and the engine's contract instances. The full
  // state can be hundreds of MB (e.g. QEARN ~214MB), so a per-dispatch full copy is fatal to dispatch-heavy
  const materialized = new Map<number, { dst: number; len: number }>();
  const engineDirty = new Set<number>();
  const touched = new Set<number>();

  const mem = () => new Uint8Array((runner.exports.memory as WebAssembly.Memory).buffer);
  const read = (off: number, len: number) => mem().slice(off >>> 0, (off >>> 0) + (len >>> 0));
  const write = (off: number, b: Uint8Array) => mem().set(b, off >>> 0);
  const id32 = (p: number) => read(p, 32);
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

  // Opt-in instrumentation. QINIT_GTEST_TRACE logs entry/exit of every engine dispatch (a dispatch entered
  // but never exited is a contract procedure looping in the engine). QINIT_GTEST_PROF (implied by TRACE)
  const env_ = (globalThis as any).process?.env ?? {};
  const dispTrace = !!env_.QINIT_GTEST_TRACE;
  const prof = dispTrace || !!env_.QINIT_GTEST_PROF;
  const now = () => (globalThis as any).performance?.now?.() ?? 0;
  const stat = { dispN: 0, dispMs: 0, pulls: 0, pullBytes: 0, pullMs: 0 };
  const traceDisp = <T>(label: string, fn: () => T): T => {
    if (!prof) return fn();
    const n = ++stat.dispN;
    if (dispTrace) (globalThis as any).process.stderr.write(`[disp #${n}] > ${label}\n`);
    const t0 = now();
    const r = fn();
    stat.dispMs += now() - t0;
    if (dispTrace) (globalThis as any).process.stderr.write(`[disp #${n}] < ${label}\n`);
    if (prof && n % 5000 === 0) {
      (globalThis as any).process.stderr.write(
        `[gtest-prof] @${n} dispatchMs=${Math.round(stat.dispMs)} pulls=${stat.pulls} pulledMB=${Math.round(stat.pullBytes / (1 << 20))} pullMs=${Math.round(stat.pullMs)}\n`,
      );
    }
    return r;
  };

  // Shared-memory contracts (linked with --import-memory, see recipe.ts sharedMemBase): the module lives
  // inside the runner's memory, so the runner's contractStates[i] pointer IS the live state — the shadow
  const sharedSlots = new Set<number>();
  for (const [idx, wasm] of Object.entries(contracts)) {
    const m = new WebAssembly.Module(wasm as BufferSource);
    if (WebAssembly.Module.imports(m).some((im) => im.module === "env" && im.kind === "memory"))
      sharedSlots.add(Number(idx));
  }
  const runnerMemory = (): WebAssembly.Memory | undefined =>
    runner?.exports?.memory as WebAssembly.Memory | undefined;

  const deployAll = () => {
    // The corpus `system` proxy (epoch / tick / chain clock) mirrors real Qubic's persistent global `system`:
    // constructing a ContractTesting fixture resets spectrum/universe/contract states but never system.epoch/tick.
    const prevEpoch = sim?.epochN,
      prevTick = sim?.tickN,
      prevTimeBase = sim?.timeBaseMs;
    const prevDigest = sim?.prevSpectrumDigestOverride;
    sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
    // Native-harness clock semantics: etalonTick's date fields ARE the chain time and never move on their
    // own — a corpus advances time only by writing them (q_set_datetime). Freeze the per-tick advance.
    sim.tickDuration = 0;
    // Native etalonTick.prevSpectrumDigest is a zero-initialized global the corpus may pin; contracts read
    // exactly that value, not a live digest of the throwaway chain.
    sim.prevSpectrumDigestOverride = prevDigest ?? new Uint8Array(32);
    if (prevEpoch !== undefined) sim.epochN = prevEpoch;
    if (prevTick !== undefined) sim.tickN = prevTick;
    if (prevTimeBase !== undefined) sim.timeBaseMs = prevTimeBase;
    handles = {};
    spectrumIds = [];
    spectrumBytes = [];
    materialized.clear();
    engineDirty.clear();
    touched.clear();
    for (const [idx, wasm] of Object.entries(contracts)) {
      const shared = sharedSlots.has(Number(idx));
      if (shared && !runnerMemory())
        throw new Error(
          `gtest: contract slot ${idx} is a shared-memory build but the runner is not instantiated yet`,
        );
      handles[Number(idx)] = sim.deploy(Number(idx), wasm, shared ? runnerMemory() : undefined);
    }
    // slot -> share-asset ticker (contract_def.h contractDescriptions.assetName) — distributeDividends
    // iterates the possessors of this asset.
    for (const [slot, name] of Object.entries(opts.assetNames ?? {})) {
      sim.setContractAssetName(Number(slot), name as string | bigint);
    }
  };

  // Push back only shadows the test touched since the last flush, and only while the shadow is still in sync
  // with the engine (not behind a mutating dispatch) — pushing a stale shadow would clobber newer engine
  const flushState = () => {
    if (touched.size === 0) return;
    for (const i of touched) {
      const m = materialized.get(i);
      const c = handles[i];
      if (m && c && !engineDirty.has(i))
        syncChunked(mem().subarray(m.dst, m.dst + m.len), c.stateView(m.len));
    }
    touched.clear();
  };

  // After a mutating dispatch the engine state has advanced past every materialized shadow. core-lite's
  // contractStates[i] is a live pointer, so a corpus may cache `auto s = getState()` and read s-> after a
  const EAGER_SYNC_MAX = 4 << 20; // 4 MiB
  const markEngineMoved = () => {
    for (const [i, m] of materialized) {
      const c = handles[i];
      if (!c) continue;
      if (m.len <= EAGER_SYNC_MAX) {
        write(m.dst, c.stateView(m.len));
      } else {
        refreshShadow(m, c);
      }
      touched.add(i);
    }
    engineDirty.clear();
  };

  // Diff-copy between the runner shadow and the engine state (either direction): scan in chunks (native
  // memcmp via Buffer.compare when available) and copy only the chunks that actually changed. A dispatch or
  const SYNC_CHUNK = 1 << 20;
  const Buf = (globalThis as any).Buffer;
  const syncChunked = (src: Uint8Array, dst: Uint8Array) => {
    const len = Math.min(src.length, dst.length);
    const t0 = prof ? now() : 0;
    if (!Buf?.compare) {
      dst.set(src.subarray(0, len));
    } else {
      for (let off = 0; off < len; off += SYNC_CHUNK) {
        const n = Math.min(SYNC_CHUNK, len - off);
        const a = Buf.from(src.buffer, src.byteOffset + off, n);
        const b = Buf.from(dst.buffer, dst.byteOffset + off, n);
        if (Buf.compare(a, b) !== 0) dst.set(src.subarray(off, off + n), off);
      }
    }
    if (prof) {
      stat.pulls++;
      stat.pullBytes += len;
      stat.pullMs += now() - t0;
    }
  };
  const refreshShadow = (m: { dst: number; len: number }, c: Contract) => {
    syncChunked(c.stateView(m.len), mem().subarray(m.dst, m.dst + m.len));
  };

  let dispatchCount = 0; // QINIT_GTEST_PROGRESS: dispatch-rate telemetry for slow/hanging corpora
  const t0Progress = performance.now();

  const thost = {
    q_reset: () => {
      deployAll();
    },
    q_init: (_idx: number) => {
      /* contracts pre-deployed in deployAll */
    },

    // A contract trap (OOB, unreachable) inside a dispatch fails the CURRENT TEST, not the whole corpus run
    // — the native harness likewise contains a contract fault per test. The trap is surfaced on stderr once;
    q_invoke: (
      idx: number,
      it: number,
      inPtr: number,
      inLen: number,
      amount: bigint,
      originPtr: number,
      outPtr: number,
      outCap: number,
    ): number => {
      if (env_.QINIT_GTEST_PROGRESS && ++dispatchCount % 500 === 0) {
        (globalThis as any).process?.stderr?.write?.(
          `[gtest] ${dispatchCount} dispatches (${((performance.now() - t0Progress) / 1000).toFixed(1)}s)\n`,
        );
      }
      flushState();
      const input = read(inPtr, inLen);
      const origin = id32(originPtr);
      if (amount > 0n) sim.debit(origin, BigInt(amount));
      let out: Uint8Array;
      try {
        out = traceDisp(`invoke[${idx >>> 0}:${it >>> 0}]`, () =>
          sim.procedure(idx >>> 0, it >>> 0, input, {
            reward: BigInt(amount),
            invocator: origin,
            originator: origin,
          }),
        );
      } catch (e: any) {
        (globalThis as any).process?.stderr?.write?.(
          `[gtest] invoke[${idx >>> 0}:${it >>> 0}] trapped: ${String(e?.message ?? e).slice(0, 120)}\n`,
        );
        out = new Uint8Array(0);
      }
      const n = Math.min(out.length, outCap >>> 0);
      if (n) write(outPtr, out.subarray(0, n));
      markEngineMoved();
      // QINIT_GTEST_WATCH_SLOT=<n>: one line per invoke with the watched contract's balance — diffing the
      // native vs ours streams pinpoints a corpus's first divergent dispatch.
      if (env_.QINIT_GTEST_WATCH_SLOT) {
        const ws = Number(env_.QINIT_GTEST_WATCH_SLOT);
        const bal = sim.balance((sim as any).contractId(ws));
        // QINIT_GTEST_WATCH_OFF=<byteOff>: also print the u64 at that state offset (e.g. a counter field
        // identified by a snapshot diff).
        let fld = "";
        if (env_.QINIT_GTEST_WATCH_OFF) {
          const off = Number(env_.QINIT_GTEST_WATCH_OFF);
          const c2 = handles[ws];
          if (c2) {
            const sv = c2.stateView(off + 8);
            fld = ` fld=${new DataView(sv.buffer, sv.byteOffset + off, 8).getBigUint64(0, true)}`;
          }
        }
        (globalThis as any).process?.stderr?.write?.(
          `[watch] #${++dispatchCount} it=${it >>> 0} amt=${amount} org=${hex(origin).slice(0, 12)} bal=${bal}${fld}\n`,
        );
        // QINIT_GTEST_SNAP="<dispatchN>:<filePrefix>": dump the watched contract's full state at that
        // dispatch — byte-diffing a native vs ours pair localizes silent state divergence.
        const snap = (env_.QINIT_GTEST_SNAP ?? "") as string;
        if (snap) {
          const [nStr, prefix] = snap.split(":");
          if (dispatchCount === Number(nStr)) {
            const c2 = handles[ws];
            const fs = require("node:fs");
            const f = `${prefix}.${dispatchCount}.bin`;
            if (c2)
              fs.writeFileSync(
                fs.existsSync(f) ? f.replace(/\.bin$/, ".ours.bin") : f,
                c2.stateView(c2.stateSize),
              );
          }
        }
      }
      return n >>> 0;
    },

    q_query: (
      idx: number,
      it: number,
      inPtr: number,
      inLen: number,
      outPtr: number,
      outCap: number,
    ): number => {
      flushState();
      let out: Uint8Array;
      try {
        out = traceDisp(`query[${idx >>> 0}:${it >>> 0}]`, () =>
          sim.query(idx >>> 0, it >>> 0, read(inPtr, inLen)),
        );
      } catch (e: any) {
        (globalThis as any).process?.stderr?.write?.(
          `[gtest] query[${idx >>> 0}:${it >>> 0}] trapped: ${String(e?.message ?? e).slice(0, 120)}\n`,
        );
        out = new Uint8Array(0);
      }
      const n = Math.min(out.length, outCap >>> 0);
      if (n) write(outPtr, out.subarray(0, n));
      return n >>> 0;
    },

    q_sysproc: (idx: number, sp: number) => {
      flushState();
      const c = handles[idx >>> 0];
      try {
        if (c && c.hasSysproc(sp >>> 0))
          traceDisp(`sysproc[${idx >>> 0}:${sp >>> 0}]`, () =>
            c.invoke(KIND.SYSPROC, sp >>> 0, new Uint8Array(0), { entryPoint: sp >>> 0 }),
          );
      } catch (e: any) {
        (globalThis as any).process?.stderr?.write?.(
          `[gtest] sysproc[${idx >>> 0}:${sp >>> 0}] trapped: ${String(e?.message ?? e).slice(0, 120)}\n`,
        );
      }
      markEngineMoved();
      if (env_.QINIT_GTEST_DUMP_ASSETS) {
        (globalThis as any).process.stderr.write(
          `[assets after sysproc ${sp >>> 0}] ${JSON.stringify(sim.assetUniverse())}\n`,
        );
      }
    },

    q_fund: (idPtr: number, amount: bigint) => {
      sim.fund(id32(idPtr), BigInt(amount));
    },
    q_balance: (idPtr: number): bigint => {
      const b = sim.balance(id32(idPtr));
      return typeof b === "bigint" ? b : 0n;
    },
    // notifyContractOfIncomingTransfer(source, dest, amount, type): credit dest + fire its POST_INCOMING_TRANSFER.
    q_notify_pit: (srcPtr: number, dstPtr: number, amount: bigint, type: number) => {
      sim.notifyIncomingTransfer(id32(srcPtr), id32(dstPtr), BigInt(amount), type >>> 0);
    },
    // issueAsset(issuer, name, decimals, unit, shares, mgmt): mint an asset (issuer == invocator path). Returns shares.
    q_issue_asset: (
      issuerPtr: number,
      name: bigint,
      decimals: number,
      shares: bigint,
      unit: bigint,
      slot: number,
    ): bigint => {
      const issuer = id32(issuerPtr);
      return (sim as any).assets.issueAsset(
        slot >>> 0,
        BigInt.asUintN(64, name),
        issuer,
        decimals,
        BigInt.asUintN(64, shares),
        BigInt.asUintN(64, unit),
        issuer,
      ) as bigint;
    },
    // issueContractShares(googletest): mint a contract's NULL_ID-issuer shares (qxSlot = QX), then move each
    // owner's slice from the NULL_ID holder to the owner. transferShareOwnershipAndPossession returns <0 on
    q_mint_contract_shares: (name: bigint, shares: bigint, qxSlot: number): void => {
      (sim as any).assets.mintContractShares(
        qxSlot >>> 0,
        BigInt.asUintN(64, name),
        BigInt.asUintN(64, shares),
      );
    },
    q_transfer_shares: (
      name: bigint,
      srcPtr: number,
      dstPtr: number,
      shares: bigint,
      qxSlot: number,
    ): bigint => {
      const src = id32(srcPtr);
      const zero = new Uint8Array(32);
      return (sim as any).assets.transferShareOwnershipAndPossession(
        qxSlot >>> 0,
        BigInt.asUintN(64, name),
        zero,
        src,
        src,
        BigInt.asUintN(64, shares),
        id32(dstPtr),
      ) as bigint;
    },
    // transferShareOwnershipAndPossession free helper (index-based): move `shares` of asset (issuer, name) from the
    // owner/possessor holding to newOwner, managed by mgmt. Returns the source's remaining shares (<0 on failure).
    q_transfer_holding: (
      name: bigint,
      issuerPtr: number,
      ownerPtr: number,
      newOwnerPtr: number,
      shares: bigint,
      mgmt: number,
    ): bigint => {
      const issuer = id32(issuerPtr);
      const owner = id32(ownerPtr);
      return (sim as any).assets.transferShareOwnershipAndPossession(
        mgmt >>> 0,
        BigInt.asUintN(64, name),
        issuer,
        owner,
        owner,
        BigInt.asUintN(64, shares),
        id32(newOwnerPtr),
      ) as bigint;
    },

    // Native spectrumIndex: -1 when the identity has NO spectrum record (never funded) — corpora gate
    // invocations on that (an unknown user can't invoke even with amount 0).
    q_spectrum: (idPtr: number): number => {
      if (!sim.entityOf(id32(idPtr))) return -1;
      const h = hex(id32(idPtr));
      let i = spectrumIds.indexOf(h);
      if (i < 0) {
        i = spectrumIds.length;
        spectrumIds.push(h);
        spectrumBytes.push(id32(idPtr));
      }
      return i;
    },

    q_decrease: (idx: number, amount: bigint) => {
      const b = spectrumBytes[idx >>> 0];
      if (b) sim.debit(b, BigInt(amount));
    },

    q_shares: (issuerPtr: number, assetName: bigint): bigint => {
      const issuerHex = hex(id32(issuerPtr));
      let nameStr = "";
      for (let n = BigInt(assetName), i = 0; i < 8; i++) {
        const c = Number(n & 0xffn);
        n >>= 8n;
        if (c === 0) break;
        nameStr += String.fromCharCode(c);
      }
      let sum = 0n;
      for (const a of sim.assetUniverse()) {
        if (a.issuer === issuerHex && a.name === nameStr) {
          for (const h of a.holdings) sum += BigInt(h.shares);
        }
      }
      return sum;
    },

    q_possessed: (
      name: bigint,
      issuerPtr: number,
      ownerPtr: number,
      possessorPtr: number,
      om: number,
      pm: number,
    ): bigint => {
      const r = (sim as any).assets.numberOfPossessedShares(
        BigInt(name),
        id32(issuerPtr),
        id32(ownerPtr),
        id32(possessorPtr),
        om >>> 0,
        pm >>> 0,
      ) as bigint;
      if (env_.QINIT_GTEST_DUMP_ASSETS) {
        const uni = sim
          .assetUniverse()
          .filter((a: any) => a.name === "QUSD")
          .map((a: any) =>
            a.holdings
              .map(
                (h: any) =>
                  `${h.owner.slice(0, 8)}/${h.possessor.slice(0, 8)}:${h.shares}@${h.ownMgmt}/${h.posMgmt}`,
              )
              .join(" "),
          );
        (globalThis as any).process.stderr.write(
          `[q_possessed] owner=${hex(id32(ownerPtr)).slice(0, 8)} om=${om >>> 0} pm=${pm >>> 0} -> ${r} | uni: ${uni.join(" | ")}\n`,
        );
      }
      return r;
    },

    q_state_size: (i: number): number => (handles[i]?.stateSize ?? 0) >>> 0,

    // Shared-memory mode: the contract's state lives in the runner's own memory — hand back its absolute
    // address so contractStates[i] is the live state (no shadow, no sync). 0 => shadow-buffer fallback.
    q_state_addr: (i: number): number => {
      const c = handles[i];
      return c && c.sharedMem ? c.stateAddr >>> 0 : 0;
    },

    q_state_in: (i: number, dst: number, len: number) => {
      const c = handles[i];
      if (!c) return;
      // Copy engine->shadow only on the first pull, after the engine advanced, or if the runner handed a new
      // buffer; otherwise the shadow at dst is already current and the (large) copy is skipped. Mark touched
      const prev = materialized.get(i);
      if (!prev || prev.dst !== dst) {
        const t0 = prof ? now() : 0;
        write(dst, c.stateView(len >>> 0));
        if (prof) {
          stat.pulls++;
          stat.pullBytes += len >>> 0;
          stat.pullMs += now() - t0;
        }
        engineDirty.delete(i);
      } else if (engineDirty.has(i)) {
        refreshShadow({ dst, len: len >>> 0 }, c);
        engineDirty.delete(i);
      }
      materialized.set(i, { dst, len: len >>> 0 });
      touched.add(i);
    },

    // Assertion-time refresh (see the shim's qbSyncThen): re-sync every engine-dirty shadow so a cached
    // getState() pointer reads live values, paying the diff scan only when a dispatch actually intervened.
    q_state_sync: () => {
      for (const i of engineDirty) {
        const m = materialized.get(i);
        const c = handles[i];
        if (m && c) {
          refreshShadow(m, c);
          touched.add(i);
        }
      }
      engineDirty.clear();
    },

    q_set_epoch: (e: number) => {
      sim.epochN = e >>> 0;
    },
    q_get_epoch: (): number => sim.epochN >>> 0,
    q_set_tick: (t: number) => {
      sim.tickN = t >>> 0;
    },
    q_get_tick: (): number => sim.tickN >>> 0,
    q_set_prev_spectrum_digest: (ptr: number) => {
      sim.prevSpectrumDigestOverride = read(ptr, 32);
    },
    // updateQpiTime() in the corpus harness pushes its utcTime fields here; set the chain clock so the qpi
    // date accessors (year/month/day/...) return them. timeBaseMs is chosen so nowMs() == the requested UTC.
    q_set_datetime: (y: number, mo: number, d: number, h: number, mi: number, s: number) => {
      const ms = Date.UTC(y >>> 0, (mo >>> 0) - 1, d >>> 0, h >>> 0, mi >>> 0, s >>> 0);
      sim.timeBaseMs = ms - sim.tickN * sim.tickDuration;
    },

    // The proposal-voting corpora seed their committee by writing broadcastedComputors.computors.publicKeys[i];
    // the harness header routes each write here so qpi.computor(i) in the engine returns the same identity.
    q_set_computor: (i: number, idPtr: number) => {
      sim.setComputorKey(i >>> 0, id32(idPtr));
    },

    t_report: (
      namePtr: number,
      nameLen: number,
      passed: number,
      msgPtr: number,
      msgLen: number,
    ) => {
      results.push({
        name: dec.decode(read(namePtr, nameLen)),
        passed: passed >>> 0 !== 0,
        message: dec.decode(read(msgPtr, msgLen)),
      });
    },
  };

  let rng = 0x9e3779b97f4a7c15n;
  const env = {
    _rdrand64_step: (outPtr: number): number => {
      rng = (rng * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      new DataView(mem().buffer).setBigUint64(outPtr >>> 0, rng, true);
      return 1;
    },
  };

  // Bun 1.3.14 has a Proxy + wasm i64-marshalling bug ("Invalid argument type in ToBigInt") when a Proxy
  // serves as the import object for a module with i64-param imports (WASI clock_time_get, lhost helpers).
  const mod = await WebAssembly.compile(runnerWasm);
  const noopVal = (..._args: unknown[]): number => 0;
  const noopBig = (..._args: unknown[]): bigint => 0n;

  // Runner-side scratchpad (shared-memory mode): the corpus may run qpi container maintenance directly on the
  // live shared state (e.g. QTRY's discountedFeeForUsers.cleanup()), whose __ScopedScratchpad acquires through
  let scratchBase = 0,
    scratchBump = 0;
  const scratchAcquire = (size: bigint, initZero: number): number => {
    const m = runnerMemory()!;
    if (!scratchBase) scratchBase = scratchBump = m.buffer.byteLength;
    const n = Number((BigInt(size) + 7n) & ~7n);
    if (scratchBump + n > m.buffer.byteLength)
      m.grow(Math.ceil((scratchBump + n - m.buffer.byteLength) / 65536));
    const off = scratchBump;
    scratchBump += n;
    if (initZero) mem().fill(0, off, off + n);
    return off >>> 0;
  };

  // lhost: read-only surface backed by the live Sim (for in-runner qpi contexts like QDUEL's computeWinner),
  // with explicit safeNoop stubs for state-mutating imports the runner never legitimately calls.
  const lhost: Record<string, Function> = {
    k12: (inOff: number, len: number, outOff: number) =>
      mem().set(k12Bytes(read(inOff, len)), outOff >>> 0),
    epoch: () => sim.epochN & 0xffff,
    tick: () => sim.tickN >>> 0,
    day: () => dateFields(sim.nowMs()).day,
    year: () => dateFields(sim.nowMs()).year,
    hour: () => dateFields(sim.nowMs()).hour,
    minute: () => dateFields(sim.nowMs()).minute,
    month: () => dateFields(sim.nowMs()).month,
    second: () => dateFields(sim.nowMs()).second,
    millisecond: () => dateFields(sim.nowMs()).milli,
    now: (out: number) =>
      new DataView(mem().buffer).setBigUint64(out >>> 0, packDateAndTime(sim.nowMs()), true),
    prevSpectrumDigest: (out: number) =>
      mem().set((sim.prevSpectrumDigestOverride ?? new Uint8Array(32)).subarray(0, 32), out >>> 0),
    // Live spectrum entity record (a corpus runs contract functions in-runner: QTF's CheckContractBalance
    // reads qpi.getEntity(SELF).incoming - outgoing; a noop stub made every such balance check fail).
    transfer: (destOff: number, amount: bigint): bigint => {
      const self = sim.contractId(mainSlot);
      const bal = sim.balance(self);
      if (amount < 0n) return -1n;
      if (bal < amount) return bal - amount;
      sim.debit(self, amount);
      sim.credit(id32(destOff), amount);
      return bal - amount;
    },
    burn: (amount: bigint, ciBurnedFor: number): bigint => {
      const self = sim.contractId(ciBurnedFor >>> 0 || mainSlot);
      const bal = sim.balance(self);
      if (amount < 0n || bal < amount) return -1n;
      sim.debit(self, amount);
      return bal - amount;
    },
    // In-runner inter-contract calls (QTF's ProcessTierPayout invokes QRP's top-up procedure through the
    // corpus qpi context). Caller is the contract under test; reward moves caller -> callee like runtime.ts.
    liteCallFunction: (
      calleeIdx: number,
      inputType: number,
      inOff: number,
      inSize: number,
      outOff: number,
      outSize: number,
    ): number => {
      const out = sim.query(calleeIdx >>> 0, inputType & 0xffff, read(inOff, inSize));
      if (out.length) write(outOff, out.subarray(0, Math.min(outSize >>> 0, out.length)));
      return 0;
    },
    liteInvokeProcedure: (
      calleeIdx: number,
      inputType: number,
      inOff: number,
      inSize: number,
      outOff: number,
      outSize: number,
      reward: bigint,
    ): number => {
      const self = sim.contractId(mainSlot);
      if (reward > 0n) {
        if (sim.balance(self) < reward) return 4; // InsufficientFunds
        sim.debit(self, reward);
      }
      const out = sim.procedure(calleeIdx >>> 0, inputType & 0xffff, read(inOff, inSize), {
        reward,
        invocator: self,
        originator: self,
      });
      if (out.length) write(outOff, out.subarray(0, Math.min(outSize >>> 0, out.length)));
      return 0;
    },
    getEntity: (idOff: number, entityOff: number): number => {
      const id = id32(idOff);
      const e = sim.entityOf(id);
      const rec = EntityRecord.wrap(mem(), entityOff >>> 0);
      rec.publicKey = M256i.wrap(id);
      rec.incomingAmount = e ? e.incomingAmount : 0n;
      rec.outgoingAmount = e ? e.outgoingAmount : 0n;
      rec.numberOfIncomingTransfers = e ? e.numberOfIncomingTransfers : 0;
      rec.numberOfOutgoingTransfers = e ? e.numberOfOutgoingTransfers : 0;
      rec.latestIncomingTransferTick = e ? e.latestIncomingTransferTick : 0;
      rec.latestOutgoingTransferTick = e ? e.latestOutgoingTransferTick : 0;
      return e ? 1 : 0;
    },
  };
  if (sharedSlots.size) {
    lhost.acquireScratch = scratchAcquire;
    lhost.releaseScratch = (off: number) => {
      const p = off >>> 0;
      if (p >= scratchBase && p <= scratchBump) scratchBump = p;
    };
  }

  // env: PRNG (global in the runner) + contract-specific symbols.
  const envObj: Record<string, Function> = { ...env };

  // wasi: fd_write with correct byte-count reporting (avoids ostream hang), clock_time_get for QTRY/Nostromo.
  const wasiObj: Record<string, Function> = {
    fd_write: (_fd: number, iovs: number, iovsLen: number, nwritten: number): number => {
      const dv = new DataView(mem().buffer);
      let total = 0;
      for (let k = 0; k < iovsLen >>> 0; k++) total += dv.getUint32((iovs >>> 0) + k * 8 + 4, true);
      dv.setUint32(nwritten >>> 0, total >>> 0, true);
      return 0;
    },
    // Real wall-clock: the native harness seeds etalonTick from std::chrono::system_clock::now() (QTRY's
    // updateEtalonTime); a zero stub would put the corpus clock at 1970 while the oracle runs at today.
    clock_time_get: (_id: number, _precision: bigint, timePtr: number): number => {
      new DataView(mem().buffer).setBigUint64(timePtr >>> 0, BigInt(Date.now()) * 1_000_000n, true);
      return 0;
    },
  };

  // Fill in explicit safeNoop stubs for every import the module declares that we haven't wired yet, so no
  // Proxy is needed in the import object that Bun sees.
  for (const imp of WebAssembly.Module.imports(mod)) {
    const entry =
      imp.module === "lhost"
        ? lhost
        : imp.module === "env"
          ? envObj
          : imp.module === "wasi_snapshot_preview1"
            ? wasiObj
            : null;
    if (entry && !(imp.name in entry)) {
      const results: string[] = ((imp as any).type?.results ?? []) as string[];
      (entry as any)[imp.name] = results.includes("i64") ? noopBig : noopVal;
    }
  }

  const imports: Record<string, Record<string, Function>> = { thost };
  if (Object.keys(lhost).length) imports.lhost = lhost;
  if (Object.keys(envObj).length) imports.env = envObj;
  imports.wasi_snapshot_preview1 = wasiObj;

  runner = await WebAssembly.instantiate(mod, imports as any);
  // Deploy between instantiation and _initialize: shared-memory contracts need the runner's Memory (live from
  // instantiate), while _initialize may already drive thost (a corpus registering a gtest Environment whose
  deployAll();
  (runner.exports._initialize as Function)?.();

  const count = (runner.exports.test_count as Function)() >>> 0;

  // Opt-in trace (QINIT_GTEST_TRACE): name each test on stderr before it runs. A corpus test can loop
  // forever inside the wasm (a tick/time/epoch precondition the harness doesn't satisfy), which blocks
  const trace = !!(globalThis as any).process?.env?.QINIT_GTEST_TRACE;
  // QINIT_GTEST_FILTER: comma-separated substrings — run only tests whose name contains one (skip the rest).
  // Iterating on a known-failing subset avoids paying for the already-green bulk of a heavy corpus.
  const filterRaw = ((globalThis as any).process?.env?.QINIT_GTEST_FILTER ?? "") as string;
  const filters = filterRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Name lookups write into the runner's io scratch; resolve a real io_base whenever we'll print names
  // (trace or prof) or match the filter. Writing to a bogus base (0) would corrupt the runner's memory.
  const ioBase =
    trace || prof || filters.length ? ((runner.exports.io_base as Function)?.() ?? 0) >>> 0 : 0;
  const traceName = (i: number): string => {
    if (!ioBase) return `#${i}`;
    const cap = 256;
    const n = (runner.exports.test_name as Function)(i, ioBase, cap) >>> 0;
    return dec.decode(read(ioBase, Math.min(n, cap)));
  };

  const t0run = now();
  for (let i = 0; i < count; i++) {
    if (filters.length) {
      const nm = traceName(i);
      if (!filters.some((f) => nm.includes(f))) continue;
    }
    if (trace) (globalThis as any).process.stderr.write(`[gtest] #${i} ${traceName(i)}\n`);
    const before = results.length;
    const tt = prof ? now() : 0;
    (runner.exports.run_test as Function)(i);
    if (prof)
      (globalThis as any).process.stderr.write(
        `[gtest] #${i} ${traceName(i)} wall=${Math.round(now() - tt)}ms\n`,
      );
    if (opts.onResult) {
      for (let k = before; k < results.length; k++) await opts.onResult(results[k]);
      await new Promise((res) => setTimeout(res, 0));
    }
  }
  if (prof) {
    const wall = Math.round(now() - t0run);
    const pullMB = Math.round(stat.pullBytes / (1 << 20));
    (globalThis as any).process.stderr.write(
      `[gtest-prof] wall=${wall}ms dispatches=${stat.dispN} dispatchMs=${Math.round(stat.dispMs)} ` +
        `pulls=${stat.pulls} pulledMB=${pullMB} pullMs=${Math.round(stat.pullMs)} ` +
        `other=${Math.round(wall - stat.dispMs - stat.pullMs)}ms\n`,
    );
  }
  return results;
}
