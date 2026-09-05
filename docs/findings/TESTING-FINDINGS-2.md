# qinit CLI test campaign 2 — findings (F22+)

Binary: `/home/kali/Projects/Qinit/dist/qinit` built 2026-09-03 18:40 from `179f8330` (after the F2/F3/F4/F13/F14/F17/F20 fixes).
Node pinned: `qinit-v0.0.43` (`--ref qinit-v0.0.43` on every `node run`; 0.0.44 was still publishing).
Template workspaces: `~/Projects/qinit-c2/<name>`. Probe workspace: `~/Projects/qcounter-qinit/Counter`.
Skipped: Windows paths (no Windows host).

## Findings

### F22 — `call --proc … --json` reports `caller: null` and `out: null` unless `--trace` is also given
`qinit call --proc Tcounter Inc --json | jq .caller` → `null`; the same command with `--trace` → the signer's
60-char identity. The CLI signed the transaction, so it knows the caller before any trace exists; `qinit debug`
shows the same identity for that tick. Machine consumers reading `caller` from an untraced result get `null`. Same for `out`: `qinit call --proc Mig Inc --json` → `out: null`; with `--trace` → `out: "2"` (core 0.0.44, same on the simulator). A procedure's return value is only reported when tracing is on, and nothing says so.
Simulator × clang (Tcounter template, v0.0.43). Severity: wrong/missing value in `--json`.

### F23 — `qinit explorer <identity>` outside a terminal reports "qinit crashed"
`qinit explorer <identity> | cat` → `✗ qinit crashed: explorer is interactive — run it in a terminal (it has no
--json or piped output)`. The refusal is correct (Ink TUI), but it is labelled a crash, and `--help` advertises
the quick-jump forms (`explorer 7474`, `explorer <identity>`) with no note that they need a TTY. Severity: cosmetic.

### F24 — `--json` is accepted but ignored by seed, runtime, compiler, system, gen and doctor
`qinit seed --show --json`, `runtime --show --json`, `compiler --show --json`, `system ls --json`, `gen --json`,
`doctor --json` all exit 0 and print the Ink panels (header, spinner, box-drawing), not JSON. The flag is not
rejected either, so a script sees exit 0 and unparseable text. Contrast `explorer`, which refuses cleanly.
Also in the honoured set the envelope is uneven: `ls`, `info`, `version` carry no `ok` key while every other
`--json` result does (failure results always do). Severity: cosmetic / API consistency.

### F25 — `qinit debug` in a pipe never exits; `explorer` in the same situation refuses with a message
`timeout 15 qinit debug Tcounter < /dev/null > /dev/null` → exit 124. The live-capture TUI keeps rendering
frames to a non-TTY forever (each redraw is appended as plain text). `qinit explorer` detects the same
condition and exits 1 with "explorer is interactive — run it in a terminal". Severity: cosmetic, but it
wedges any CI step that calls `debug` by mistake.

### F26 — a procedure signed by an unfunded seed shows `✓ processed` and blames the debug toggle for the missing trace
```
qinit call --proc Tcounter Inc --seed bbbb…(55×b) --trace
██████████████████████ 100% tick 3696→3695
✓ Tcounter.Inc  processed
  tx   bsedwifgmmhomgkilzjybpxdwvzaftgiijznqytileerhpchfgcozfwehrcj
  tick 3695
(no trace captured — is the debug toggle available on this node?)
```
`--json`: `{"ok":true,"caller":null,"tx":"…","tick":3510,"error":null,"state":null}`. No line mentions the
signer, its balance, or a warning (grep for fund/balance/warn/spectrum over the whole output: 0 hits).
Node verdict via `GET /live/v1/tx-status/3572/<tx>`: `found:true, processed:true, moneyFlew:false` — the
transaction landed in the tick, but the procedure never ran: no debug-trace entry, counter unchanged at 4.
Control: the saved funded seed's Inc right after → `4 → 5`, trace captured, `moneyFlew:true`.
That is Core's rule (an identity with no spectrum entry cannot invoke a procedure), so "processed" is
defensible, but the diagnostic points at the wrong cause. The CLI knows the signer's identity and could
check its balance (it already does for the *saved* seed: `qinit seed --show` prints the balance).
Simulator × clang, v0.0.43. Severity: wrong diagnostic on a silently skipped write.

### F27 — `--amount` on a `--fn` call is silently accepted
`qinit call --fn Tcounter Get --amount 5 --json` → `{"ok":true,"out":"5"}`. A function call carries no
transaction and no amount; the flag does nothing and nothing says so. Severity: cosmetic.

### F28 — `qinit test` silently scaffolds a counter-shaped `tests/<Name>.test.ts` for every contract, then fails it
`qinit new t-hashmap --template hashmap` ships only `tests/Thashmap.test.cpp`. Running `qinit test` in that
project writes `tests/Thashmap.test.ts` (no line in the output says so) containing
`expect((await c.Get()).value).toBe(0n); const r = await c.Inc(); …` — the counter template's test — and then
reports `TypeError: c.Get is not a function`, `0 pass 1 fail`. Same for the asset template (`c.Get`/`c.Inc`
do not exist there either). The SDK it generated is right (`2 fn / 1 proc`), so the scaffold ignores the IDL
it just produced. Only the counter template passes, because the placeholder happens to match it.
Severity: loud failure on a legal project, plus an unannounced file write into `tests/`.

Addendum: sending 1 000 qu to that identity from the explorer wallet (`4 wallet`, review → send, `✓ processed ·
money moved: yes`) and repeating the same `--seed` call gave `caller: DJZM…HTFL`, `counter 5 → 6`, trace captured.
So the whole difference is "signer has a spectrum entry", and that is what the diagnostic should say.

### F29 — the explorer's identity view lists never-executed transactions as transfers, one of them `-10` out of a 0-qu account
`qinit explorer DJZM…HTFL` (the unfunded identity from F26, before funding) shows `0 qu`, `outgoing 0 (0 transfers)`
in the header, then a `TRANSFERS 5 in the node's recent window` table with five OUT rows to `Tcounter #29`, amounts
`0, 0, 0, -10, …`. The `-10` row is the `--amount 10` attempt: tx-status says `moneyFlew:false`, the RPC balance
route says `outgoingAmount 0`, yet the table shows 10 qu leaving. Header and table disagree, and a reader would
conclude the account paid. Severity: cosmetic / misleading value.

### F11 (extension) — an `enum` member in an input/output struct: clang and `verify` reject, `--compiler typescript` builds
`struct Shapes_input { …; Color color; Mode mode; bit flag; };` with `enum Color : uint8 {…}` / `enum Mode {OFF, ON}`
declared inside the contract. `qinit build --compiler clang` and `qinit verify` → `Shapes_input is not allowed as
input/output type. The input and output structs … may only use integer and boolean types … id, Array, and BitArray`.
`qinit build --compiler typescript` → `ok:true, size 7107` — and the wasm is byte-for-byte the same size as the
integer-typed rewrite, so the backend silently treats the enum as its integer. Same gap as F11 (the TS backend runs
no protocol-rule gate), new shape. Source kept at `~/Projects/qinit-c2/Probe.enum-io.h`. Severity: accept/reject divergence.

### Observation — `qinit build` needs free slots on the live node, even for a build
With 29–31 occupied by three templates, `qinit build contracts/Probe.h` (Probe + callee Trap) fails with the deploy-time
message `cannot assign 2 project contracts to dynamic slots 29..32 while keeping every callee below its caller`, and
`--slot 32` does not help (the callee still needs a slot below). `--rpc http://127.0.0.1:1` (an unreachable node)
builds fine with local slots, as `build --help` hints. Not filed as a defect (CONTRACT_INDEX is baked into the wasm),
but the four-slot window means the `intercontract` template cannot be deployed next to three other contracts at all,
and the message never mentions `--rpc` or the window size as the way out.

### F30 — restarting the simulator discards every contract and all state; `--keep` does nothing there
Deployed Tcounter (v1, one Inc) → `qinit node stop` → `qinit node run --ref qinit-v0.0.43 --keep --history-ticks 50`
→ `contracts (none)`, tick back to 3002, `qinit ls` shows four empty slots, `debug-trace` has 0 entries,
`qinit call --fn Tcounter Get` → `no contract 'Tcounter' (deployed or system — run qinit node run to load system
contracts)`. Same result without `--keep`. `node run --help` documents `--keep` as "preserve existing node data",
and the scratch dir (`~/.cache/qinit/run`) holds only `node.log`/`node.pid`, so there is nothing for it to keep.
Meanwhile the project's `qinit.idl.json` still says `Tcounter @ 29`, and nothing at `node run` time says the
previous deployments are gone. Simulator only (core not yet checked). Severity: wrong diagnostic — a documented
flag that is a no-op, and a stale local record after the wipe.

### F32 — a trapped procedure halts the simulator for good, and no command says so
The simulator deliberately turns a contract abort into a terminal fault (`qubic-simulator.ts` `terminalFault`,
commit a199a675 "Align engine behavior with Core"). That is design. What is not: nothing in the CLI reports it.
```
qinit call --proc Probe Assert --args '{"n":50}' --trace     # CC_ASSERT(input.n < 10)
✓ Probe.Assert  broadcast · unconfirmed
✗ Probe proc#4 (Assert) 431µs · tick 3036
  state
    asserted 0 → 50
  trap   abort(3422552174)
```
- The same call with `--json`: `{"ok":true,"error":null,"state":[{"text":"5 → 50"}], …}` — no `trap` key exists in
  the envelope (keys: ok, contract, slot, entry, kind, tick, tx, out, error, execNs, caller, in, state, logs), so a
  script cannot tell this from a success. The 15 later steps of my suite then all failed with
  `engine faulted: abort(3422552174)` — including `qinit epoch advance` and `qinit tick advance`.
- `qinit node status` afterwards: `✗ rpc: up, not yet ticking` — wrong cause; `qinit tick` shows the tick and
  nothing else. Only `GET /live/v1/tick-info` / `/live/v1/dev/fault` carry
  `{"message":"abort(…)","phase":"transaction","failedTick":3111,"slot":30,"kind":1,"entry":4,"txId":"…"}`.
- `qinit state Probe` after the fault returns `asserted 50` — the write from tick 3111, which never finalized
  (`lastFinalizedTick 3110`). Whether the halted node should serve the aborted tick's working copy is a design
  choice, but a reader comparing it with `tick 3110` gets a contradiction.
Control: `Assert(5)` → `out 5`, node keeps ticking. `abort(3422552174)` = `0xCC00006E` = line 110, the assert.
Severity: silent wrong result in `--json` (ok:true for a trap), then a misleading `node status`; the only recovery
is `qinit node run`, which F30 says wipes everything.

### F33 — `call --trace` never returns on a procedure whose state diff has 524 289 rows; `--json` takes 3.7 s
`Big` holds `Array<uint64, 524288>` (4 MB). `qinit call --proc Big Fill --args '{"stride":1,"value":7}' --trace --json`
→ 3.7 s wall, `execNs 577 ms`, `state` array of 524 289 rows, `out 524288`. The same call without `--json` prints
the progress bar to `100% tick 3035→3033` and then nothing for 10 minutes (killed by `timeout`); the node kept
ticking and the write landed (`Sum` afterwards is correct). Control: `stride 4096` → 128 rows, rendered in full
in well under a second. So the human renderer, not the node or the fetch, is the part that does not scale — and it
has no cap or "N more rows" fold for a diff of this size. `qinit state Big` renders all 524 288 lines in 2.1 s,
`--digest` 0.2 s, `--dump` 1.5 s for an exact 4 194 312-byte file, deploy 2.0 s. Severity: loud (the command hangs),
on a legal if large contract.

### F34 — `qinit epoch advance` advanced two epochs: the RPC client retries a side-effecting GET on timeout
With `Probe` (BEGIN/END_TICK sysprocs) and `Big` (4 MB state) deployed on the simulator, `qinit epoch advance` at
tick 3747 issued `GET /live/v1/dev/advance-tick?n=2260`. The engine runs that loop synchronously and it took longer
than the client's 10 s budget; `LiteRpc.get()` (`packages/core/src/net/rpc/client.ts:45`, "GETs are idempotent
reads: a connect/timeout failure is retried") then re-sent the same GET twice more (`tries = 3`, 10 s each).
The node executed all three: the CLI printed `node unreachable at http://127.0.0.1:41841 — is it running?
[request timed out after 10000ms: …/dev/advance-tick?n=2260]` and exit 1, while the node went 3747 → 9002
(epoch 1 → 3, `beginEpochs 2` in the contract's counters; the second and third advances capped at each epoch's end).
`tick advance 5` right after also timed out on `/dev/epoch-info` and returned nothing. The dev routes
(`advance-tick`, `advance-epoch`, `tick-ms`) are all GETs with side effects, so every one of them can be replayed
by this retry. Severity: silent wrong state (the developer asked for one epoch and got two, and was told the node
was down), on the simulator. Root cause is the mix of a 10 s client timeout, a synchronous multi-second engine loop,
and retry-on-timeout for a non-idempotent route.

### F35 — while the node is busy, `qinit call` reports `no contract 'Probe'` instead of "node busy/unreachable"
During the F34 advance, `qinit call --fn Probe Counts --json` → `{"ok":false,"error":"no contract 'Probe'
(deployed or system — run qinit node run to load system contracts)"}` and `qinit call --fn Trap Calls` → `no contract
'Trap'`. Both contracts were deployed and answered fine 30 s later. The registry read timed out and the CLI turned an
empty answer into "not deployed", which sends the developer to redeploy. Severity: wrong diagnostic.

F34 addendum — the per-tick cost that makes the budget too small: with `Big` (4 MB) + `Probe` deployed,
`qinit tick advance 100` → 4.1 s (≈41 ms/tick); `tick advance 500` → 30.8 s and `node unreachable` (3 × 10 s),
while the node advanced anyway. Control on a fresh simulator with only `Probe`+`Trap`: `tick advance 100` → 0.5 s; after deploying `Big`: 4.1 s. So a 4 MB contract costs ≈36 ms per tick even when nothing calls it — one epoch (3 000 ticks) is ≈2 minutes of `epoch advance` against a 10 s client budget.

### F36 — a callee's `CC_ASSERT` is swallowed: caller sees `boomErr 0`, callee's partial write persists, node keeps ticking
`Probe.CallTrap(n=0)` → `INVOKE_OTHER_CONTRACT_PROCEDURE_E(Trap, Boom, …, boomErr)`; `Trap.Boom` does
`state.mut().calls += 1; CC_PRINT(…); CC_ASSERT(input.n != 0);`.
```
✓ Probe proc#8 (CallTrap) 2.1ms · tick 10750
  out    {got: 0, callsBefore: 1, callsAfter: 2, boomErr: 0}
  state (no change)
  print  Probe:168 before invoke 0
  print  Trap:23 Trap.Boom n 0
  print  Probe:171 after invoke 0
  host   callFunction → @29 fn #1
  host   invokeProcedure → @29 proc #1 reward=0
⚠ Trap trapped inside this call: abort(3422552088)
```
`Trap.Calls` afterwards → `2`: the increment before the failed assert stayed. The caller's error variable is `0`
(no error), `--json` for the call is `ok:true` with no trap field (F32), `/live/v1/dev/fault` is `null`, and the
node keeps ticking. Compare F32: the same `CC_ASSERT` at the top level is a terminal fault. So a trap's effect
depends on call depth — halt the node at depth 0, silently succeed with partial state at depth 1. On Core a wasm
trap has no "nested" special case, so one of the two behaviours is off; the core-lite cell below decides which.
(The print stream itself is right: `Probe:168 → Trap:23 → Probe:171`, tagged — the F13 fix holds on the simulator.)
`abort(3422552088)` = `0xCC000018` = Trap.h line 24, the assert. Severity: silent wrong state (partial callee
write kept, error code 0) — pending the core comparison.

### F37 — on core-lite, a callee's trap wedges the node: unrelated calls return the callee's abort code, then the node stops ticking
Reproduced in isolation on a freshly started `qinit-v0.0.43` core node with only `Probe`@30 + `Trap`@29 deployed
(no other contract, no epoch/tick commands, nothing else run):
```
qinit call --proc Probe CallTrap --args '{"n":0,"reward":0}' --trace
✓ Probe.CallTrap  broadcast · unconfirmed
  tx   rvqjcghychjeycotmvwsgehqjardzjzfzziahyqnadhmfbuoiatxviuaprtg
  tick 77700053
(no trace captured — is the debug toggle available on this node?)

qinit call --fn Trap Calls   → querySmartContract: code=-1 Error calling smart contract function: 3422552088
qinit call --fn Probe Counts → node unreachable at http://127.0.0.1:41841 …
```
`Trap.Calls` is a plain read with no assert; the code it returns, `3422552088` = `0xCC000018`, is Trap.h line 24,
the `CC_ASSERT` inside `Boom` from the *previous* transaction. After that the node answers nothing:
`/live/v1/tick-info` empty for 15+ s, and `qinit call`/`state` for all three contracts say `no contract '<Name>'`.
The process is alive and its main loop is running (`Main loop duration = 55 mcs`) but the tick number in
`~/.cache/qinit/run/node.log` is frozen (1 732 consecutive lines at `.77708116.232` in the first occurrence,
`.77700053.229` in the isolated repro). Only `qinit node stop` + `node run` recovers, which wipes all state (F30).
Log also carries `Error writting 621806120 bytes from contract0001.230!` once per epoch transition.
Simulator control, same contracts, same call: renders the full trace with the callee's print, `boomErr 0`,
`Trap.Calls` → 2, node keeps ticking (F36). So the two runtimes disagree completely on a nested trap:
simulator swallows it and continues, core wedges. Severity: highest operational — a contract bug in a callee
takes the dev node down, and the error it reports first points at the wrong entry point.

### F38 — on core-lite, a top-level trap silently stops ticking; the trapped slot's functions return the abort code; the CLI calls it "processed"
Fresh `qinit-v0.0.43` core node, `Probe`@30 + `Trap`@29. `qinit call --proc Probe Assert --args '{"n":50}' --trace`
→ `✓ Probe.Assert broadcast · unconfirmed`, `(no trace captured — is the debug toggle available on this node?)`.
Then, for the next several minutes: `tick-info` stays at `77700062` (the trap's tick); `qinit call --fn Probe Counts`
→ `querySmartContract: code=-1 Error calling smart contract function: 3422552174` every time (the assert's code,
returned for a function that has no assert); `qinit call --fn Trap Calls` (other slot) → `1`, fine;
`qinit state Probe` → `asserted 50` (the aborted procedure's write is visible); a further `Assert(5)` procedure is
accepted (`ok:true`) and never runs; `/live/v1/debug-trace` has no entry for the trapped procedure at all — only
the BEGIN/END_TICK rows up to that tick. `qinit node status` → `✗ rpc: up, not yet ticking`, `qinit tick` shows
the frozen number with no hint. This is the core analogue of F32: the tick loop halts on a contract trap (Core's
behaviour), and again nothing in the CLI says so — the developer sees "not yet ticking", a stale abort code on
unrelated reads, and a state that includes the rolled-back write. Recovery: `node stop` + `node run` (wipes, F30).
Compare F37 (callee trap): there the RPC dies too. Severity: wrong diagnostic on a node halt.

### Verified — `qinit integrate` wires a template into real Core correctly
`qinit integrate contracts/Tcounter.h --out <empty dir> --asset TCNT --construction-epoch 230`: with no checkout at
`--out` it clones `https://github.com/qubic/core.git` main (19 MB, 8 s), creates branch `qinit/tcounter`, copies the
header to `src/contracts/Tcounter.h`, appends the `CONTRACT_INDEX 29` block and the
`{"TCNT", 230, 10000, sizeof(Tcounter::StateData) < sizeof(IPO) ? …}` row to `src/contract_core/contract_def.h`,
adds the file to both `.vcxproj`/`.filters`, and scaffolds `test/contract_tcounter.cpp` (5 files, +18 lines, 2 new).
Core main already uses `state.get()`/`state.mut()` and `StateData` (`contract_def.h`, `qpi_macros.h`, `Qx.h`), so
the idiom compiles there. Two things a first-time user hits: without a TTY it refuses unless both `--asset` and
`--construction-epoch` are given (the "asset" is Core's per-contract share name, mandatory by Core design; the
message could say so), and `--asset TCOUNTER` is rejected (`1–7 uppercase letters or digits`) with no hint in `--help`.
The `next` steps it prints are Windows-only (`nuget`/`msbuild`), which matches Core's build. Not filed.

### Verified — templates on core-lite
`qinit-v0.0.43` core node: `Tcounter` (clang) Inc `0 → 1`; `intercontract` template (typescript): `ReadCounter` 0 →
`BumpCounter` → `ReadCounter` 1 and `Counter.Get` 1, callee auto-placed at 30 below the caller at 31; `hashmap`
(typescript) Set/BalanceOf/Stats `5 / {total 5, population 1}`. `qinit system ls` lists the embedded contracts,
`qinit system add QX QEARN` → `already embedded by the core node`. `asset` template not deployed on core: the
four-slot window was full (Syscall, Counter, Tintercontract, Thashmap).

### F39 — a system contract's state differs between runtimes: `QX.Fees` is `1000000000/100/3000000` on the simulator and `0/0/0` on core-lite
User contract `Syscall.QxFees` does `CALL_OTHER_CONTRACT_FUNCTION(QX, Fees, …)`; the CLI can also call QX directly.
Oracle: `Qx.h` INITIALIZE sets `_assetIssuanceFee = 1000000000`, `_transferFee = 100`, `_tradeFee = 3000000`.
| | `call --fn QX Fees` | `call --fn Syscall QxFees` (clang) | (typescript) |
|---|---|---|---|
| simulator | 1000000000 / 100 / 3000000 | same | same |
| core-lite v0.0.43 | 0 / 0 / 0 | 0 / 0 / 0 | — |
`qinit system add QX QEARN` on core says `already embedded by the core node`, and it is — but the lite testnet
starts every epoch from empty contract-state files (`node.log`: `Error opening file … contract0001.229`) and Core
only runs a contract's INITIALIZE in its construction epoch, so QX's state is all zeros there. Nothing in `qinit
system` or the deploy output says that on core the embedded contracts are inert shells. A contract that reads a
system contract's parameters (fees, prices, epoch data) is therefore correct on the simulator and wrong on core, or
vice versa, with no diagnostic. Severity: runtime divergence on a silently wrong value. Whether core-lite should
run INITIALIZE for embedded contracts on a fresh testnet is a core-lite question; the CLI should at least say
which of the two a developer is looking at.

### Verified — `node run --history-ticks 50` prunes as documented (one wording nit)
Simulator, Inc at tick 3114 → `tx-status/3114/<tx>` = `found:true, processed:true`; after `tick advance 80` →
`found:false, processed:true`; `qinit explorer 3114` → "this tick is empty or outside the node's history";
identity view → "no transfers in the retained window" while the header still counts `(1 transfers)`. The
`found:false, processed:true` pair is technically right (tick passed, record pruned) but the generated client maps
`found` to `included`, so a late `confirm` on a pruned tx reads as "not included". Not filed; worth a doc line.
The debug-trace ring is a separate 64-entry buffer and is not governed by this flag.

### Verified — `qinit clean` then `qinit setup --force` from nothing
`clean --dry-run` lists every cache entry with sizes (`would free 718.0MB`: wasi-sdk 552.7MB, four node/header
versions, tools, current.json) and says `re-fetched on next qinit setup`; `clean` removes `~/.cache/qinit` entirely.
`setup --force` with nothing cached: core headers `qinit-v0.0.44` 1.6 s, node binary 24.3 s, WASI SDK 100.7 s,
verifier v1.2.4 2.8 s, 131 s total, `current.json` consistent (headers = node = 0.0.44). Note the pin moved from
0.0.43 to 0.0.44 here, as expected; everything above this line ran on 0.0.43.

### Version note — core-lite `qinit-v0.0.44` (released 2026-09-03 11:50 UTC, checked at the end of the campaign)
- F12 fixed: `Mig` v1 → two `Inc` → v2 with `MIGRATE()` (`a = oldState.a; b = a*1000; migratedAt = qpi.tick()`) →
  `Peek` = `{a: 2, b: 2000, migratedAt: 77700062}`, `/live/v1/debug-trace` has the `kind 3` row
  (`inSize 8`, one diff line) and `qinit debug Mig` shows a `migrate` row.
- Print ordering from a released node: `CallTrap(3)` renders `Probe:168 → Trap:23 → Probe:171` with no
  "this node sends no print order" note (on 0.0.43 the callee's print came last, with the note).
- F37 persists on 0.0.44: `CallTrap(0)` → `Trap.Calls` returns `3422552088`, tick frozen at the trap's tick.
- Probe suite steps 00–17 under `--compiler typescript` on this node match the other three cells (table below).


## Compiler × runtime matrix

Probe suite (`~/Projects/qinit-c2/probe-suite.sh`, steps 00–17: lifecycle counters, money, cheats, state shapes,
cross-contract), one fresh node per cell, `Probe`@30 + `Trap`@29 (+ `Big`@31 on the simulator cells). Fields that
depend on the tick/epoch number are masked (`T`, `E`, `N`); everything else is compared byte for byte.

Cells: clang × simulator, typescript × simulator, clang × core 0.0.43, typescript × core 0.0.44.

| step | value (all four cells) | agree |
|---|---|---|
| 00-counts | `initCalls 1`, `beginTicks = tick − tickAtInit` (simulator: endTicks = beginTicks; core: endTicks = beginTicks + 1, its END_TICK runs before the first BEGIN_TICK), `beginEpochs 0` mid-epoch | ✓ |
| 01-pay-broke | `{result: -100, reward: 0}` | ✓ |
| 02-pay-funded | `{result: 900, reward: 1000}` | ✓ |
| 03-refund-even | `{result: 900, reward: 500}` | ✓ |
| 04-refund-more | `{result: -100, reward: 500}` | ✓ |
| 05-burn | `1390` | ✓ |
| 06-assert-ok | `5` | ✓ |
| 08-warp-tick | `tickAfter − tickBefore = 10`, epoch unchanged | ✓ |
| 09-warp-epoch | `epochAfter − epochBefore = 1`, tick unchanged (and the offset persists: `16-counts` reads `epoch: E+1` in every cell) | ✓ |
| 10-prank | `{seen: "DJZM…HTFL", rewardSeen: 7, after: "BZBQ…QEXK"}` | ✓ |
| 11-shapes-args | `{b1: 1099511627776, c3: 3, color: 2, mode: 1, flag: 1}` | ✓ |
| 12-shapes-in | `{b1: 1099511627776, c3: 3, color: 2, mode: 1, flag: 1}` | ✓ |
| 13-calltrap-ok | `{got: 6, callsBefore: 0, callsAfter: 1, boomErr: 0}` | ✓ |

`17-state` (Probe's full state) is identical across the four cells on every non-tick field:
`initCalls=1 pair={a: 1, b: 1099511627776, c: 3} flag=1 color=2 mode=1 paid=200 asserted=5 lastInvocator=DJZM…HTFL`.
Automated comparison: 14 of 15 step files identical per cell after masking, the 15th (`17-state`) differing only in
`lastTick`/`tickAtInit`. **For what compiles, the two compilers and two runtimes compute the same values.**
Every divergence in this campaign is again at the edges: what a trap does to the node (F32/F36 vs F37/F38), what a
system contract's state is (F39), what `epoch advance` does under load (F34).

Steps 18–27 are not in the table: `epoch advance` (F34) and the callee trap (F36/F37) end the cell.

## Suite counts

| suite | result |
|---|---|
| `qinit build` × 4 templates × 2 compilers | 8/8 exit 0; IDLs byte-identical between compilers for every template and for Probe |
| `qinit verify` × 4 templates | 4/4 exit 0 |
| `qinit strip` × 4 templates | 4/4 exit 0 |
| `qinit gtest` × 4 templates × 2 compilers | 8/8 cells pass (3, 4, 4, 3 tests each) |
| `qinit gtest --new` on Probe (+ callee Trap) × 2 compilers | 10/10 pass each; CallTrap with real expectations (`got 6`, `callsAfter 1`, `boomErr 0`) passes |
| `qinit test` (isolated node) | counter: 1 pass; hashmap: 0 pass 1 fail; asset: 0 pass 1 fail (F28) |
| generated client (`qinit gen` + `bun run`) on Tcounter | Get/Inc/Get = 1n/ok/2n, agrees with `call` |
| `qinit deploy` | 3 templates × 2 compilers on simulator, Probe/Big/Tcounter/Syscall/Counter/Tintercontract/Thashmap/Mig on core: all exit 0 |
| `clean` + `setup --force` | exit 0, 131 s, cache rebuilt at 0.0.44 |
| Windows paths | skipped: no Windows host |

## Index

| # | severity | one line |
|---|---|---|
| F22 | wrong value in `--json` | `caller`/`out` null on untraced procedure calls |
| F23 | cosmetic | piped `explorer` says "crashed" |
| F24 | cosmetic / API | `--json` ignored by 6 commands; `ok` key uneven |
| F25 | cosmetic | piped `debug` hangs forever |
| F26 | wrong diagnostic | unfunded signer → `✓ processed`, blames the debug toggle |
| F27 | cosmetic | `--amount` on `--fn` silently accepted |
| F28 | loud failure | `qinit test` scaffolds a counter test for every contract |
| F29 | misleading value | explorer lists non-executed txs as `-10` transfers from a 0-qu account |
| F11 ext | accept/reject divergence | enum in I/O struct: clang rejects, typescript builds |
| F30 | wrong diagnostic | simulator restart wipes all; `--keep` is a no-op |
| F32 | silent wrong result | trap = terminal fault by design, but `--json` says ok:true and `node status` says "not yet ticking" |
| F33 | hang | human `--trace` never returns on a 524 289-row diff |
| F34 | silent wrong state | side-effecting dev GET retried on timeout → two epochs advanced |
| F35 | wrong diagnostic | busy node → "no contract 'X'" |
| F36 | silent wrong state (pending) | simulator swallows a callee trap, keeps partial write, error 0 |
| F37 | highest operational | core-lite: callee trap wedges the node, abort code leaks into unrelated reads (0.0.43 and 0.0.44) |
| F38 | wrong diagnostic | core-lite: top-level trap halts ticking; slot poisoned; CLI says "not yet ticking" |
| F39 | runtime divergence | `QX.Fees` real values on simulator, zeros on core-lite |
