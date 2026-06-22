# @qinit/engine

A framework-agnostic **Qubic smart-contract simulation engine**. Deploy compiled QPI contracts (wasm),
advance ticks/epochs, call functions/procedures, move QU, issue assets, and read state — all in-process, in a
browser or in Node. It's the engine behind the qinit IDE; this package is the reusable core, with no UI, no
backend, and no `node:fs`/Bun in the default entry.

> Status: the runtime is browser/Node-safe and importable today. Full npm publish (self-contained `.d.ts`
> and publishing the `@qinit/core` / `@qinit/proto` type deps) is the remaining packaging step — see
> "Publishing" below.

## Install

```sh
npm i @qinit/engine @qubic-lib/qubic-ts-library
```

`@qubic-lib/qubic-ts-library` (pure-wasm KangarooTwelve / FourQ) is a runtime peer the engine externalises.

## Quickstart

```ts
import { InProcessEngine, initK12 } from "@qinit/engine";
import { buildSignedTx } from "@qinit/core";      // tx signing
import { encodeInput, contractAddress } from "@qinit/proto"; // input ABI

await initK12();                       // REQUIRED once — wires up the K12 hash used for state digests
const engine = new InProcessEngine();

// 1. deploy a compiled contract (wasm produced by @qinit/build's clang toolchain) at a slot index
engine.deploy(28, wasmBytes, "Counter"); // runs INITIALIZE

// 2. advance chain time
engine.advanceTick(10);                // BEGIN_TICK (slots low→high) → drain txs → END_TICK (high→low)

// 3. read-only function call (no signing, no state change)
const out = await engine.querySmartContract(28, /*inputType*/ 1, await encodeInput(/*…*/));

// 4. submit a procedure as a signed tx
const tx = await buildSignedTx(seed, {
  destination: contractAddress(28),
  amount: 0n,
  tick: engine.tickInfo().tick + 5,
  inputType: 1,                        // the procedure's registered id
  payload: await encodeInput(/*…*/),
});
await engine.broadcastTx(tx.bytes);    // queued; runs on its target tick
engine.advanceTick(6);

// 5. inspect
engine.stateRead(28);                  // decoded StateData
engine.balance(someId);                // spectrum balance (incoming − outgoing)
```

## What it models (fidelity)

Grounded in `qubic/core-lite`: ticks/epochs with the real system-procedure order (INITIALIZE → BEGIN_EPOCH →
BEGIN_TICK low→high → user procedures → END_TICK high→low → END_EPOCH), the spectrum money model
(`balance = incoming − outgoing`, transfer/burn, invocation reward credited *before* a procedure body), the
asset/shares universe, inter-contract calls (lower-index-only, depth ≤ 10), and `digest = K12(StateData)`.

Tick finalisation runs a **real N-computor quorum** (configurable committee, default 8; `QUORUM = ⌊N·2/3⌋+1`):
each tick every computor FourQ-signs a 352-byte `Tick` vote over the chain's state digests (spectrum / universe
/ computer) and the tick finalises once aligned votes ≥ QUORUM. The committee list is arbitrator-signed (default
arbitrator seed `"a"×55`). Configure via `new Sim({ consensus: { numberOfComputors?, computorSeeds?,
arbitratorSeed? } })`; consensus is additive, so contract `StateData` digests are unchanged.

## The wasm contract ABI

A contract module the engine can run must export:
- `state_size() -> i32` — byte size of `StateData`;
- `dispatch(kind, inputType, inOff, outOff, localsOff)` — the entry trampoline (kind: function/procedure/sysproc);
- a `memory` it shares with the host.

Before each call the host writes a 256-byte QPI context header (contract index/id, originator, invocator,
invocationReward, entryPoint) at a fixed offset, copies the input, calls `dispatch`, and reads the output.
The host import table (`HostServices`) supplies the qpi callbacks: time (tick/epoch), spectrum
(transfer/burn/getEntity), assets (issueAsset/transferShares/distributeDividends), inter-contract
(`liteCallFunction`/`liteInvokeProcedure`), and k12/log/abort.

## Entries

- `@qinit/engine` — the engine (`InProcessEngine`, `Sim`, `Contract`, `KIND`, `SP`, `ContractAbort`,
  `initK12`, `k12Bytes`, `toHex`). Browser + Node safe.
- `@qinit/engine/server` — an HTTP adapter (`EngineServer`) that serves an `InProcessEngine` on the
  qubic-core-lite RPC routes. **Bun-only** (uses `Bun.serve`); kept out of the default entry.
- `@qinit/engine/peer` — a TCP adapter (`PeerServer`) that speaks the Qubic peer protocol so the official
  `qubic-cli` drives the engine. Run `bun packages/engine/src/peer-main.ts 21841`, then
  `qubic-cli -nodeip 127.0.0.1 -nodeport 21841 -getcurrenttick` (wallet `-getbalance`/`-sendtoaddress`,
  `-getsysteminfo`, `-getcomputorlist`, `-getquorumtick`, …). **Bun-only** (uses `Bun.listen`). Note: the
  cli's hard-coded `ARBITRATOR` differs from the sim's, and txs apply immediately (future-tick scheduling is
  not honoured) — single-authority-style timing on a single process playing all computors.

## Build & publishing

`bun run build` bundles `dist/index.js` (browser+Node, node-free — `@qinit/core` is aliased to its `/browser`
entry, `@qinit/proto` is inlined, `@qubic-lib` stays external) and `dist/server.js` (Node/Bun), plus `.d.ts`
via `tsc`. In the monorepo, workspace consumers resolve the `bun` export condition straight to `src/` (no
build needed); npm consumers get `dist/`.

Remaining before `npm publish`: emit a **self-contained `.d.ts`** (the current declarations still reference
`@qinit/core` types) via a d.ts bundler, and publish or inline the `@qinit/core` / `@qinit/proto` type
surface.
