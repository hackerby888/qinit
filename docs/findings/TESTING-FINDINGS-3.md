# qinit CLI test campaign 3 — findings (F40+)

Binary: `/home/kali/Projects/Qinit/dist/qinit` from `412887bf` (2026-09-04). Node: `qinit-v0.0.46` = core-lite `cc01b11b`.
Plan: `~/Projects/qinit-c3/PLAN.md`. Workspaces: `~/Projects/qinit-c3/<scenario>/`. Status: `~/Projects/qinit-c3/matrix/STATUS.md`.
Tools: `QUBIC_CLI=/tmp/qubic-tools/qubic-cli-dev/build/qubic-cli`, `QLOGGING=/tmp/qubic-tools/qlogging/build/qlogging`.

## Summary

Six new findings (F40–F45) from running real contract-developer workflows across four compiler×runtime cells
(clang|typescript × simulator|core), each value backed by an oracle (a Python model, a qpi.h line, an independent K12,
or the other cell). Report only; nothing was fixed. Part A (the fault-class alignment) was re-verified end to end and
holds on all four cells.

Ranked by severity (silent wrong value/state > wrong diagnostic > loud rejection of legal input > cosmetic):

| # | severity | one line | runtime |
|---|---|---|---|
| **F42** | critical | a `call --fn` of a function entry that a redeploy dropped **SIGSEGVs the core node** | core only |
| **F44** | high | across an epoch, core credits +125e9/seed emission and writes ~180 MB/epoch; the simulator does neither (also `numberOfTickTransactions` -1 vs 0, reserve 1e10 vs 1e9, `distributeDividends` 1 vs 0) | divergence |
| **F45** | high | a `CC_ASSERT` used as an input guard halts in dev but **silently vanishes in `--production`**, writing the forbidden value | both |
| **F40** | high | a ~289 s procedure wedges the core node for good (AUTO-FLUSH), and every CLI command then says "is it running?" | core only |
| **F41** | medium | the same unfunded-signer call exits 1 on core, 0 on the simulator | divergence |
| **F43** | low | trap text (`Exception: integer overflow` vs `Integer overflow`) and the fault `phase` field differ; abort codes are identical | divergence |

Confirmations (no new number): F1 (`--in "-5sint64"` rejected, leading-space workaround), F5 (LOG_PAUSE ignored by the
trace), F15 (field-add without MIGRATE, silent), F22 (`--json` proc without `--trace` nulls `out`), F24 (`--json`
ignored by four commands), F30 (`--keep` loses contracts — now shown on core too), F39 (QX.Fees 0/0/0 on core). The
verifier safety gate is silently skipped when `contractverify` is absent (verify and build both exit 0). Hot reload is
deterministic and byte-identical across runtimes. State digest equals K12 of the dump on both runtimes even above 8 MiB.

Coverage: S1, S2, S3, S4, S5, S6, S7, S8, S9, S11, S12 run; S10 (gtest corpus) and S13 (soak) status in
`~/Projects/qinit-c3/matrix/STATUS.md`. Deferred/bounded: the fee-reserve cliff-to-dormancy (~480 sequential calls,
infeasible on core's 1e10 reserve — drain rate captured instead), the native `qubic.cpp` integrate-syntax-check
(`qinit integrate` refuses a not-yet-registered contract; clang oracle covered via `--compiler clang` on all contracts),
and the `qlogging` chain-log read (network client needing the node's port + passcode).

## Findings

### F40 — a 289 s procedure wedges the core node for good, and every CLI command calls it "unreachable"

**Repro** (`~/Projects/qinit-c3/ledger`, `Ledger.h`, `--compiler clang`, `qinit runtime core`, node `qinit-v0.0.46`):

```
qinit call --proc Ledger FillTo --args '{"n":1025,"start":0}' --seed <s0> --trace   # fills the 1024-slot HashMap
qinit call --proc Ledger FillTo --args '{"n":5000,"start":0}' --seed <s0> --trace   # capped at 2048 in-contract; every set() hits the full-map scan
```

`FillTo` is a bounded loop of `HashMap<id,uint64,1024>::set`; on a full map each `set` falls into
`getElementIndex` (`qpi_hash_map_impl.h:110-175`), a 1024-probe scan.

| runtime | `FillTo(1025)` execNs | `FillTo(2048)` on the full map |
|---|---|---|
| clang×simulator | 42 ms | 3.26 s |
| typescript×simulator | 7.9 ms | 5.1 ms |
| clang×core | 2.42 s | **288.9 s** (`debug-trace` seq 37, `ok:true`) |

**What happened on core while the procedure ran** (thread dump via `gdb -p`, log `matrix/S1/clang-core/node.log.wedged`):

1. The contract thread sat in `wasm_interp_call_func_bytecode` for 5 min (core-lite builds WAMR as the classic
   interpreter: `src/CMakeLists.txt:249-253`, `WAMR_BUILD_FAST_INTERP 0`, no AOT/JIT; Qinit compiles deployed
   contracts with `-O0`, `packages/build/src/compile/clang.ts:280`).
2. The tick processor held the contract state lock, so the first function query (`BalanceOf` from the generated client)
   spun the single Drogon IO loop in `QpiContextFunctionCall::__qpiAcquireStateForReading` at 90 % CPU. From then on
   **every** HTTP request timed out, `tick-info` included.
3. After 60 s upstream core's AUTO-FLUSH fired (`src/qubic.cpp:7849-7895`, commit `07f9e253`): "stuck on tick 77700191
   for >60s, network ahead of tick 77700192; wiped local tickData of 77700192 to force re-fetch". The only peer is the
   node itself, so the wiped tick is never re-fetched.
4. The procedure finished and committed (`Supply` shows `holders: 1024, lastSetIndex: -1`, trace frame `ok:true`),
   HTTP came back, but the node never created another tick: 10 min later `tick-info` still says 77700191,
   `/live/v1/dev/fault` is `null`, the log prints "Latest created tick = 77'700'186" counting *down*.

**What the CLI said**

| command | output | expected |
|---|---|---|
| `call --proc … FillTo` (the slow one) | exit 1, `ok:false`, `error: "node unreachable at http://127.0.0.1:41841 — is it running? (qinit node run) [request timed out after 10000ms …]"` after 2 m 35 s | "node busy: tick 77700191 has been processing for N s" or keep waiting |
| next `call --proc` | exit 1, `error: "the node did not answer, so its contracts are unknown — is it running?"` | same |
| `tick advance 1`, `epoch advance` (after HTTP recovered) | exit 1, `node unreachable … is it running?` while `curl tick-info` answers in 5 ms | "node is not ticking (stuck at 77700191 since …)" |
| `node status` | exit 1, `[node up (idle)]`, `✗ rpc: up, not yet ticking`, `fault: null` | a line saying the node stopped ticking after tick 77700191 and that a restart is the only way out |

**Severity**: silent wedge of the core node with a wrong diagnostic on every command (a developer reads "is it running?"
and restarts a node that *is* running, losing the state they were debugging). Two roots: (a) core's AUTO-FLUSH is a
mainnet heuristic that a single-node testnet cannot satisfy; (b) the CLI folds "request timed out" into "unreachable".
Controls: the same wasm on the simulator finishes in 3.3 s and the node keeps ticking; the 1025-insert call on core
(2.4 s) did not trip anything. Cost per full-map scan, fresh node each, `bin/fillto-cost.sh` (trace `execNs`):

| run | `FillTo(1025)` on an empty map | 1 scan of the full map | 8 scans |
|---|---|---|---|
| core, no `QINIT_STATE_DIFF` | 318 ms | 297 ms | 2 449 ms |
| core, `QINIT_STATE_DIFF=verify` | 405 ms | 357 ms | 2 811 ms |
| simulator, clang wasm | 18.5 ms | 3.5 ms | 36 ms |

So a single 1024-probe scan of a full `HashMap` costs ~0.3 s on the core node (≈85× the simulator on the same wasm);
any contract that probes a full map a few hundred times per procedure crosses the 60 s AUTO-FLUSH line. The verify
mode is not the cause. The same contract built with `--compiler typescript` scans the full map in 5 ms on the
simulator (its containers are lowered differently); its core cell is in the S1 matrix.

### F41 — the same unfunded-signer call exits 1 on core and 0 on the simulator
**Status: fixed** — qinit `06ede6a7`. `call` now fails an unfunded signer before submitting, so both runtimes exit 1. Verified: the simulator call now exits 1 (was 0); a funded call still exits 0.


`qinit call --proc Ledger Transfer --args … --amount 5 --seed bbbb…b --json` (a seed with balance 0, S1 step 52):

| runtime | exit | `ok` | where the message lands |
|---|---|---|---|
| core (both compilers) | 1 | false | `error: "signer DJZM… has no balance on this node — it accepts the transaction and then drops it at tick assembly …"` |
| simulator (both compilers) | 0 | true | the identical text in `warnings[0]`, plus `"(no trace: the procedure never ran, because the signer has no balance)"` |

`call.tsx:411` only promotes the warning to an error when the tx was *dropped*; the simulator includes the tx in a tick
without running the procedure, so `dropped` is false and a machine consumer sees success. F26 (fixed `9100e18e`)
covered the missing warning; this row is the exit code. Severity: wrong diagnostic (a CI script keyed on exit codes
passes on the simulator and fails on core for the same input).

### F42 — on core, calling a function entry that a redeploy dropped segfaults the whole node (SIGSEGV)
**Status: fixed** — core-lite `d5b10b19` (node `qinit-v0.0.47`). `unloadSlot` now clears the stale registration rows on redeploy and the `/live/v1/querySmartContract` route null-gates the entry. Verified: the dropped-entry call returns exit 1 `no fn 2 …` and the node stays alive.


**Severity: critical** — a single read-only `qinit call --fn` kills the core dev node (signal 11), losing all in-RAM
state; reproduced on both compilers and in isolation (`~/Projects/qinit-c3/matrix/S3/crash-repro`, `crash-control`).

**Repro** (`~/Projects/qinit-c3/system`, node `qinit-v0.0.46`, `qinit runtime core`):

```
qinit deploy contracts/Vault.h --contract-name Vault --compiler clang     # brings Registry@29, Token@30 (Info=fn1, Stats=fn2), Vault@31
qinit call  --proc Vault Deposit --args '{"amount":5,"tag":7}' --amount 1000
qinit deploy drift/Token.h --contract-name Token --compiler clang         # Token v2: Stats dropped, Credit/Kick renumbered
qinit call  --fn Token 2 --out uint64                                     # entry 2 was Stats in v1, unregistered in v2
```

The last call returns exit 1, `error: "node unreachable … [The socket connection was closed unexpectedly]"`, and the
node process is **gone**. Its own log (`matrix/S3/crash-repro/node.log.aftercrash`) prints:

```
[ERROR] Segmentation fault (signal 11) detected. Stack trace:
 0# signalHandler(int, siginfo_t*, void*)
 1# __restore_rt
======= Please report the above stack trace to team for debugging. Thank you! =======
```

**Root cause** (matches the plan's redeploy oracle: "entries dropped by the new module stay registered and point at
freed closures"): the lite dynamic slot re-arms Token in place on redeploy and copies `min(old,new)` state, but does
**not** clear the old entry-point registrations. Function entry 2 still routes to Token v1's now-freed closure, so
invoking it jumps into freed memory.

**Controls** (`crash-control`, same fresh node, no crash):

| call | result | node |
|---|---|---|
| `--fn Token 2` on Token v1 (Stats registered) | `ok:true, out:0` | alive |
| `--fn Token 9` (never registered) | exit 1, `"no fn 9 on contract 30 (registered: 1, 2)"` | alive |
| `--fn Vault 9` (never registered) | exit 1, `"no fn 9 on contract 31 (registered: 1, 2, 3)"` | alive |

So a *never-registered* number is caught client-side from the IDL; only an entry that **was** registered and then
dropped by a redeploy reaches the node and crashes it.

**Divergence**: on the simulator the identical sequence returns `"no fn 2 on contract 30 (registered: 1)"` and the node
keeps ticking — the simulator re-registers the contract cleanly on redeploy, core does not. The CLI cannot guard the
core case because Token was deployed as a callee from another project, so `call` has no local IDL for it and forwards
the raw entry number (S3 step 34 `--fn Token Stats` shows "no local IDL and node has no source for this slot").
Testnet-only (`LITE_WASM_SC` dynamic redeploy); mainnet contracts are static. Fix candidates: clear the slot's
entry-point table on redeploy, or bound-check the entry index against the currently-registered set before dispatch.

### F43 — trap message text and the fault `phase` field differ between runtimes (aborts are identical)

Part A aligned the fault *behavior* across runtimes; two rendering fields still differ for **wasm traps** (not aborts):

| field | simulator | core |
|---|---|---|
| CLI halt line / `.trap` / `/dev/fault.message` (a `QPI::div(INT64_MIN,-1)` trap) | `Integer overflow` | `Exception: integer overflow` |
| `debug-trace[].trap` for the same frame | `Integer overflow` | `it=3 kind=1 — Exception: integer overflow` |
| `/dev/fault.phase` (every halting class) | `transaction` / `begin-tick` / `end-epoch` / `deploy` / `contract-procedure` | always `transaction` |

Everything else matches exactly across all four cells: abort codes (`abort(0xCC00003D)` proc, `abort(0xCC000016)`
nested, `abort(0xCC00001C)` BEGIN_TICK, `abort(0xCC000027)` END_EPOCH, `abort(0xCC000032)` MIGRATE), fault `kind`
(1 proc / 2 sysproc / 3 migrate), `entry`, `slot`, the number of committed trace frames, and the state diff kept in
each frame. Severity: cosmetic. It surfaces because the plan aimed for "`call --trace` reads the same on both
runtimes"; abort text does, trap text and the phase label do not. The `it=N kind=K —` prefix on core's trace is
deliberate (it carries the input type and kind), so only the `Exception:` prefix and the phase label are pure
divergence.

### F44 — across an epoch boundary, core credits a fixed emission and writes hundreds of MB; the simulator does neither
**Status: fixed (targeted)** — core-lite `d5b10b19` (node `qinit-v0.0.47`). Per-epoch emission compiled out on the dev node (balances stable across epochs), `numberOfTickTransactions` clamped to 0, fee-reserve seed aligned to the simulator's 1e9. The ~180 MB/epoch disk write is a separate state-save path, left as-is. `distributeDividends` (cosmetic multiplier) deferred.


`~/Projects/qinit-c3/staking` (`Staking.h`), `qinit epoch advance` ×3, balances and `~/.cache/qinit/run` disk sampled after each. Same on both compilers.

| after | simulator s1 balance | core s1 balance | core disk |
|---|---|---|---|
| deposit | 1999999999000 | 9999999000 | 2 MB |
| 1 epoch | 1999999999000 (unchanged) | **134999999000** (+125,000,000,000) | 195 MB |
| 2 epochs | — | **259999999675** (+125e9) | 381 MB |
| 3 epochs | 2000000000500 (unchanged) | **385000000350** (+125e9) | 568 MB |

On **core** every `epoch advance` credits each seed a flat **+125,000,000,000 qu** (the testnet emission) and writes the
effective per-slot state to disk (~180 MB per epoch here; the plan's "~1 GiB per unloaded LDYN slot"). On the
**simulator** balances change only by the fees a contract keeps, and disk stays ~1 MB. A contract test that asserts a
seed balance after an epoch passes on the simulator and is wrong by 125e9-per-epoch on core (and the reverse). Severity:
silent wrong value across runtimes for any epoch-crossing money flow.

Three more epoch-related divergences from the same run (both compilers agree within a runtime):

| probe | simulator | core |
|---|---|---|
| `qpi.numberOfTickTransactions()` on an empty tick | `0` (min 0 / max 1) | **`-1`** (min -1 / max 3) — a contract computing from it silently differs |
| `qpi.queryFeeReserve()` at deploy → after tick accrual | `999099924 → 748878666` (~1e9, drains ~250M) | `9999986716 → 9995398396` (~1e10, drains ~4.6M) |
| `qpi.distributeDividends(1)` on a slot with no asset name | returns **`0`** (bit false), pays nothing | returns **`1`** (bit true), pays nothing |

`CC_WARP_EPOCH` behaves the same on both: it advances the epoch counter without advancing ticks and without running
BEGIN_EPOCH/END_EPOCH (sysprocs correctly skipped under warp). The `epoch advance` on core also exits 1 client-side
("node unreachable") while the node keeps ticking, because crossing the 2701-tick epoch runs longer than the 10 s CLI
budget (the F34 epoch-timeout family; seen in S6 too).

### F45 — a `CC_ASSERT` used as a real input guard silently disappears in a `--production` build

`~/Projects/qinit-c3/cheatful` (`Cheatful.h`), `Guard` procedure body `CC_ASSERT(input.n != 13); state.mut().guarded = input.n;`. Same on core.

| build | `call --proc Cheatful Guard --args '{"n":13}'` | node | state |
|---|---|---|---|
| dev (`qinit deploy`) | exit 1, `node halted: Cheatful proc#2 trapped abort(0xCC00001B)` | **halts** | `guarded` not written |
| production (`qinit deploy --production`) | exit 0, `out: 13` | keeps ticking | **`guarded = 13` written** — the forbidden value lands in state |

`--production` strips every cheatcode, and `CC_ASSERT` is a cheatcode, so a developer who writes it as an input-validation
guard gets a hard stop in every test and **zero** protection on the chain the production build ships to. The build prints
no warning that a `CC_ASSERT` is load-bearing; `state --digest`/`verify` on the stripped output look clean. Confirmed on
both runtimes; the production build's IDL carries `cheats: 0` and the trace shows no cheat channel.

**Severity: high** (silent behavior change between the tested artifact and the shipped one; a guard that halts in testing
is a no-op in production). This is the documented meaning of `cheat/no-side-effects` — a neutered dev build and a stripped
production build must agree — but for `CC_ASSERT`-as-guard the two *do* diverge by exactly the guard, and nothing flags it.
The safe pattern is an explicit `if (bad) { … return; }`, not `CC_ASSERT`; the CLI could warn when a `CC_ASSERT` guards a
state write.

## Matrices

### S1 — Ledger, 40-step multi-signer session (`~/Projects/qinit-c3/ledger`, `bin/suite-S1.sh`, oracle `bin/oracle_ledger.py`)

70 recorded steps per cell, `bin/compare.py S1`: **68 agree across all four cells**, 2 differ (F41 exit code;
seed balances 2e12 vs 1e10 by design). Oracle: every `out` matches the Python model except step 51 (`--json` proc
without `--trace` → `out: null`, F22, still open). State digest `1b255fe15f3d4f56…`, the 115 296-byte `--dump`
(md5 `c49c9aa65c2d…`) and the generated client's 10 replayed reads are byte-identical across all four cells; hash-slot
indices (`idx`, `lastSetIndex`) agree too.

| row | clang×sim | ts×sim | clang×core | ts×core |
|---|---|---|---|---|
| owner-only Mint, non-owner rc 1, fee kept (`feeCollected` = contract qu balance 25) | ✓ | ✓ | ✓ | ✓ |
| self / NULL_ID / contract-id / zero / over-balance transfer | rc 0/2/0/0/1 | same | same | same |
| `--args "18446744073709551615"` (F2) wrap vs `sadd` | wrap 4, sat MAX | same | same | same |
| `FillTo(1025)` on 6 entries → stored 1018, firstFull 1018, pop 1024 | ✓ 56 ms | ✓ 9.7 ms | ✓ 8.1 s | ✓ 203 ms |
| 40 new keys on the full map (40 full scans) | 183 ms | 0.28 ms | **28.9 s** | 49.5 ms |
| Mint on full map rc 3; remove → reuse; cleanup keeps 1024 | ✓ | ✓ | ✓ | ✓ |
| `--in` road (identity + uint64) and wrong-shape right-size `--in` (5×uint64 → rc 3) | ✓ | ✓ | ✓ | ✓ |
| lowercase / 59-char / bad-checksum identity | exit 1, clear message | same | same | same |
| `--in "0id"` | accepted, queries NULL_ID | same | same | same |
| `--proc Ledger 99` (F3) | exit 0, warning, tx sent anyway | same | same | same |
| `--out uint8` on a uint64 (F4) | exit 0, warning names 8 bytes | same | same | same |
| unfunded signer `--amount 5` (F26 / F41) | exit 0 ok:true + warning | same | exit 1 ok:false | exit 1 |
| 4 × `--no-settle` from two signers | all 4 landed, one per tick, 9 ticks apart | same | 6 ticks apart | 6–8 ticks apart |
| `state --all` / `--digest` / `--dump` / `gen` replay | identical | identical | identical | identical |

Notes: `--no-settle` does not make a burst — each CLI invocation still costs ~2.5 s of startup and node round trips,
so four "burst" transfers landed 6–9 ticks apart on every runtime. The 2048-iteration cap row is F40 (289 s on core).
`Wide.h` (1040-byte input, 65 544-byte output) is rejected at build by both compilers (clang: the qpi_macros
`static_assert`; TS: "exceeds MAX_INPUT_SIZE (1024 bytes)" / "maximum output size is 65535 bytes"), so no runtime
oversize row exists.

Timings (`execNs` from the trace, same source): clang wasm on the WAMR interpreter is 40–580× slower than the
TypeScript backend on the same node for container-heavy loops (F40 table); the two runtimes agree on every value.

### S3 — three-level contract system (`~/Projects/qinit-c3/system`, `bin/suite-S3.sh`); Registry@29 ← Token@30 ← Vault@31, Spare@32

30 steps per cell, `bin/compare.py S3`: 25 agree across all four cells; the 5 that differ are all the post-crash steps
of the ABI-drift row (F42 kills the core node, so steps 35–38 read "unreachable" on core, clean on sim) plus
`spare-fees` (F39).

| row | clang×sim | ts×sim | clang×core | ts×core |
|---|---|---|---|---|
| slot window: a 5th project contract into 29..32 | exit 1 `"cannot assign 1 project contracts … keeping every callee below its caller"` | same | same | same |
| build Vault@31 with callee Token@32 (callee above caller) | exit 1 `"slot 32 is occupied by 'Spare', not 'Token'"` | same | same | same |
| INVOKE two levels, reward forwarded a tenth per hop (`--amount 1000` → Vault 900 / Token 90 / Registry 10) | balances 900/90/10, s1 −1000 | same | same | same |
| callee pays `qpi.invocator()` back (KickDown → Token → Registry.Refund) — lands on the *calling contract* | Registry keeps 10, Token +500 | same | same | same |
| CALL from a function two levels deep (`Vault.Peek` → Token.Info → Registry.Count) | `credits 5, regN, regPits` | same | same | same |
| callee output struct with `Array<id,4>` (`Vault.Members`) | 4 ids incl. Vault's own contract id | same | same | same |
| re-entry: Registry self-transfers inside its own POST_INCOMING_TRANSFER | `pitRet -9223372036854775808` (INVALID_AMOUNT), blocked | same | **same on core** | same |
| Spare → QX.Fees (F39) | `1000000000/100/3000000` | same | `0/0/0` | `0/0/0` |
| `gtest --new` on Vault, then rerun | 6/6 pass (Initialize/Deposit/KickDown/Peek/Members/Stats) | 6/6 | 6/6 | 6/6 |
| ABI drift: redeploy Token renumbered, then call Vault.Deposit (binds Token entry 1 = now Kick) | `err 0`, silently runs the wrong entry, identical bytes | same | **same** | same |
| ABI drift: call Token's **dropped** entry 2 directly | exit 1, clean `"no fn 2 …"`, node ticks | same | **F42: SIGSEGV, node dies** | **SIGSEGV** |

Answered open questions: PIT self-reentry is blocked with INVALID_AMOUNT on **both** runtimes (not just the simulator);
a callee paying `qpi.invocator()` credits the calling contract, not the user, on both; the reward-per-hop split is
exact on both. The silent wrong-entry ABI-drift call (Vault still bound to Token entry 1, now `Kick`) behaves
identically on all four cells — entry numbers are the ABI, and renumbering a callee silently reroutes a caller with
no diagnostic (design, but a footgun; not filed separately since it agrees across runtimes).

### S6 — fault classes in production shapes (`~/Projects/qinit-c3/faulty`, `bin/suite-S6.sh`; Faulty@30 + callee Boom@29, fresh node per halting row)

Part A holds on **all four cells**. Every class behaves identically bar the F43 cosmetics.

| class | call result | node after | fault / trace |
|---|---|---|---|
| `CC_ASSERT` in a **function** (`AssertFn(50)`) | exit 1, `Error calling smart contract function: …`, node keeps ticking (control `AssertFn(5)` returns) | ticking | no fault; the following `Counts` and `tick` work |
| `CC_ASSERT` in a **procedure** (B) | exit 1, `node halted: Faulty proc#2 trapped abort(0xCC00003D)` | halted | fault kind 1 entry 2; 1 trace frame, diff 1 (the `marker` partial write kept) |
| wasm trap in a procedure (C, `div(INT64_MIN,-1)`) | exit 1, `node halted … trapped <trap text>` | halted | fault kind 1 entry 3; frame with diff 1 |
| **nested** `CC_ASSERT` in the callee (D) | exit 1, `node halted: Boom proc#1 trapped abort(0xCC000016)` (names the callee) | halted | **two** frames: callee (slot 29) then caller (slot 30, CallBoom), both diff 1 |
| **nested** wasm trap (A7/A9) | exit 0, `err 0`, output zeroed, caller continues; Boom's partial write (`calls`) persists | ticking | recovers on both runtimes |
| `LOG_PAUSE` then nested trap (A9, A11) | exit 0, recovers | ticking | — |
| BEGIN_TICK abort (E) / trap (F), armed by a proc that succeeds | arm exit 0; node halts on the next tick | halted | fault kind 2 entry 3; 1 frame |
| END_EPOCH abort (G), reached by `epoch advance` | arm exit 0; halts at the epoch boundary | halted | fault kind 2 entry 2 |
| MIGRATE trap (H, redeploy over used v1) | human `deploy` reports the halt within a tick | halted | fault kind 3 entry 0 slot 31; 1 frame, diff 0 |
| recovery (`node run --restart`) | node ticks again, fault cleared | ticking | fresh state |

Divergences: only F43 (trap text `Exception: integer overflow` vs `Integer overflow`; fault `phase` always
`transaction` on core). The A15 `epoch advance` on core (crossing the 2701-tick epoch) exits 1 client-side with
"node unreachable" while the node keeps ticking — the epoch route runs longer than the 10 s CLI budget (also seen in
S5, the F34 epoch-timeout family). Regression rows F32/F36/F37/F38 (top-level trap halts, nested trap recovers,
callee assert names the callee, function abort non-fatal) all pass on both runtimes.

### S4 — dev loop under traffic (`~/Projects/qinit-c3/bin/suite-S4.sh`, `qinit dev` in tmux + `hammer.sh`); clang×sim and clang×core

No new finding. Hot reload is deterministic and **identical across runtimes**: the eight edits produced the same
sequence of `qinit.idl.json` codeHashes on both cells (`a03beca3` → `1e3a5a77` add-field → `97bd1f15` add-MIGRATE →
`4e53b5fa` rename → `177202f8` remove → *unchanged through the syntax error* → `1215a981` fix → `d9bf4bc0` re-add).

| edit | result on both runtimes |
|---|---|
| whitespace | idl unchanged, state preserved |
| add a state field, no MIGRATE | idl changes, **no warning**, `supply=1000000` preserved (overlap copy zero-fills the new field — confirms F15) |
| add MIGRATE | idl changes, state preserved, MIGRATE runs |
| rename an entry | idl changes; calls to the old name fail `no fn named 'Version' … node has no source for this slot` |
| remove an entry | idl changes, remaining entries keep working |
| introduce a syntax error | **build fails, dev keeps the last good deployment** (idl hash frozen), node keeps serving and ticking |
| fix it / re-add the entry | rebuilds, idl changes, state still `supply=1000000` |

State (`supply=1000000`) survived all eight edits on both runtimes. Traffic during redeploys: reads for the renamed
`Version` failed with the informative "no source for this slot" message (a harness artifact of the rename, not a
defect); one `--no-settle` transfer out of 70 was rejected with `transaction tick 3119 is outside 3121..5999` because
the tick advanced between build and submit — the normal tick-window guard, transient. No dropped-state, no crash, no
divergence.

### S8 — machine consumers and the CLI edge (`~/Projects/qinit-c3/bin/suite-S8.sh`, 34-row json-survey); clang×sim and clang×core

No new numbered finding; a batch of confirmations, exit/jq identical between runtimes except one ambiguous row.

| row | sim | core | note |
|---|---|---|---|
| `call --fn Ledger 99` (unregistered number) | exit 1, clean JSON `no fn 99` | same | the CLI guards from its local IDL (contrast F42, where a redeploy leaves it with no IDL) |
| `--in "-5sint64"` | exit 1, `Option '--in' argument is ambiguous` | same | F1: the parser reads the leading `-` as a flag; the message is misleading |
| `--in " -5sint64"` (leading space) | **exit 0, accepted** | same | the undocumented workaround for a negative literal (F1) |
| `--in ""` on a non-empty input | exit 1 | same | rejected |
| `--proc Ledger transfer` (lowercase) | exit 0, resolves to `Transfer` | same | entry names match case-insensitively (lenient) |
| `seed --show` / `runtime` / `compiler` / `gen` with `--json` | jq=**no** (plain text) | same | F24: `--json` accepted and ignored by these four |
| `info` with the node down | exit 0 | same | `info` always exits 0 |
| `ls` / `state` / `call` / `node status` with the node down | exit 1 | same | correct |
| `verify` with `contractverify` moved aside | exit 0, `available:false, ok:true` | same | the compatibility gate reports itself unavailable and passes |
| `build` with `contractverify` moved aside | exit 0, 47 KB artifact, no verification | same | the safety gate is silently skipped — a contract `verify` would reject would build and deploy |
| `node run --tick-ms abc` | exit 0, node starts (NaN tick ignored) | exit 1, node starts | the only exit-code divergence; both nodes came up, so it is cosmetic |

`--json` envelopes are well-formed (`jq -e` parses) for every command that emits one; the key set is stable
(`ok,error,trap,out,contract,slot,entry,kind,tick,tx`). Regression rows F3 (`--proc 99` warns and sends) and F35
(node-busy message) behaved as their fixes intend.

### S7 — big state and scale (`~/Projects/qinit-c3/big`, `Big.h` ~12 MB: 65 536-slot profile map + 256 K flat array + order collection); clang×sim and clang×core

No new finding. The >8 MiB digest concern is refuted: `state --digest` equals an independent bun K12 of the `state --dump`
bytes **exactly on both runtimes** (sim `573f80e0…`, core `1977e1f3…`, each equal to the K12 of its own 12 043 312-byte
dump). So the per-contract digest is a straight K12 over the effective size with no zeroed leaf above 8 MiB.

| probe | clang×sim | clang×core |
|---|---|---|
| deploy + fill 8000 profiles + 500 orders + touch 10 000 flat cells | stats identical: `profiles 8000, orders 500, writes 28000, flat0 2` | identical |
| `state --digest` == K12(`--dump`) | ✓ (`573f80e0…`) | ✓ (`1977e1f3…`) |
| `--dump` bytes across runtimes | **differ**, by design: `Big.Profile.joined = qpi.tick()` stores ≈3 000 (sim) vs ≈77 700 000 (core) | — |
| `call --trace` on a proc touching 10 000 cells (F33 re-measure) | 1.7 s, `execNs` 16 ms, 10 002 diff rows | 1.7 s, `execNs` **146 ms** (~9× the sim on the WAMR interpreter) |
| `state` render / `--dump` of 12 MB | 3.1 s / 3.1 s | comparable |

The dump differs across runtimes only because the contract captured the runtime's tick; a tick-free contract would be
byte-identical. F33 (`call --trace` never returns) did not reproduce at 10 000 rows — it needs the ~524 289-row diff of
the original report. Journal overflow (`stateTruncated`, >64 MiB single-call diff) was not reachable: the whole state is
12 MB, so no single dispatch can produce a 64 MiB diff — noted as not testable with this contract.

### S2 — assets on the real QPI asset system (`~/Projects/qinit-c3/assets`, `Assets.h`); all four cells + `qinit test` on the four templates

No new numbered finding. On the **simulator** `issueAsset` validated exactly as `qpi_assets_impl.h` prescribes (both compilers agree):

| name / shares / decimals | `issueAsset` result |
|---|---|
| `TEMPL` (5-char), 1e6 shares | `1000000` (issued) |
| `A` (1-char) / `ABCDEFG` (7-char) | `100` (issued) |
| `ABCDEFGH` (8-char) | `0` (name too long) |
| `abc` (lowercase) | `0` (must be A-Z) |
| empty name (`0`) | `0` |
| `0` shares / `-1` shares | `0` |
| `MAX_AMOUNT` (1e15) shares | `1000000000000000` (issued at the cap) |
| `MAX_AMOUNT+1` shares | `0` (over cap) |
| decimals `-56` | `100` (issued; a nonsensical decimal is accepted silently) |
| reissue an existing name | `0` (already issued) |

`Move` (transferShareOwnershipAndPossession): to a funded id / unfunded id / self all succeed (possession moves,
`numberOfPossessedShares` tracks it — owner 85, recipient 10 after moving 10+5); moving more than owned returns a
negative failure code (`-99915`). `qinit test` scaffolded and passed on all four shipped templates (counter, hashmap,
asset, intercontract) on both runtimes.

**Caveat, not filed as a finding**: in the batched chain the **core** node became unreachable ("Unable to connect")
right after the second successful issuance, on both compilers. Two isolated repros of the full issue sequence (with and
without `--trace`, 16 issuances) kept the node alive, so it is **not reproducible** — most likely tied to disk/RAM state
left by the immediately preceding S7 run (444 MB of epoch saves), not to the asset op. QX.Fees divergence (core 0/0/0 vs
sim 1e9/100/3e6) is F39, confirmed again here.

### S11 — node operations (`~/Projects/qinit-c3/bin/suite-S11.sh`); clang×sim and clang×core

No new numbered finding; behaviour is identical across runtimes.

| operation | result on both runtimes |
|---|---|
| `node run` while already running | exit 0, reuses the running node, no error |
| `node run --keep --restart`, then read the contract | exit 0 for the restart, but the deployed `Ledger` is **gone** (`no contract 'Ledger'`), with no diagnostic — confirms F30 and extends it to **core** (the plan had core `--keep` untested) |
| stale `node.pid` (bogus pid after stop) | `node status` → `rpc: down`, not fooled by the stale file |
| `node stop` twice | both exit 0 (idempotent) |
| a foreign process renamed `Qubic` | `node status` → `rpc: down` — `nodeAlive()` checks the RPC, not the process name; `node run` then starts its own node |

So `--keep` does not preserve deployed contracts on either runtime and says nothing about the loss (F30). Everything
else (reuse, idempotent stop, stale-pid handling, foreign-process immunity) is robust and consistent.

### S9 — production pipeline and the native Core syntax oracle (`~/Projects/qinit-c3/cheatful`, `Cheatful.h`)

Main result is **F45** (a `CC_ASSERT` guard vanishes in production). Supporting facts:

| step | result |
|---|---|
| `strip` the dev source | removes the cheat; `verify` on the stripped file passes (`available:true`) |
| `build --production` | `idl.cheats: 0`, 15 379-byte artifact (all cheats stripped) |
| deploy dev, `Guard(13)` | node halts (F45) |
| deploy `--production`, `Guard(13)` | exit 0, writes `guarded=13`; `Mint` trace shows `cheats: 0` (no CC_PRINT channel) |

**Native syntax-check leg — partially blocked.** `qinit integrate Ledger.h --out <core clone>` refused with
`contract 'Ledger' is not registered on existing branch 'develop'`: `integrate` updates a contract already registered in
the Core contract list, it does not add a brand-new one, so the "integrate then `clang++-18 -fsyntax-only` the whole
`qubic.cpp`" path was not reachable from the CLI alone (and `qubic.cpp` also pulls the EFI/platform headers a plain
Linux clang invocation lacks). The clang accept/reject oracle was instead covered throughout the campaign by building
**every** contract with `--compiler clang` (wasi-sdk `clang++`) alongside `--compiler typescript`: the two agreed on all
12 contracts except three deliberate divergences already noted — `Wide.h` oversize io (both reject at build), a
`LOG_*` inside a function (TS rejects "not available in a function", clang builds), and a `#ifdef` cheat guard (both
reject via `qpi/no-preprocessor`).

### S12 — logging with the debug trace (`~/Projects/qinit-c3/logs`, `Logs.h`); clang×core and clang×sim

No new numbered finding; confirms F5 and shows logs are machine-consumable.

- **The debug trace captures every `LOG_*` byte-identically across runtimes.** `Emit(42)` records 4 logs per frame
  (INFO/WARN/ERROR/DEBUG); the payload hex is identical on core and simulator
  (`1d000000010000002a00000000000000` for the `Small{a:42}` INFO, the 74-byte `Wide` for WARN, etc.).
- **`call --json --trace` decodes the logs** into `{severity, type, name, fields, hex}` — a machine consumer sees them
  (addresses the readable half of F6; the key is `logs`, not `cheats`).
- **`LOG_PAUSE` is ignored by the debug trace (F5, both runtimes).** The `Emit` call that wraps its `LOG_ERROR` in
  `LOG_PAUSE()`/`LOG_RESUME()` still shows all 4 logs in its trace frame — the pause does not suppress the entry there.
- The per-tick `LOG_INFO` from `END_TICK` (when armed) appears as its own 1-log sysproc frame.
- Compile-time enforcement (from the build phase): the TS backend **rejects** `LOG_*` inside a function
  ("not available in a function; logs are paired with a transaction") and both backends require the payload struct to
  carry a `_terminator` field; the node itself does not enforce either.

**Not run**: the `qlogging` chain-log oracle. `~/Projects/qlogging/build/qlogging` is a network client
(`qlogging <nodeip> <nodeport> <passcode×4> <tick>`) that connects to the node's log server with a passcode, not a
reader of `~/.cache/qinit/run/*maplogs*` (those dirs stay empty). Reading the chain log therefore needs the node's log
port and passcode, which the dev node does not surface through the CLI — noted as a gap for settling the *chain* side of
F5/F6 (the trace side is settled above).

### S10 — gtest as oracle, incl. `--corpus` (`~/Projects/qinit-c3/bin/suite-S10.sh`); clang×sim

No new finding; gtest works as an oracle and the corpus mechanism is sound.

| gtest run | result | time |
|---|---|---|
| `gtest --new` on Ledger (scaffold) | 16 / 16 passed | 5.8 s |
| `gtest` on Ledger (rerun) | 16 / 16 passed | 5.8 s |
| `gtest --corpus QX` | 3 / 3 passed | 10.9 s |
| `gtest --corpus QUTIL` | 51 / 51 passed | 224.9 s |
| `gtest --corpus QEARN` | started, first test passed, then stopped by me | > 15 min |

The auto-scaffolded Ledger tests match the S1 live behavior (gtest runs `fees:"off"`, a legitimate difference from the
metered dev node). **QEARN is a documented heavy-tier corpus** (`packages/cli/src/ops/corpus-run.ts`:
`HEAVY_SYSTEM_GTEST_NAMES = {PULSE, QTF, QTRY, QEARN, NOST}`, QEARN "33× slower through the shadow bridge"), so its long
runtime is expected, not a defect — I stopped it after confirming it builds and its first test passes. The light-tier
corpora (QX, QUTIL) pass cleanly, confirming the corpus oracle.

### S13 — soak (bounded, `~/Projects/qinit-c3/bin/suite-S13.sh`, `SOAK_SECS=360`, simulator)

Bounded to 6 minutes (a full 1 h × 2 runtimes was out of budget; S4 already exercised sustained traffic). Clean.

| metric | start | end |
|---|---|---|
| tick | 3 066 | 5 399 (ticking, `fault: null`) |
| node RSS | 113 MB | **507 MB** |
| digest | `f9cd3b7f…` | `80eea3ca…` (moves with state, expected) |
| hammer (2 tx/s, 4 seeds) | — | 89 tx / 100 reads, **0 tx failures, 0 read failures** |

No dropped transactions, no read errors, node healthy throughout. The one thing to watch is RSS: it grew ~4× in six
minutes because the simulator retains the full finalized-tick history by default — a soak of any length should pass
`--history-ticks <N>` to bound it. Not a defect at this scale; noted as a scaling characteristic. A full-length soak per
runtime and the `queryFeeReserve`/ring-depth trend over an hour remain the untaken part of this leg.

## Suite counts

| suite | cell | pass | skip | fail | note |
|---|---|---|---|---|---|
| S1 steps (70) | clang×sim / ts×sim / clang×core / ts×core | 70 / 70 / 70 / 70 recorded | 0 | 0 unexpected | 3 expected client-side rejections per cell (44–46), 52 differs per F41 |
| `build Wide.h` | clang / typescript | 0 | 0 | 1 / 1 (expected) | oversize io gated at build on both |
| S3 steps (30) | 4 cells | 25 agree | — | 5 differ | F42 crash (core) + F39 fees |
| `gtest --new` Vault | clang / ts | 6 / 6 | 0 | 0 | auto-scaffold; real-expectation gtest is S10 |
| S6 fault rows (A–H) | 4 cells | all classes match | — | 0 | Part A verified end to end; F43 cosmetics only |
| `build Logs.h` in-function LOG | typescript | 0 | 0 | 1 (expected) | TS backend rejects LOG_* in a function; node does not enforce it |
| S10 gtest | Ledger clang | 16+16 | 0 | 0 | scaffold + rerun |
| S10 corpus | QX / QUTIL / QEARN | 3 / 51 / (partial) | QEARN heavy | 0 | QX+QUTIL pass; QEARN documented-slow, stopped |
