# qinit CLI test campaign 6 — one product's lifetime, the way a team ships it (F65+)

Binary: `/home/kali/Projects/Qinit/dist/qinit` rebuilt from `8ec7b410` (2026-09-05 19:01).
Node: see "Step 0" below. Plan: `~/.claude/plans/cli-exploratory-tester-sunny-waterfall.md`.
Workspace: `~/Projects/qinit-c6/` (product repo `qlaunch/`, harness `bin/`, raw rows `work/`).
Coverage table of F1–F64: `~/Projects/qinit-c6/COVERAGE.md`. Report only; nothing fixed.

## Step 0 — environment

(filled in as the campaign runs)

## Summary

(filled in at the end)

## Findings

## Friction ledger

## Verified correct (oracle-checked, no defect)

## Compiler × runtime matrix

## Suite counts

## P0 — Day 0: the docs are the oracle (clang × core, node `qinit-v0.0.47` = core-lite `1beae69a`)

Sandbox: `QINIT_CACHE=~/Projects/qinit-c6/sandbox/cache-main`, `XDG_CONFIG_HOME=~/Projects/qinit-c6/sandbox/config`,
`QINIT_CORE=~/Projects/qubic-core-lite`, `WASM_CLANG`/`WASI_SYSROOT` = `~/wasm-toolchain/wasi-sdk`. Raw rows under
`~/Projects/qinit-c6/work/p0/`.

| row | result |
|---|---|
| `install.sh` into `QINIT_BIN` sandbox | installs released `qinit-cli-v0.1.12`, runs `setup` (node fetch 78.5 s); exit 0. Discarded afterwards — every later row is `dist/qinit` from `8ec7b410`. |
| `dist/qinit setup` into an empty cache | headers + node `qinit-v0.0.47` 35 s, `WASI SDK ready /home/kali/wasm-toolchain/wasi-sdk 1ms` (env honoured), verifier 4.6 s; `doctor` 3/3 green |
| `node run --ref qinit-v0.0.47 --tick-ms 300` | **151 s** wall; phase `wasm compiler 0/119 MB … fetched` — see F65 |
| 14 documented `qinit …` examples (README, cli-guide, cheatcodes, every `help <cmd>` example) parsed with `--help` | 13/14 parse; the 14th is the guide's intentional `--not-a-real-flag`. Note: the parser accepts `tick show` at parse time, so this row cannot see F62. |
| `new` × 4 templates | each writes `contracts/<N>.h`, `tests/<N>.test.cpp`, `tests/<N>.test.ts`, `qinit.json`, `.gitignore`, `README.md`; exit 0. cli-guide §7.1 lists the files without `.test.ts` (doc drift, cosmetic). |
| shipped gtests (F59) | **fixed**: counter 2 / hashmap 7 / asset 5 / intercontract 4 `EXPECT_` lines; `gtest --compiler clang` and `typescript` → `2/2 passed`, exit 0, all four templates (8 runs) |
| scaffold README followed verbatim on `Tcounter`: `node run` → `test` → `gtest --compiler typescript` → `call` | `test`: 1 pass / 4 expect, `Tcounter @ 29`, exit 0. `call` interactive: picker → `Get` (no prompt, ran) and `Inc` → amount prompt `0` → `✓ processed`, one-shot hint rendered. |
| `test` on the other templates | hashmap 1/5 expect @30, asset 1/6 expect @31, exit 0; **intercontract exit 1** `cannot assign 2 project contr…very callee below its caller` — F60 control (3 slots taken + 2 needed > 4), same wrong text, same mid-elision; not re-filed |
| `git status` after `qinit test` | untracked `package.json` and `tests/.qinit/{runtime,index,Tcounter}.ts` — see F66 |
| `dev` in tmux, then `touch contracts/Tcounter.h` | start: slot 29 (reuse), `upload 16/16`, `compiler: prebuilt artifact (exact bytes)`; the touch (no content change) produced a second `UploadBegin`/`Deploy accepted` in `node.log` 14 s later for the same k12 — see friction |
| `--json` rows on core | `call --fn/--proc` ok; `tick`/`epoch` bare ok; `tick show`/`epoch show` still `unknown subcommand` (F62, open); `seed --show --json` now emits a document (F24 fixed for `seed`); `ls --json` still no `ok` (F57, open); `ls` `feeReserve: null` on every slot (expected: node lacks `b2e03720`) |

### F65 — `node run` downloads the managed WASI SDK (119 MB archive, 390 MB on disk) although `setup` and `doctor` accepted the developer's `WASM_CLANG`/`WASI_SYSROOT`, and nothing then uses it

Severity: **low (inconsistent setup commands; wasted download and disk on every fresh cache)**.

```
export WASM_CLANG=~/wasm-toolchain/wasi-sdk/bin/clang++ WASI_SYSROOT=~/wasm-toolchain/wasi-sdk/share/wasi-sysroot
QINIT_CACHE=$E qinit setup        # ✓ WASI SDK  ready /home/kali/wasm-toolchain/wasi-sdk  1ms
QINIT_CACHE=$E qinit doctor       # ✓ wasi-sdk (wasm compiler)  /home/kali/wasm-toolc…wasi-sdk/bin/clang++
QINIT_CACHE=$E qinit node run --ref qinit-v0.0.47 --tick-ms 300
#   ⠋ wasm compiler   0/119 MB … 119/119 MB
#   ✓ wasm compiler   fetched                       (151 s wall for the whole command)
du -sh $E/wasi-sdk                # 390M
```

`setup.tsx:59-69` (`configuredWasiSdk`) reports the env SDK as ready; `node-run.tsx:133-145` calls
`fetchWasiSdk()` unconditionally unless `--offline` ("best-effort — WASM_CLANG/WASI_SYSROOT … still work").
`wasiSdkPaths()` (`packages/core/src/cache/wasi-sdk.ts:62-71`) prefers the env pair, so the fetched copy is
never used by `build`. Control: with the env unset, the same fetch is the documented behaviour and the
downloaded SDK is used. Oracle: the two commands' own frames disagree about whether an SDK is needed.

### F66 — the scaffold's `.gitignore` does not cover what `qinit test` generates (`tests/.qinit/`, `package.json`), and `qinit.json` carries an absolute `coreDir`

Severity: **low (team workflow)** — a first `git add -A` after the README's own `qinit test` commits a generated
client (`tests/.qinit/runtime.ts`, 4 629 lines, regenerated on every deploy) and a machine-specific path.

```
qinit new Tcounter && cd Tcounter && git init && git add -A && git commit -m scaffold
qinit test                          # README step; 1 pass
git status --short
# ?? package.json
# ?? tests/.qinit/
cat .gitignore                      # dist/ *.wasm *.log qinit.idl.json contracts_dyn/ .DS_Store
jq .coreDir qinit.json              # "/home/kali/Projects/qubic-core-lite"   (from QINIT_CORE at scaffold time)
```

`new.tsx:91` writes the six-entry ignore list; `test.tsx:184-202` writes `tests/.qinit/` and `package.json`. The
`coreDir` row is P6's problem (second developer) and is extended there.

### Friction ledger — P0

| where | what a developer meets |
|---|---|
| `README.md` | "Develop" is Qinit's own contributor loop (`bun install`, `bun test`); the contract developer's quickstart lives in the scaffold README and `qinit cheat-sheet`, neither linked from the repo README |
| `node run` | 151 s on a fresh cache, 119 MB of it the F65 download |
| `dev` | a save with no content change re-uploads 16 chunks and re-arms the slot (`node.log`: second `UploadBegin` for the same k12) — ~10 s of wall per formatter/editor no-op save; the dependency path skips unchanged code by hash, Main never does (`docs/cli-guide.md` §8 "always deploy Main last") |
| `cheat-sheet` in a pipe | box `[6 · inspect]` merges three commands onto one line, `[5]` merges `CC_ASSERT`/`CC_PAY` — render only |
| four templates on one core node | the fourth (`intercontract`) cannot be tested at all on a 4-slot node once the other three are deployed (F60) |

## P1 — the product, test-first (clang × core first; product repo `~/Projects/qinit-c6/Launch`, spec `tests/Launch.test.ts`, 58 `expect()`s)

Edit → build cycles before the first green build (spec written and committed first):

| cycle | clang backend | typescript backend | `verify` |
|---|---|---|---|
| 1 | `Vault.h: must use 'struct' tag to refer to type 'Lock'` — my bug (a struct and a procedure both named `Lock`); Launch not reached | protocol gate: `LAUNCH_REGISTER_FEE` must start with `Launch`; **Vault built** (F67) | same constant-name rule; Vault ok |
| 2 | Launch END_EPOCH: `2 inter-contract calls in this scope (Fees, IssueAsset) all declare interContractCallError … Use the _E variants … or wrap each call in its own { }` | `'interContractCallError' is already declared in this scope` | — |
| 3 | ok · 48 390 B · k12 `e55f1e1f…` | ok · 13 872 B · k12 `0ccfa65d…` | ok, both contracts |

IDL identical across backends (canonical JSON, 14 018 B). Neither backend writes an `.idl.json` for the callee.

### F67 — the TypeScript backend builds a header that clang (and Core) reject: a struct hidden by a same-named procedure

Severity: **medium (silent accept on one backend; the hand-off to Core fails on the other)**.

```cpp
struct NameHide : public ContractBase {
    struct Lock { uint64 shares; };
    struct StateData { Lock last; };
    struct Lock_input { uint64 shares; };  struct Lock_output { uint64 result; };
    struct Lock_locals { Lock l; };                 // <- after PUBLIC_PROCEDURE(Lock) below, `Lock` names the procedure
    PUBLIC_PROCEDURE_WITH_LOCALS(Lock) { locals.l.shares = input.shares; state.mut().last = locals.l; output.result = locals.l.shares; }
    …
```

```
qinit build contracts/NameHide.h --compiler typescript --json | jq -c '{ok,size,hash}'
# {"ok":true,"size":4392,"hash":"51fa7030…"}
qinit build contracts/NameHide.h --compiler clang --json | jq -r .stderr | grep error
# NameHide.h:32:26: error: must use 'struct' tag to refer to type 'Lock' in this scope
```

Oracle: C++ name hiding ([basic.scope.hiding]/2 — a class name is hidden by a function of the same name in the
same scope and must then be written `struct Lock`); clang and MSVC both refuse it, so the contract cannot be
integrated. The TS backend resolves `Lock` in a `_locals` struct to the type and emits wasm. Found in the
product (`Vault.h` cycle 1): the TS build of the whole project reported only Launch's constant-name violation
and silently produced `dist/ts/Vault.wasm` (7 516 B) from the header clang rejected. Control: with the struct
renamed `LockEntry` both backends build and the IDLs agree. Probe: `~/Projects/qinit-c6/work/p1/probes/name-hide`.

**Withdrawn before filing — two plain `CALL_OTHER_CONTRACT_FUNCTION`/`INVOKE_OTHER_CONTRACT_PROCEDURE` in one
scope.** Both backends reject it, and they are right: core's own macro declares `InterContractCallError
interContractCallError` on every expansion (`qpi_macros.h:328-340`, "use this variant [`_E`] when making multiple
inter-contract calls in the same scope"). Kept as friction: the clang-backend message names the fix and the
`_E` variables to use; the TS message is `'interContractCallError' is already declared in this scope` and a
developer has to find the `_E` macros in qpi.h. Probe: `work/p1/probes/two-calls` (both backends exit 1).

**F57 (extension)** — `build --json` on a compiler failure emits `{"ok":false,…,"stderr":"…"}` with **no `error`
key**; the message sits inside `stderr` after three clang deprecation warnings. cli-guide §19 promises `{ok, error}`
for argument errors and crashes; a build failure is the third failure shape and has neither.

### F68 — `advance-epoch` on the core dev node can leave the node stopped at the epoch boundary, waiting for an operator to press F10; `node status` calls it "not yet ticking"; a second `epoch advance` is the undocumented recovery

Severity: **high (node stops after a documented dev operation; the only advertised way out is a restart that discards every contract)**.

What happened (first end-to-end run of the spec; `~/Projects/qinit-c6/work/p1/node-run1.log`,
`F68-evidence.txt`): the spec called `rpc.advanceEpoch()` (`GET /live/v1/dev/advance-epoch`, the same route
`qinit epoch advance` uses) with an open round to settle. Node log, UTC:

```
12:26:46  === EPOCH TRANSITION: start | epoch 229 -> 230 | last tick of epoch 77702701
12:26:46  endEpoch: [1/5] running contract END_EPOCH procedures...
12:26:54  endEpoch: [1/5] contract END_EPOCH procedures done              (8 s: Launch settled the round)
12:26:55  endEpoch: [5/5] universe/assets done
12:26:56  Please press F10 to clear all memory on RAM and continue epoch transition procedure!
… (143 times, one per second, until 12:29:18)
```

Meanwhile `curl tick-info` answered `tick 77702702, epoch 229` frozen; `qinit node status --json` →
`{"up":true,"ticking":false,…,"error":"rpc: up, not yet ticking"}`; every procedure the spec sent afterwards
stayed unconfirmed. Recovery, found by reading the route:

```
curl -s http://127.0.0.1:41841/live/v1/dev/advance-epoch
# {"fromEpoch":229,"switched":true,"toEpoch":230,…}      16 ms; the node ticks again
```

Why (core-lite `1beae69a`, the node `qinit-v0.0.47` is built from): `qubic.cpp:1055-1056` turns on
`PAUSE_BEFORE_CLEAR_MEMORY` whenever `ENABLED_LOGGING && !defined(LONG_RUN_LOCAL_TESTNET)`; the transition then
sets `epochTransitionCleanMemoryFlag = 0` and `WAIT_WHILE(epochTransitionCleanMemoryFlag == 0)` (`:6111-6112`),
which only the F10 key (`:10454-10457`) or the dev route flips. The route (`rpc_live_controller.h:1089-1120`) sets
`forceSwitchEpoch`, drives the flag to 1 every 2 ms **for at most 25 s**, then restores the tick delay and returns
`switched:false`. When the sprint to the last tick plus `endEpoch()` outlasts the budget — here the sprint plus an
8 s END_EPOCH phase — the flag is left at 0 with nobody to raise it. `doc/long_run_local_testnet.md` documents
that `LONG_RUN_LOCAL_TESTNET` forces the pause to 0; the Qinit node build does not define it.

Control: the next `qinit epoch advance` on the same node (epoch 230 → 231, no round to settle, END_EPOCH phase
1 s) switched in 28 s wall and the node kept ticking. Campaign 3's S5 crossed three epochs on core without this,
so the wedge depends on the transition's duration, i.e. on what the deployed contracts do at END_EPOCH.

What the CLI could say: the route already returns `switched:false`; `epoch advance` could report it and retry, and
`node status` could recognise the epoch-boundary wait instead of "not yet ticking". The spec now retries
`advanceEpoch()` while it reports `switched:false` (the workaround a developer ends up writing).

### Friction — P1 (first end-to-end)

| where | what |
|---|---|
| `tests/.qinit/` | only Main gets a client; the callee `Vault` has neither a client nor an `.idl.json`, so the spec hand-writes a 56-byte `Lock_input` schema and drives it through `invokeProcedure` |
| runtime `contractAddress(n)` | returns the 32 raw bytes of the contract id while every other id in the client API is a 60-char identity string; passing it where an id is expected fails at encode time (`id must be a 60-char identity (A-Z) or a 64-hex pubkey, got …`) or, for a plain transfer's destination, is silently accepted and the qu go nowhere the contract can see — `bytesToIdentity()` is exported and fixes it, undocumented |
| END_EPOCH cost | a settlement END_EPOCH (issueAsset + 3 share transfers + 1 transfer + a Collection add) took the node **8 s** vs 1 s for the same phase with nothing to settle — measured again in P2 |

**F68 (client half, found on the rerun)** — the generated test runtime cannot drive the route at all when the
transition is slow: `LiteRpc.get()` in `tests/.qinit/runtime.ts` uses `fetchWithTimeout(…, 1e4)` with three tries,
so `rpc.advanceEpoch()` aborts at 10 s, retries twice, and throws `node unreachable at http://127.0.0.1:41841 —
is it running? (qinit node run)` for a node that is up and mid-transition; meanwhile the server-side loop of the
first request expires at 25 s and leaves the F10 wait behind (2/2 runs on this node). `qinit epoch advance` on the
same node used a longer client budget (returned `ok:true` after 28 s wall). A spec that needs an epoch boundary has
to bypass the runtime (`fetch()` with no timeout, loop on `switched`) — recorded as the product's own workaround.
Cycle 4 of the spec: 6 pass / 5 fail / 33 expects in 193 s, every failure downstream of the first epoch advance.

### P1 four-cell result (the same spec, one node per cell)

| test | clang×core | clang×sim | ts×sim | reading |
|---|---|---|---|---|
| fresh contract, register (fee/min/date/second-round), invest, settle & shares, failed-round Claim | pass | pass | pass | product logic agrees on all four |
| **vault: lock rights into the vault and release after the lock** | **pass** | **fail** (`acquireShares → 0`) | **fail** (`acquireShares → 0`) | **F69: share-rights divergence** |
| **donation via a plain transfer** | **fail** (transfer not included) | pass | pass | **F70: plain transfer not included on core** |
| viaQx (issue through QX, settle) | fail (QX inert, F39) | fail (`status 3`, round failed to settle) | fail (same) | QX model differs per runtime; not re-filed beyond F39 |
| totals | 7 pass / 4 fail | 9 pass / 2 fail | 9 pass / 2 fail | every cell green on the Launch-only spine |

ts×core deferred (F68 makes an epoch-boundary spec expensive on core; the two core cells share the node model, and clang×core already covers the core semantics). The Launch-only happy path (register → invest → settle → shares → refund) passed on all three cells that ran — the design's ground-rule-7 spine held.

### F69 — asset share-management rights (`acquireShares`/`releaseShares` + `PRE_RELEASE_SHARES`) succeed on core but return `INVALID_AMOUNT` on the simulator, for shares a dynamic contract issued and still manages

Severity: **medium (runtime divergence in a QPI family no prior campaign exercised from the CLI; a contract that works on core silently does nothing on the dev simulator)**.

Setup (the product, after a settled round): `Launch@30` issued its own asset with `qpi.issueAsset(name, SELF, …)` and
transferred 500 000 shares to investor `b`, all managed by slot 30. `b` then invokes `Vault@29`'s `Lock`, which calls
`qpi.acquireShares(asset, b, b, 100, 30, 30, 0)` to pull management rights from Launch into the Vault; Launch's
`PRE_RELEASE_SHARES` allows it when `qpi.originator() == input.owner`.

```
# clang × core: the lock takes, Vault.LockedOf(b) = 100, Launch.Holdings(b, managingContract:30) drops by 100
qinit test --runtime core --compiler clang           # vault test: PASS
# clang × simulator and typescript × simulator: acquireShares returns 0/-fee, nothing is stored
qinit test --runtime simulator --compiler clang      # vault test: FAIL — Vault.LockedOf(b) = 0
qinit test --runtime simulator --compiler typescript # vault test: FAIL — same
```

Oracle: the core cell of the same spec (rights actually move and come back). The simulator's `moveManagementRights`
(`packages/engine/src/qubic-simulator.ts:616-690`) returns `INVALID_AMOUNT` on a failed guard, and the same contract's
own `Holdings` function read the 500 000 shares at `managingContract:30` correctly in the settle test, so the
`numberOfPossessedShares` availability check is not the gap; the remaining candidate is the `PRE_RELEASE_SHARES`
callback path — either `qpi.originator()` is not the invoking user during a callback the simulator runs nested inside
`acquireShares`, or the possession-manager bookkeeping for a dynamic-contract-issued asset differs from core.
Root-causing the exact field is left for a follow-up; the divergence itself is the finding (ground rule 2). Fix nothing.

### F70 — a plain signed transfer (inputType 0) broadcast to the core dev node is silently not included (`found:false, moneyFlew:false, processed:true`); the same transfer lands on the simulator

Severity: **medium (a developer's plain transfer disappears with a success-shaped broadcast; core only)**.

Reduced to a control that removes the contract entirely (funded dev seeds, `buildSignedTx`/`broadcastTx` from the
generated runtime, target `tick + 8`):

```
user → user      found=false moneyFlew=false   balance 9999995000 → 9999995000  (no change)
user → contract  found=false moneyFlew=false   balance 1250       → 1250        (no change)
```

Both attempts broadcast `ok:true` and the target tick reports `processed:true`, but `tx-status` says `found:false` and
no balance moves — twice, at different ticks. On the **simulator** the identical helper lands (the product's donation
test, which sends a plain transfer to the contract, passes on both simulator cells and `donations` reaches the sent
amount). So a plain transfer built by the generated client is included by the simulator and dropped by the core dev
node. Because the failing case is contract-free (user → user), this is the transfer/broadcast path, not
`POST_INCOMING_TRANSFER`; the earlier "donation" reading (core drops the callback) is **withdrawn** in favour of this.
Open question for the follow-up: whether the CLI wallet's `sendTransfer(confirm:true)` path (used by `qinit explorer`)
lands where the raw `buildSignedTx` does not — if it does, the gap is in the generated runtime's transfer builder; if
it does not, plain transfers to the core dev node are broadly broken. Fix nothing.

### Friction — P1 four-cell

| where | what |
|---|---|
| `advance-epoch` from a spec | F68 makes an epoch-boundary spec unreliable on core through the generated runtime (10 s GET timeout vs a 25 s server loop); the workaround (`fetch` with no timeout, loop on `switched`) is in the spec |
| `fundedSeeds` shape | `GET /dev/funded-seeds` returns `{count, seeds:[string]}` — bare seeds, no identities; the CLI guide's RPC table (§15) lists it as `fundedSeeds()` with no shape, and the generated client's `rpc.fundedSeeds()` returns the raw document, so a spec derives identities itself |
| one node per cell | each core cell needs a fresh `node run --restart` (~10 s) because a wedged transition (F68) or leftover state carries over; the campaign harness does this, but a developer running `qinit test --runtime core` twice hits the F68 wedge on the second epoch |

### F70 — **withdrawn**, and folded into F68: the wedged node is what loses the transfers

Filed above as "a plain transfer is not included on core". It is not a transfer-path defect. On a **freshly restarted**
core node all three roads land, the same identity string, the same amount, the same `tick + 8`:

```
raw buildSignedTx, id STRING    found=true moneyFlew=true  10000000000 -> 10000005555  LANDED
raw buildSignedTx, id BYTES     found=true moneyFlew=true  10000005555 -> 10000011110  LANDED
sendTransfer (wallet road)      included=true moneyFlew=true 10000011110 -> 10000016665 LANDED
```

The earlier failures were all taken on a node that had already been through `advance-epoch`. Sequenced on one node:

```
before any epoch advance   epoch=229 found=true   10000000000 -> 10000005555  LANDED
advance-epoch -> {"fromEpoch":229,"switched":false,"tick":77702702,"toEpoch":229}
after 1 epoch advance      epoch=229 found=false  10000005555 -> 10000005555  LOST
after 1 epoch advance (2)  epoch=229 found=false  10000005555 -> 10000005555  LOST
```

So this is **F68's real cost**, and it is worse than the "not yet ticking" label suggests. Once `advance-epoch` returns
`switched:false`, the node freezes at the boundary (`tick 77702702, ticksLeft 0`, reproduced 3/3 times) yet keeps
answering RPC: `broadcast-transaction` still returns `ok:true`, `tx-status` still answers `processed:true` for the
target tick, and `qinit ls`/`state`/`call --fn` all still work off the frozen state. A client therefore gets
success-shaped answers for a tick that will never be created, and every procedure and transfer silently does nothing
until the node is restarted or a second `advance-epoch` unsticks it. The withdrawn entry is kept because the shape
("transfers stop landing") is what a developer will notice first, and the cause is two commands away.

### F69 — **withdrawn**: asset share-management rights agree on both runtimes; the product-level failure was not the QPI family

Filed above from the product's vault test (pass on core, fail on both simulators). A minimal two-contract repro
disproves the tool-level claim. `Mgr` issues its own asset, hands shares to a user and keeps management rights,
allowing a release only through `PRE_RELEASE_SHARES`; `Taker` pulls the rights in with `qpi.acquireShares`. Both
carry `CC_PRINT` of `originator`, `owner`, `possessor` and the call result. Probe:
`~/Projects/qinit-c6/work/p1/probes/rights`, runner `~/Projects/qinit-c6/bin/f69-run.sh`.

| row | clang × core | clang × simulator | simulator, acquirer at the **lower** slot |
|---|---|---|---|
| `Issue` 1000 shares | 1000 | 1000 | 1000 |
| `Give` 400 to the user | 600 left | 600 left | 600 left |
| user's shares under the manager | 400 | 400 | 400 |
| `Take` 100 → `acquireShares` | **0** (success, zero fee) | **0** | **0** |
| manager's `releaseCalls` / `allowed` | 1 / 1 | 1 / 1 | 1 / 1 |
| user's shares under the manager after | 300 | 300 | 300 |
| user's shares under the taker after | **100** | **100** | **100** |

The third column deploys the acquirer at slot 29 and the manager at slot 30 with explicit `--slot`, on a freshly
restarted simulator, which is exactly the product's layout (`Vault@29` acquiring from `Launch@30`) — the direction
the first two columns did not cover. All three agree. So `acquireShares`, `releaseShares`, `PRE_RELEASE_SHARES` and
`POST_RELEASE_SHARES` behave the same on both runtimes in both slot directions, and the product's vault-test failure
belongs to the product or its spec, not to Qinit. **New coverage rather than a defect**: this QPI family had never
been exercised from the CLI edge in six campaigns, and it holds.

Two probe errors were caught by controls while getting here, both worth recording. An asset name packed as `21820`
decodes to `<U`, whose first character is not `A-Z`, so `qpi.issueAsset` returned **0** and every later row was
vacuous while still exiting 0 — the contract's own `Stats.lastIssued` was the control that caught it. And a rerun
against a node that still held the previous run's contracts reported `lastIssued: 0` for an asset that already
existed; a fresh node per cell is not optional.

## P2 — users arrive (clang × core and clang × simulator, one node per cell, `bin/phase-P2.sh`)

A full round driven from the CLI only: register by `--args` and again by `--in`, three investors, one deposit below
the minimum, then the epoch boundary, then the round read back through `call --fn`, `state`, `state --all`,
`--digest`, `--dump`, `ls` and the generated client. Every number checked against `bin/oracle_qlaunch.py`, a Python
replay of the same action script that knows nothing about Qinit.

**Oracle agreement, both cells, exact:**

| value | oracle | clang × core | clang × simulator |
|---|---|---|---|
| `Register` by `--args` / by `--in` | 1 / −1 | 1 / −1 | 1 / −1 |
| `Invest` b / below-minimum | 5000 / −2 | 5000 / −2 | 5000 / −2 |
| balance delta owner / b / c / d | +8750 / −5000 / −3000 / −2000 | same | same |
| shares b / c / d | 500000 / 300000 / 200000 | same | same |
| treasury · status · roundSeq · settledMask | 1250 · 2 · 1 · 1 | same | same |
| state size | — | 22 816 B | 22 816 B |

`--args` and `--in` agree on the read road too: `Invested` for b returns 5000 through both spellings.
`state --json` and `call --fn Info` agree field for field on the whole round struct. `state --digest`
(`7fbb2837…`) equals an independent K12 of `state --dump` over all 22 816 bytes. The `history` Collection, the
`investors` HashMap and the `settled` BitArray all decode with the right populations.

**Cross-cell dump comparison** — the two runtimes' 22 816-byte state images differ in exactly **9 bytes**, and every
one is accounted for: `deadlineEpoch` at offset 76 and its copy in the `history` record at 14 596 (229 on core, 1 on
the simulator), the three date bytes at 80-82 and their copies at 14 600-14 602, and the epoch-derived Collection
priority at 14 608. Every other byte of state is identical across runtimes, both compilers having produced the same
IDL. That is the strongest layout-parity evidence the campaign has taken.

`qinit gen` plus a long-lived consumer (`app/indexer.ts`, the first time a generated client has been run as an app
rather than a one-off script in six campaigns) followed the chain and reported the settled round correctly:
`{"event":"round","tick":6353,"epoch":2,"seq":1,"status":2,"raised":"10000","treasury":"1250"}`.

F68 reproduced a fourth time on core: `advance-epoch` attempt 1 `switched=false`, attempt 2 `switched=true`. The
simulator switched on the first attempt, confirming F68 is core-only, as its `PAUSE_BEFORE_CLEAR_MEMORY` root cause
predicts.

### F71 — the simulator's calendar is pinned to 2024-01-01 while core returns the real date, so a contract with date logic takes different branches per runtime and nothing says so

Severity: **medium (silent per-runtime behaviour difference in a QPI family no campaign had exercised)**.

The product stamps each round with `qpi.year()/month()/day()`. Reading the same field back:

```
core       regYear=26 regMonth=9 regDay=5     # the real date, 2026-09-05
simulator  regYear=24 regMonth=1 regDay=1     # 2024-01-01
```

`packages/engine/src/qubic-simulator.ts:110` sets `timeBaseMs = Date.UTC(2024, 0, 1)` and `:1496` computes
`nowMs() = timeBaseMs + currentTick * tickDuration`, so the simulator's clock starts in January 2024 and creeps
forward at the tick rate: about 30 minutes of simulated time after 6 000 ticks at 300 ms. Core takes the wall clock.
A contract that closes a round on a calendar date therefore never triggers on the simulator and triggers immediately
on core, or the reverse, with no diagnostic on either side.

The fixed base is defensible — a deterministic simulator wants a deterministic clock, and `packages/engine/src/gtest.ts:464-467`
already exposes a way to set it for a test. The gap is that the CLI has no way to set or read it, `qinit info` does not
report the simulator's date, and neither `docs/cli-guide.md` nor the runtime picker mentions that the two runtimes
disagree about what day it is. Control: every non-date field of the same 22 816-byte state matches byte for byte.

### Friction — P2

| where | what |
|---|---|
| `call --proc` without `--trace` | `out` is `null` for a procedure that returns a value, so the two investor rows driven with `--in ""` and `--args '{}'` report nothing while the identical `--args` row with `--trace` reports `5000`. Known as F22, still open, and it is the reason the P2 script has to trace half its rows. |
| `ls --json` | still no `ok` key (F57), so the script's envelope check has to special-case one command. |
| dev-node balances | core funds a seed with 1e10, the simulator with 2e12, so every absolute balance assertion has to be written as a delta. Worth one line in the CLI guide. |

## P3 — a bug report comes in (clang × core; three realistic bugs planted in the working product)

Each bug is a plausible one- or two-line mistake, planted on a `bugs` branch and reproduced **from the CLI only**.
What is measured is not whether the bug exists but whether Qinit can show a developer why.

| bug | what a developer sees first | did the CLI name the cause? | commands to the cause |
|---|---|---|---|
| **C** refund forgotten on the below-minimum branch (one added `return;`) | `call --proc` returns `-2` with `ok:true`, exit 0 — a correct-looking rejection | **no** — see F72 | not reachable from Qinit |
| **B** pro-rata share math with `*` instead of `smul`, wrapping `sint64` | the round settles, `status=2`, and the investor holds **0** shares instead of 10 000 000 000 000, with no error anywhere | **yes** — `qinit debug`, one frame | ~7, decisive step is one TUI frame |
| **A** treasury fee charged per investor rounded up and summed | owner is paid 9748 where 9750 is due; `treasury` reads 1250 | **partly** — the payment is visible, the shortfall is not | 6 plus a raw RPC call Qinit cannot make |

**Bug B is where the tooling shines and is worth recording as verified-correct.** The bug lives inside `END_EPOCH`,
which no `call --trace` can reach, yet the trace ring captures the system procedure and `qinit debug` renders its
host calls:

```
✓ Launch sys#2 (END_EPOCH) 446µs · tick 77702702
  host  issueAsset      name=310366850129 shares=10000000000000
  host  transferShares  name=310366850129 shares=-8446744073709      <-- the wrapped product, named
  host  transfer        4570f7678912e9ea.. 975000
```

Selecting the frame and reading one line gives the answer. The state diff alongside it is equally good
(`investors[…] 1000000 → 0`, `treasury 1000 → 26000`, `settled[0] 0 → 1`), and internals are folded behind `ctrl+t`.

### F72 — no Qinit command reports a contract's qu balance, or even the contract's own identity, so money a contract wrongly keeps is invisible on every road

Severity: **medium (a whole class of money bugs is undiagnosable with the tool alone)**.

Bug C: an investor sends 50 qu, the deposit is rejected, and the refund is skipped. Every Qinit road reports health.

```
qinit call --proc Launch Invest --amount 50 --seed <D> --trace
#   ok:true, exit 0, out "-2"   (the contract's own "below minimum" code — looks correct)
#   trace state rows: (none — the procedure wrote nothing, so the diff is empty)
qinit call --fn Launch Invested --args '{"who":"<D>"}'   # 0   — no deposit registered, consistent
qinit call --fn Launch Info                              # donations 0, treasury 1000 — nothing accounts for the 50
qinit state Launch                                       # no field holds it
qinit ls                                                 # slot, name, state, version, codeHash, feeReserve — no balance
```

The 50 qu are real: `GET /live/v1/balances/<contract>` moves from 1000 to 1050 and the investor drops by 50. Bug A
is the same shape with a sharper edge: the contract ends holding **1252** qu while its `treasury` field says
**1250**, so 2 qu are stranded and the discrepancy exists only between a state field and a balance Qinit never shows.

Two gaps compound. First, `state` decodes declared contract state and nothing else, `ls` lists code identity, and no
command carries the contract's balance. Second, **no command prints the contract's identity either**: grepping the
full `--json` of `ls`, `state` and `info` for a 60-character identity returns 0 matches in all three, so a developer
cannot even construct the balance query without deriving the address themselves. In this campaign that took
`bytesToIdentity(contractAddress(30))` from the generated runtime, and `contractAddress()` returns raw bytes rather
than an identity string, which is the same trap P1 recorded.

`qinit explorer <identity>` does show a balance, but it needs the identity the CLI will not give you and it is a TUI
that refuses a pipe (F23/F25). Adding the contract balance to `ls --json` and `state --json`, and the contract
identity to both, would make the entire class visible. Control: the same session's `--trace` host calls do report
`transfer <id> 9748`, so what the contract *paid out* is observable; only what it *holds* is not.

### Friction — P3

| where | what |
|---|---|
| `call --proc` without `--trace` | F22 again, and this time it cost a whole cycle: a `Register` that was rejected `-1` because a previous round was still open reported `out: null`, so the next twenty minutes were spent diagnosing a settlement that had never been re-registered. A procedure's return value is the first thing a developer checks. |
| contract state carried between probes | a rerun against a node still holding the previous scenario's round silently changed the meaning of every later row; a fresh node per bug is mandatory, which on core costs a restart each time (F68 makes reusing one worse). |
| `qinit debug` reachability | the one view that solved bug B is a TUI with no `--json` and no non-interactive form, so none of it can go into a bug report, a CI log, or this ledger without a tmux capture. |

### F73 — after `epoch advance`, the core dev node keeps ticking and reporting healthy but **permanently stops including transactions**; every procedure, transfer and deploy silently does nothing while reads keep working

Severity: **critical** — the primary runtime becomes write-only-dead after a documented, routine command, with no error, no fault, and a healthy `node status`. It makes a core node single-epoch: every contract with epoch lifecycle can be exercised exactly once.

Clean A/B on a freshly restarted node, `~/Projects/qinit-c6/bin/repro-epoch-inclusion.sh`:

```
=== fresh node, epoch 229
  deploy                                    ok
  call --proc Launch Register  --amount 1000 --trace   ->  1     ok=true
  call --proc Launch Invest    --amount 500  --trace   ->  500   ok=true
  trace frames: 6
=== advance the epoch
  attempt 1 switched=false     attempt 2 switched=false     attempt 3 switched=true  (229 -> 230)
  node ticking?  77702706 -> 77702710 in 4 s     epoch=230  ticksLeft=2692
  node status:   {"up":true,"ticking":true,"fault":null,"error":null}
=== after the advance — the identical calls
  call --proc Launch Invest --amount 500 --trace   ->  out null, ok=false, error null, exit 1
  deploy                                            ->  ok=false "upload begin not confirmed after retries"
  trace frames: 6 -> 7      (the only new frame is END_EPOCH from the transition itself)
  call --fn Launch Info                             ->  roundSeq 1, treasury 1000   (reads unaffected)
  "UploadBegin received" lines in node.log:  2      (both from before the advance — the new one never arrived)
```

The node is genuinely alive: ticks advance, 2 692 ticks remain in the epoch, `node status` reports `up`, `ticking`,
no fault, and every read-only road answers correctly off current state. Only inclusion is dead, and it does not
recover: observed across more than five minutes and several hundred ticks in four separate sessions.

**The simulator is unaffected**, same script, same contract, same commands:

```
advance attempt 1 switched=true
ticking? 6015 -> 6029
after the advance:  call --proc Launch Invest -> ok=true, out -1 (the round had settled — correct contract logic)
                    deploy                    -> ok=true
```

So this is core-only, and it is distinct from F68: there the advance itself fails (`switched:false`) and the node
freezes at the F10 wait with `ticksLeft 0`; here the advance **succeeds**, the node keeps ticking into the new epoch,
and inclusion stops anyway. Both are failures of the same `/live/v1/dev/advance-epoch` route.

What a developer sees instead of the truth: a procedure call exits 1 with `ok:false`, `error:null` and the warning
`(no trace captured — is the debug toggle available on this node?)`, and a deploy blames its own upload with
`upload begin not confirmed after retries`. Neither mentions the epoch, and `node status` actively says the node is
fine. The only way out found is `qinit node run --restart`, which discards every deployed contract (F30).

**This single cause explains four earlier symptoms in this campaign**: the P1 donation test failing on core, the
"lost transfers" filed as F70, the P4 v2 upgrade failing to deploy twice, and several P1 spec failures on core that
all ran after an epoch advance.

### F70 — withdrawal corrected

The withdrawal above blamed a *frozen* node (F68). That was only half right: the observation (transfers stop landing)
was correct and the cause is **F73**, which stops inclusion whether or not the node is also frozen. The transfer path
itself is sound — all three transfer roads land on a fresh node, as the withdrawal shows. Keeping both notes: the
first correctly cleared `buildSignedTx`, the second names the real cause.

## P4 — v2 and v3 in production, with users' money already in the state

v1 was deployed, a round was registered, funded by two investors and settled, so the upgrade ran against real state
(a settled round, a populated `investors` HashMap, a `history` Collection entry, a `settled` BitArray bit, and a
treasury). **On core the upgrade could not be tested at all**: the settle step needs an epoch advance, and F73 then
blocks every later deploy (`upload begin not confirmed after retries`, twice, on a healthy ticking node). The phase
therefore ran on the simulator.

**v2, growing the state with a `MIGRATE`** written from `doc/contracts.md` "Implementing a MIGRATE Procedure" —
an `OldStateData` struct holding the v1 layout verbatim, and a `MIGRATE_WITH_LOCALS` copying every field across and
seeding the new one:

| check | v1 | after the v2 deploy |
|---|---|---|
| state size | 22 816 | **22 880** (+64, the new `Array<sint64,8>`) |
| treasury · roundSeq · status · raised · epochsSeen | 1000 · 1 · 3 · 500 · 1 | **all identical** |
| the new `recentFees[0]`, seeded from the old treasury by MIGRATE | — | **1000** |
| containers seen by `state --json` | investors, history, settled | **investors, history, settled, recentFees** (index 4, array, capacity 8) |
| the MIGRATE frame in the trace ring | — | `kind 3, ok:true, 6 diff rows` |

So the whole upgrade path works and is observable: `deploy` runs the migration, no data is lost, `state` picks up the
new field as a container without being told, and the migration itself is a first-class trace frame. That is the
cleanest end-to-end result of the campaign so far and it had never been exercised with real money in the state.

### F74 — a generated client has no version guard, so after an upgrade that reorders fields it silently returns wrong values, while `qinit call` on the same contract is protected

Severity: **medium (silent wrong value in the road an application actually uses)**.

v3 is a refactor any developer would make: two adjacent `sint64` fields swapped in a public output struct.

```cpp
struct Info_output {  … sint64 donations;  sint64 treasury;  … };   // v3 swapped these two
```

```
qinit deploy                                   # ok, slot 30, no warning
qinit call --fn Launch Info --json             # {"treasury":"1000","donations":"0"}      <- the truth
bun stale.ts   (the client generated before the upgrade, unchanged)
#   stale client sees: treasury = 0   donations = 1000                                    <- silently swapped
```

The client embeds its ABI schemas as JSON literals at generation time (`packages/build/src/generate/client.ts:143-150`)
and carries no code hash, so it decodes v3's bytes with v2's layout and returns confident, wrong numbers. Nothing
warns: the deploy reports no warning, and the client throws nothing.

The CLI's own road does guard — `docs/cli-guide.md` §6.2 states that call and debug lookup reject a local
`qinit.idl.json` when the local and deployed code hashes differ — so the protection exists and simply was not
extended to the artifact that applications import. A code-hash check at construction, or a regeneration warning when
the deployed hash moves, would close it. Control: the same stale client read v2 correctly when the upgrade only
**appended** a field, which is why this stays silent in the easy case and bites on the first reorder.

### Friction — P4

| where | what |
|---|---|
| upgrades on core | untestable end to end: any product that settles at an epoch boundary hits F73 before it can deploy v2 |
| `dist/clients/` | the generated client imports `./runtime`, so a copy kept as a "v1 client" for comparison does not run until `runtime.ts` is copied beside it; worth a note in the generated header |
| `deploy` on a contract whose entry layout changed | no warning of any kind, even though the node holds the previous code hash and the CLI already compares hashes elsewhere |

### F73 — root-cause investigation (core-lite `1beae69a`)

**Proven: why every write reports success.** The route the CLI posts to,
`src/extensions/http/controller/rpc_live_controller.h:388` `POST /live/v1/broadcast-transaction`, never touches the
pending transaction pool. It decodes the body, checks validity and signature, wraps the bytes in a
`BROADCAST_TRANSACTION` header, calls `enqueueResponse(NULL, header)` to broadcast it to peers, and immediately
answers `{peersBroadcasted: 1, transactionId: …}`. A 200 with a transaction id therefore means *queued for
broadcast*, not *accepted*. Nothing on that path can report inclusion, which is why the CLI's success is unrelated
to whether anything will run.

**Proven: writes need a peer round trip that reads do not.** A transaction only enters the pool through
`processBroadcastTransaction` (`qubic.cpp:1899`, `pendingTxsPool.add(request, true)` behind `isMainMode()`), which is
the *peer* request handler. The dev node reaches it because it peers with itself over `--peers 127.0.0.1`, so a
locally posted transaction leaves the node and comes back. Every read route is served directly by the HTTP
controller and never crosses that boundary. That asymmetry is exactly the observed one: after the advance, reads are
perfect and writes vanish.

**Ruled out, each with evidence:**

| candidate | evidence against |
|---|---|
| the transition not finishing | the log shows the full sequence every time: `endEpoch() done` → `saving system state` → `beginEpoch() done` → `=== EPOCH TRANSITION: COMPLETE ￨ now epoch 230 ￨ initialTick 77702702` |
| the pending pool left on the old epoch's window | `pendingTxsPool.beginEpoch()` (`src/ticking/pending_txs_pool.h:476-532`) ends with `firstStoredTick = newInitialTick` unconditionally, so the 32-tick window tracks the new epoch, and a `tick + 8` target sits inside it |
| request processors still parked | `epochTransitionState = 0` (`qubic.cpp:8501`) executes *before* the COMPLETE line that the log shows, so the park loop at `:3038` releases |
| the node demoted out of main mode | `endEpoch` swaps the mode bits at `:6122`; the node boots `MAIN&MAIN` (logged at startup, `mainAuxStatus = 3` from `--node-mode 3`), and 3 is the fixed point of that swap, so `isMainMode()` stays true. The documented "node stops voting after one transition" hazard applies to modes 1 and 2, not to how Qinit launches it |
| the tick pipeline changing shape | tick status lines are identical before and after the switch: same counters, same `3￨2￨2 1/1/1`, same `tx=` distribution |

**Not yet proven:** which step of that loopback round trip stops delivering after the transition. It is one of the
self-peer connection's post-transition state or the inclusion side that pulls from the pool at
`qubic.cpp:5412`/`7146`. The experiment that would settle it in one run is a debug build, where
`processBroadcastTransaction`'s `!defined(NDEBUG)` branches log `valid` and `verified` per transaction: if those
lines appear after the advance the loss is on the inclusion side, and if they do not the transaction never completes
the peer round trip.

**Practical consequence for a developer, independent of the remaining unknown:** treat a core dev node as
single-epoch. Restart it after any epoch advance, and never read a 200 from `broadcast-transaction` as evidence that
anything was accepted.

### F73 — root cause found, by instrumenting a release node

Method (a debug build is not usable for this node, so the probes are release-safe `logToConsole` calls): four log
points added to `src/qubic.cpp` on a `build-wasmchk` Release build (`LITE_WASM_SC`, `TESTNET`, `TESTNET_LITE_RAM`) —
`RX` on entry to `processBroadcastTransaction`, `POOL` on the result of `pendingTxsPool.add`, `PUB` at the
publication site, and `EXEC` counting `nextTickData.transactionDigests` and `tsCurrentTickTransactionOffsets` at the
tick execution loop. The instrumented binary was swapped into the Qinit cache and driven by the CLI exactly as the
original observation was.

The transaction is **not** lost on the way in. Every stage succeeds identically before and after the epoch advance:

| stage | control (healthy) | after the advance |
|---|---|---|
| reaches the peer handler | `RX tx tick=77700026 sysTick=77700018 main=1` | `RX tx tick=77702715 sysTick=77702707 main=1` |
| enters the pending pool | `POOL add=1 tick=77700026` | `POOL add=1 tick=77702715` |
| published into the node's own tick data | `PUB tick=77700026 pending=1` | `PUB tick=77702715 pending=1` |
| **executed in the tick** | `EXEC tick=77700026 digests=3 offsets=3` | **no EXEC line at all** |
| outcome | `found=true`, balance +4242 | `found=false`, balance unchanged |

The `EXEC` probe logs whenever a tick has any transaction digest or any stored offset. After the transition it stops
firing entirely, which means every tick executes with `nextTickData` holding **zero** transaction digests, even
though the node had just published tick data containing the transaction.

The node's own status line names the reason. Its documented meanings are `tx=?` for "votes have not converged on
next-tick digest yet", `tx=empty` for "next tick is expected to be empty", and `tx=K/T` for known transactions:

```
before the transition   40 × tx=?    18 × tx=empty      (digests converge; ticks execute)
after  the transition   40 × tx=?     0 × tx=empty      (never converges again)
```

**Root cause:** after an epoch transition the node never again converges on a next-tick-data digest, so the agreed
`nextTickData` stays empty forever. Ticks keep advancing because empty ticks still process, which is why the node
looks healthy, reads keep working and `node status` reports `ticking`. Every transaction is received, accepted into
the pending pool and published into the node's own candidate tick data, and then dropped on the floor because the
tick that actually executes contains nothing. It is a tick-data agreement failure after the epoch boundary, not a
transaction-path failure — which is why no error is produced anywhere: from each component's own point of view
nothing failed.

**Not reproducible on a short epoch.** With `TESTNET_EPOCH_DURATION` lowered to 2001 and the node paced at 100 ms,
`advance-epoch` switched on the *first* attempt and transactions kept working afterwards
(`RX` → `found=true`, balance moved). The failure appeared only when the advance needed more than one attempt, which
is the F68 timeout path. So **F73 follows F68**: an advance that reports `switched:false` before succeeding leaves
the node unable to agree tick data again. Reducing the epoch length is therefore also a practical workaround, since
it keeps the transition inside the route's 25-second budget.

Two incidental notes from the same build. `TESTNET_EPOCH_DURATION` cannot be lowered freely: `EpochRevenueData`
holds five `unsigned short` arrays of `MAX_NUMBER_OF_TICKS_PER_EPOCH`, so `epoch + 3` must be a multiple of 4 or a
static assertion fails with a padding mismatch, and `REVENUE_HALF_WINDOW` is `NUMBER_OF_COMPUTORS - 1`, which is 7
on this build rather than the 675 its comment claims. And a **natural** epoch rollover parks the node at the same
F10 prompt as a forced one, so F68 is not specific to `advance-epoch`.

### F73 — mechanism refined to the consensus layer (second instrumentation pass)

The first pass proved the transaction is received, pooled and published. A second pass instrumented the tick-data
handler's five validation gates, the signature check, the store, the vote conclusion and the timeout-discard branch,
on the same `build-wasmchk` Release node.

Every gate on the incoming tick data passes identically before and after the transition — `epoch`, `future`,
`inStorage`, `leader`, `time` all 1, signature `ok=1`, and the node still broadcasts its own future tick data with
`digests=2`. The divergence is one field, in the vote conclusion (`F73 VOTES`):

```
before   known=1 targetEmpty=0    -> real tick data agreed, tick executes (EXEC digests=2)
after    known=1 targetEmpty=1    -> quorum agrees the next tick is EMPTY  (INVAL fires, EXEC digests=0)
```

So after a slow transition the node reaches quorum on the next-tick digest **and the agreed digest is zero**. It then
invalidates its own stored tick data (`ts.tickData[nextTickIndex].epoch = INVALIDATED_TICK_DATA`, `qubic.cpp:8128`,
the `isZero(targetNextTickDataDigest)` branch), so the tick executes empty even though non-empty tick data carrying
the transaction was stored and published a moment earlier. The next tick's data is then built empty too, and it never
recovers.

The timeout-discard path (`qubic.cpp:8262`, `!targetNextTickDataDigestIsKnown && isTickTimeOut()`) is **not** the
trigger: its probe logged zero decisions across the whole run. The empty conclusion comes from the vote tally itself,
`targetNextTickDataDigest` resolving to zero.

**Tie to the F10 clear-memory step (the user's pointer).** `beginEpoch()` runs behind `PAUSE_BEFORE_CLEAR_MEMORY`
(`qubic.cpp:6111-6112`): it sets `epochTransitionCleanMemoryFlag = 0` and waits for an operator F10 keypress — or the
dev route forcing the flag — before clearing RAM and rebuilding consensus state (`score->initMemory()`, the vote
counter, `etalonTick`). F73 reproduces only when that step is slow enough that `advance-epoch` first returns
`switched:false` (the F68 timeout); on a short epoch that clears in one attempt the node keeps including transactions.
The remaining question is which piece of consensus state the forced clear-memory path leaves stale so that the
first post-transition vote tally concludes empty and self-perpetuates. That is a core-lite consensus bug, not a
Qinit one; the node-side owner should look at the vote-counter / `etalonTick.expectedNextTickTransactionDigest`
re-initialization across the `PAUSE_BEFORE_CLEAR_MEMORY` path.

### F73 — buggy code and the fix

**Trigger config (confirmed).** `src/qubic.cpp:1055-1056`:

```cpp
#if ENABLED_LOGGING && !defined(LONG_RUN_LOCAL_TESTNET)
#define PAUSE_BEFORE_CLEAR_MEMORY 1   // requires an operator F10 keypress before clearing RAM at each epoch switch
```

The qinit dev node builds with `ENABLED_LOGGING = 1` (`src/logging/logging.h:24`, logging is on) and does **not**
define `LONG_RUN_LOCAL_TESTNET`, so `PAUSE_BEFORE_CLEAR_MEMORY = 1`. Every epoch transition therefore stops in
`beginEpoch()` at `WAIT_WHILE(epochTransitionCleanMemoryFlag == 0)` (`qubic.cpp:6111-6112`) for an F10 keypress that
never comes on an unattended node.

**The line that leaves the node broken.** The dev route exists to drive past that wait, but abandons the transition
it started when the transition outlasts 25 s (`rpc_live_controller.h`, the `advance-epoch` route):

```cpp
while ((unsigned int)system.epoch == startEpoch) {
    epochTransitionCleanMemoryFlag = 1;
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    if (elapsed.count() > 25000) break;          // <-- gives up mid-transition
}
tickDelay = savedTickDelay;                       // <-- restores pacing while the transition is still running
if ((unsigned int)system.epoch == startEpoch) forceSwitchEpoch = false;   // <-- unsets the switch mid-flight
```

That `switched:false` return is F68, and it is F73's necessary precondition: on a transition that clears in one
attempt the node keeps including transactions; only the timed-out, half-driven transition leaves the post-transition
vote tally concluding empty forever (`qubic.cpp:8128` then invalidates the real tick data — that line is a victim,
not the bug).

**Fixes, in order of preference:**

1. **Force the pause off for the unattended dev node (one line, removes the whole class).** An unattended
   `TESTNET_LITE_RAM` node has no operator to press F10, so the pause has no purpose. Extend the guard at
   `qubic.cpp:1055`:
   ```cpp
   #if ENABLED_LOGGING && !defined(LONG_RUN_LOCAL_TESTNET) && !defined(TESTNET_LITE_RAM)
   ```
   This is the fix to ship: no F10 wait means no 25 s race, no `switched:false`, and no F73. It also fixes F68.

2. **Make the route not abandon a transition it started.** Remove the 25 s `break`, or do not reset `tickDelay` /
   `forceSwitchEpoch` until `system.epoch` has actually advanced. As written, timing out leaves the transition
   driven partly under `forceSwitchEpoch = true, tickDelay = 0` and partly not, which is the prime suspect for the
   stale consensus state.

3. **If the pause must stay, fix the deeper consensus bug.** The first post-transition vote tally concludes
   `targetNextTickDataDigest = 0` (empty) and self-perpetuates, even though the node published and stored non-empty
   tick data for the same tick. That points at vote-counter / `etalonTick.expectedNextTickTransactionDigest`
   re-initialization across the clear-memory step in `beginEpoch()`; pinning it to one line needs a further trace and
   is moot once fix 1 is in for the dev node.

Fix 1 is one line, matches the documented intent (the pause is an operator affordance, disabled for the long-run
unattended build), and closes both F68 and F73.

### F73 — fix applied and confirmed

Applied fix 1 (`src/qubic.cpp:1055`, one line):

```diff
-#if ENABLED_LOGGING && !defined(LONG_RUN_LOCAL_TESTNET)
+#if ENABLED_LOGGING && !defined(LONG_RUN_LOCAL_TESTNET) && !defined(TESTNET_LITE_RAM)
```

Rebuilt `build-wasmchk` (Release, LITE_WASM_SC/TESTNET/TESTNET_LITE_RAM), swapped into the qinit cache, driven by
the CLI with the same A/B as the original observation:

| after `advance-epoch` | before the fix | after the fix |
|---|---|---|
| plain transfer | `found=false`, LOST | **`found=true`, LANDED (+4242)** |
| `qinit deploy` | `upload begin not confirmed after retries` | **`ok`, slot 30** |
| `call --proc Register` | `ok:false`, no run | **`ok:true`, out `1`** |
| advance attempts | 2 (first `switched:false`) | **1 (`switched:true`)** |
| `press F10` lines in node.log | 143 | **0** |

Held across two consecutive epoch advances plus a fresh deploy. Scope is correct: the guard drops the pause only when
`TESTNET_LITE_RAM` is defined (the unattended lite dev node); mainnet (`LITE_WASM_SC` off) and long-run builds keep
their existing behaviour. This closes **F68 and F73** together. The change is left uncommitted in the core-lite
working tree; the released node binary in the qinit cache was restored. (Note the pre-existing local `TESTNET*`
defines at `qubic.cpp:54-56` are build-local and must not be committed with the fix.)
