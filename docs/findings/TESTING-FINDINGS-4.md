# qinit CLI test campaign 4 — the decode/print layer at production scale (F46+)

Binary: `/home/kali/Projects/Qinit/dist/qinit` from `412887bf` (2026-09-04). Node: `qinit-v0.0.46` = core-lite `cc01b11b`.
Plan: `~/.claude/plans/cli-exploratory-tester-polymorphic-blanket.md`. Workspace: `~/Projects/qinit-c4/`.
Probes: production contracts from `qubic-core-lite/src/contracts/` renamed to dodge the reserved-name gate —
`Qx.h`→`XCHG` (621 806 120 B state), `Qearn.h`→`EARNX` (214 171 656 B), `Quottery.h`→`QUOTX` (923 559 560 B) — plus
`Nexus.h` (purpose-built). `qRWA.h` cannot be built as a user contract (name reserved at slot 20; renamed, its log
payloads fail the header-word gate) — see D5.

## Summary

Nine new findings (F46–F54) from production contracts (`Qx.h` 593 MB, `Qearn.h`, `Quottery.h` 881 MB, `qRWA.h`) and
one purpose-built protocol of the same weight (`Nexus.h`, 551 MB: lending + AMM + governance), across all four
compiler × runtime cells, every value checked against an oracle outside Qinit (clang's wasm32 `offsetof`, a Python
decoder of the raw dump, a Python-packed byte image, the other cell). Report only; nothing fixed *in the campaign* — as of 2026-09-05 (`41aff6ce`) F46 (`a609ab02`, simulator), F47 (`acb6b263`), F48 (`e24c187e`), F50 (`28c43000`), F51 (`b3620b63`), F52 (`30a613e6`) and F53 (`cd6ffd3b`) have fixes on `main`; F49 and F54 remain open.

| # | severity | one line | cells |
|---|---|---|---|
| **F48** | critical (silent wrong state report) | the diff drops every field after a struct's first padding hole — **8 of 20 procedure frames** in a production-shaped session lose rows (`Pool.assetName/features/phase`, `PositionLog.debt`, `VoteLog.tally`, `Ledger.buckets[i]`), while the same frame's decoded log shows the values | all four (renderer) |
| **F46** | high (silent no-op with `ok`) | on the simulator a ≥ 500 MB contract is single-shot: INITIALIZE + one procedure exhaust the 1e9 reserve; every later `call --proc` returns `ok` + tx, is silently skipped/refunded, `--trace` blames the debug toggle, no surface says dormant; core is unaffected | sim only, both compilers |
| **F47** | high (machine consumers) | `--json` carries the rendered text as `out` and every state field `value` (unquoted keys, `×256`, `… +4 more (--all)` inside the string) | all |
| **F52** | medium (wrong diagnostic — accepts an illegal spelling) | `--in` places tokens by their spelling and checks only the total length against the IDL it holds: `1uint64` for a `uint8` field, or a reordered spelling, is accepted with `ok` and writes wrong values | clang×core (encoder; runtime-independent) |
| **F53** | medium (silent loss of readability) | two log structs of equal logged size make both undecodable; `_type` is never used to disambiguate | all |
| **F50** | medium (silent data loss on chain) | a field after `_terminator` builds on both compilers with no diagnostic; it is never logged and the log becomes undecodable | builds: all four; deployed: clang×core; decoder proven pure-function (`h2h6.ts`) |
| **F51** | medium (money path, exotic inputs) | `--amount` via `Number()`: `1e3`/`0x10` accepted, `18446744073709551615` sent as 0 with `ok` | core |
| **F49** | low (wrong diagnostic) | a Collection/LinkedList removal renders as a priority *update* on another element plus a zero-out, never `(removed)` | all |
| **F54** | low (usability) | `qinit debug` selection slides under live capture; older frames are unreachable on a contract with a tick handler | core (TUI) |

Confirmations: F1 (leading `-` in `--in`; `--in=-1sint64` works), F5, F9 (nested containers `index 0` in `--json`),
F11 family (production contracts renamed build as user contracts on both backends; `qRWA.h` cannot — reserved name, and
renamed it fails the log-header gate — the by-filename bypass for the shipped file is from `system-contracts.ts:12`,
not exercised, since the reserved-name check fires first), F22, F33 family (renderers are
uncapped but fast enough at 35 entries / 593 MB), H7 (a zeroed `id` renders `0` in the diff, blank in `state`, the
60-`A` identity through `--out`). Not exercised: the explorer's `--in` echo road (TUI navigation; F23/F25 unchanged), `qinit test`/`gtest`.
Withdrawn before filing: H4 as written (the nested-struct shape agrees on both roads —
the real defect is F52), H12 (unreachable through QPI's whole-struct `set`), the BitArray padding-bits rendering (documented
and reachable through the raw `--out` road).

## Findings

### F46 — on the simulator a ≥500 MB contract is single-shot: INITIALIZE plus one state-changing procedure exhaust the fee reserve, and every later `call --proc` reports `ok` while the node silently skips it

**Repro** (clang × simulator, fresh node, `--tick-ms 300`):
```
qinit deploy contracts/XCHG.h --compiler clang            # ok, slot 29, 10 s
qinit call --proc XCHG IssueAsset --args '{"assetName":23735438096418132,"numberOfShares":1000000,"unitOfMeasurement":0,"numberOfDecimalPlaces":0}' --amount 1000000000 --json
  -> {"ok":true,"tick":3795,"tx":"qvres…","out":null}        # executed: trace seq 539, out 40420f00… = 1 000 000
qinit call --proc XCHG AddToAskOrder --args '{"issuer":"BZBQ…QEXK","assetName":23735438096418132,"price":100,"numberOfShares":10}' --trace --json
  -> {"ok":true,"tick":4413,"tx":"ssvph…","out":null,
      "warnings":["(no trace captured — is the debug toggle available on this node?)"]}
```
Repeated with `--amount 0`, `1000`, `1000000000`: every call `ok:true` with a fresh tx id, **zero new frames** in
`GET /live/v1/debug-trace` (max seq stays 541), the order book stays `empty · 2097152/2097152 PoV slots unoccupied`,
the amount is refunded. A `--fn` on the same contract still executes and records a frame (seq 541).

**Cause** (engine source, confirmed by the frames): `packages/engine/src/contract/runtime.ts:86-87,893-897` charges
every mutating entry `BASE_CALL_COST (10) + host weights + DIGEST_BYTE_COST (1) × stateSize` when the state changed;
`fees.ts:10` seeds a metered deploy with `DEFAULT_FEE_RESERVE = 1e9`; `fees.ts:53-54` gates procedures on
`reserve > 0`. For XCHG: INITIALIZE (trace seq 1, `diff 1`) = 621 806 130; 530 per-tick sysprocs (`diff 0`) = 5 300;
IssueAsset (seq 539, `diff 1`) = 621 806 130. Total 1.2436e9 > 1e9 → dormant after the first user procedure.
QUOTX (923 559 560 B) would go dormant after INITIALIZE alone plus one call. Metering is the transport default
(`transport.ts:108`) and nothing in the CLI or environment turns it off; Qx has no `qpi.burn`, so nothing refills it.

**What the CLI shows** — nothing:
- `qinit call --proc` → `ok:true`, tick, tx id; `--trace` → *"is the debug toggle available on this node?"* (the toggle
  is on; `enabled:true` on the route).
- `qinit ls --json` → slot 29 `"state":"ready"`; `qinit node status` → `up, ticking`; `qinit info` → nothing;
  `GET /live/v1/dev/fault` → `null`; `node.log` → the one startup banner line.
- The engine *does* know: `qubic-simulator.ts:1363-1371` emits `warn/fee "slot 29 dormant — tx it=5 skipped, refunded …"`
  to `onLog` — and no sink is ever attached to it (`transport.ts:90-95` is the only reference), so the message goes
  nowhere. No RPC route exposes `feeReserve(slot)` (`transport.ts:120`), so the CLI could not show it even if it asked.

**Expected**: either the call is rejected with a reason (`dormant: fee reserve 0`), or `ok:false` with the refund noted,
and `ls`/`node status` say dormant. **Actual**: success with a tx id, silently no-op, and a misleading hint.

**Severity**: silent wrong result (a developer sees `ok` + tx and reads the unchanged state as a contract bug) —
compounded by scale: at ≥500 MB the reserve model gives one procedure per deploy, so no multi-step scenario can be
driven on the simulator at all. Core-lite charges a computor-quorum of *measured* execution
(`ticking/execution_fee_report_collector.h:143-149`) and exempts sysprocs from the gate (`contract_exec.h:758`), so
**the core cell diverges as predicted** (`~/Projects/qinit-c4/qx/core-f46.log`): same binary, same sequence on
`qinit runtime core` — deploy 10 s, IssueAsset executes (frame `(1,1,1)`), then AddToAskOrder ×3 all execute
(frames `(1,5,8)`, `(1,5,7)`, `(1,5,7)`), `out 10` each, and `state --container 1` shows
`_assetOrders · 3 entries · 2097151/2097152 PoV slots unoccupied`. Simulator: one procedure, then silence.

**Control**: `--fn` calls (read-only, not charged) keep working on the dormant contract; the same sequence on a
small contract (campaign 3's `Ledger`, 40 procedures in a row) never went dormant.

**Quantified on NEXUS (550 832 968 B) × simulator** (`~/Projects/qinit-c4/nexus/sim.log`): deploy 20 s;
`Refuel --amount 5000000000` (the contract's `qpi.burn` of its reward, which the simulator credits to the reserve —
`qubic-simulator.ts:567`) is charged ~551 M and adds 5 e9; the next **nine** state-changing procedures run
(`procframes` 2→10), the tenth (`ProcessUnlocks`) is skipped with `ok:true` and *"no trace captured — is the debug
toggle available"*. So the budget is ≈ 1 procedure per 551 M qu of reserve, i.e. one per ~`stateSize` qu — a burn is
the only refill, and Qx has none.
**Not a finding**: dormancy itself is Qubic's spec (`fees.ts:62`, core `contract_exec.h:409`); the finding is the
per-byte cost making a production-size contract single-shot on the dev node, and the CLI's silence about it.

### F47 — `--json` carries the *rendered display text* as `out` and as every state field `value`, not structured data: unquoted keys, run markers and elision inside a JSON string

**Repro** (clang × simulator, XCHG@29):
```
qinit call --fn XCHG Fees --json
  -> "out": "{assetIssuanceFee: 1000000000, transferFee: 100, tradeFee: 3000000}"      # a string, keys unquoted
qinit call --fn XCHG AssetAskOrders --args '{"issuer":"BZBQ…","assetName":23735438096418132,"offset":0}' --json
  -> "out": "[{entity: \"AAAA…FXIB\", price: 0, numberOfShares: 0} ×256]"              # 256 records collapsed to one + "×256"
qinit call --fn XCHG Fees --out "uint32,uint32,uint32" --json   -> "out": "[1000000000, 100, 3000000]"   # still a string
qinit call --fn XCHG Fees --out uint32 --json                    -> "out": "1000000000"
qinit state XCHG --json
  -> "fields": [{"name":"_earnedAmount","value":"1000000000"}, …,
                {"name":"_tradeMessage","value":"{_contractIndex: 0, _type: 0, issuer: \"AAAA…\", assetName: 0, price: 0, numberOfShares: 0, _terminator: 0}"}]
```
`type(out)` is `str` in every case; `jq '.out.transferFee'` fails, and the order book's 256 records are unrecoverable
from the envelope — the run collapse (`×256`, `state-format.ts:54-65`) and the 32-item elision (`… +N more (--all)`,
`state-format.ts:88-93`) are baked into the text. The same command's `trace.logs` (campaign 3) and `containers[]` here
are proper objects, so the envelope is inconsistent with itself.

With 35 live orders (core cell): `call --fn XCHG AssetAskOrders … --json` → `out` ends in
`…, {entity: "BZBQ…", price: 1029, numberOfShares: 1}, … +4 more (--all)]` — after run-grouping the 256 slots are
36 parts (35 orders + one `×221` zero run), 32 are printed, so **three orders and the zero-run summary are absent from
the machine output** until `--json --all` (which returns all 35, still as a string).
`docs/cli-guide.md` §5 specifies only "exactly one JSON result to stdout"; the shape of `out`/`value` is not documented,
so this is filed as a defect rather than a documented limitation. The `--json` `state` rows of a
`--proc --trace` *are* objects (`{label, detail, text, internal}`), but `text` is again prose (`"3 → 2"`), and the
`in` echo is the same unquoted-key string.

**Expected**: `out` and `value` as JSON values (objects/arrays, 64-bit as strings) — the decoder already produces them
(`decodeOutput` → `formatStateValue`, `call.tsx:347-351`); only the last step stringifies.
**Severity**: wrong shape for the feature's purpose (machine consumers), silent — every value is "present" but only as
prose. Extends F6/F22/F24 (`--json` gaps) from *missing keys* to *unusable values*.
**Control**: `state --json` `containers[]` and `--digest --json` are structured; `bigint` text is correct where it appears.
The **generated client** (`qinit gen` → `gen/NEXUS.ts`) returns real values for the same calls —
`Stats()` → `{totalVolume: 50000n, poolCount: 2, …}`, `PoolInfo(0)` → nested object with `features: [1,0,0,0,0,0,0,0]`,
`LedgerView()` → `{buckets: [1n, 777n, 0n, 0n], …}` — and every value agrees with `call --json`'s text, so the decoder
is right and only the CLI's last step is prose (`~/Projects/qinit-c4/nexus/gen-road.ts`).

### F48 — the state diff silently drops every field that follows interior padding inside a struct — 8 of 20 procedure frames in one production-shaped session lose rows

**Scale of it** (`~/Projects/qinit-c4/precheck/audit-frames.py`: names every changed byte of every trace frame from the
IDL with its own walker, then checks that some CLI row covers it; NEXUS@29, clang × core, the D4/D5 session):
```
createpool   rows=6   changed leaves=15  MISSING: pools[0].assetName pools[0].features pools[0].phase
                                                  epochLog.snapshot.{reserveQu,reserveAsset,feeRate,features,assetName,phase}
createpool2  rows=4   changed leaves=9   MISSING: pools[1].assetName pools[1].features pools[1].phase epochLog.snapshot.{assetName,feeRate}
borrow       rows=12  changed leaves=4   MISSING: positionLog.debt
borrow2      rows=11  changed leaves=4   MISSING: positionLog.debt
vote         rows=9   changed leaves=22  MISSING: voteLog.tally
vote2        rows=6   changed leaves=12  MISSING: voteLog.tally
audit        rows=7   changed leaves=8   MISSING: ledger.buckets[2] auditLog.buckets[2] auditLog.checksum
audit2       rows=3   changed leaves=6   MISSING: ledger.buckets[3] auditLog.buckets[3] auditLog.checksum
deposit repay swap unlock1-3 process poolflags drift driftsame breaker cleanup: ok       → 8 of 20 frames
XCHG (Qx) session, 2 frames: ok — Qx's structs are id/sint64 only, no interior padding.
simulator cell (clang): CreatePool / Deposit / Borrow / Vote / Audit / QueueUnlock produce row sets **identical** to core's
(same `detail` names, same logs), so the drop is the renderer's and is runtime-independent.
```
Every missing leaf sits after the first padding hole of its struct: `Pool { u64, u64, u32 feeRate, u8 flags, [3 pad],
u64 totalLp, bit_8 features, u64 assetName, u8 phase }`, `PositionLog { …, u32 poolIndex, u8 tier, [3 pad], s64
collateral, s64 debt }`, `VoteLog { …, s16 delta, s8 verdict, [5 pad], u128 tally }`, `Ledger`/`AuditLog { u8 version,
[7 pad], … }`. The witness is in the same frame each time: `CreatePool`'s rows end at `pools[0].feeRate 0 → 30` while its
decoded `EpochLog.snapshot` reads `[1000, 1000, 30, 0, 0, [1,0,0,0,0,0,0,0], 4407873, 1]`.


**Function-level repro** (`~/Projects/qinit-c4/precheck/h1.ts`, `stateDiffLines()` fed a synthetic IDL and one region):
```
StateData { Inner inner; uint64 tail; }   Inner { uint8 a; Array<uint64,2> b; }   // a@0, pad 1..7, b@8, tail@24
region off=0, 32 bytes, all four values written: a=1, b[0]=42, b[1]=43, tail=44
  expected 4 rows: inner.a, inner.b[0], inner.b[1], tail
  actual   2 rows: ["inner.a 0 → 1", "tail 0 → 44"]              # b[0], b[1] gone, no warning

Inner { uint8 a; uint64 b; uint64 c; }, region off=0 len=20 (window ends inside c): a=1, b=42, c partial
  expected: inner.a, inner.b, inner.c+<partial>
  actual   1 row: ["inner.a 0 → 1"]                              # b gone although fully inside the window
control: the same struct with the window covering it exactly → "inner 0 → {a: 1, b: 42, c: 43}"  (whole-struct shortcut)
```
**Cause**: `cli/src/trace/state-diff.ts:122-126` — when the walk lands in a struct's interior padding, `leafAt` returns a
zero-count bits leaf sized `type.size - offset` (to the *struct end*), and `:512` sets `position = visibleEnd`, so the
walk resumes after the struct instead of at the next field. The whole-struct shortcut at `:118` hides it whenever the
window covers the struct exactly; it fails to fire for a struct that holds a container or straddles a 256-byte window
edge, which is exactly the production shape (`Qx.StateData._assetOrder`, Quottery's option structs).
`tests/format/state-diff.test.ts:387-410` covers trailing record padding only.

**Severity**: silent wrong state report — `call --trace` / `qinit debug` show a write that did not happen as "no change".
**CLI-edge repro** (clang × core, NEXUSBT@30 — same layout as NEXUS; `Ledger { uint8 version; Array<uint64,4> buckets; HashSet<id,64> auditors; uint64 checksum; }` at state offset 550 830 272):
```
qinit call --proc NEXUSBT Audit --args '{"bucket":1,"amount":777,"auditor":"BZBQ…"}' --trace --json
  state rows: ledger.version 0 → 1 · ledger.auditors.slot[31] (new) · ledger.auditors._occupationFlags[31] 0 → 1 ·
              ledger.auditors._population 0 → 1 entries · ledger.checksum 0 → 777 · auditLog._type · auditLog.version
  raw region (debug-trace frame seq 289, off 550830080 len 256):
              version   @+0   00 → 01
              buckets[1] @+16  0000000000000000 → 0903000000000000        # 777 — written, no row
```
`ledger.buckets[1]` was written by the contract (the function road confirms it: `LedgerView` → `buckets: [0, 777, 0, 0]`)
and is absent from the diff; the four fields after the padding that *do* appear are those the walk reaches through the
container's own leaf resolution. Every other value in the frame is named.

Two more instances in one session on NEXUS@29 (`~/Projects/qinit-c4/nexus/d45/audit.json`, `audit2.json`), with a
**cross-path witness in the same frame**: the decoded `AuditLog` (a copy the contract logs) shows what the diff drops.
```
Audit bucket=2 amount=4242:  rows: ledger.version 0 → 1 · ledger.auditors.slot[31] (new) · … · ledger.checksum 0 → 4242 ·
                                   auditLog._type 0 → 7 · auditLog.version 0 → 1
                             log:  AuditLog {version: 1, buckets: ["0","0","4242","0"], checksum: "4242"}
                             missing rows: ledger.buckets[2] 0 → 4242, auditLog.buckets[2] 0 → 4242, auditLog.checksum 0 → 4242
Audit bucket=3 amount=99:    rows: ledger.version 1 → 2 · ledger.checksum 4242 → 4341 · auditLog.version 1 → 2
                             log:  AuditLog {version: 2, buckets: ["0","0","4242","99"], checksum: "4341"}
                             missing rows: ledger.buckets[3] 0 → 99, auditLog.buckets[3] 0 → 99, auditLog.checksum 4242 → 4341
```
`AuditLog { uint32; uint32; uint8 version; Array<uint64,4> buckets; uint64 checksum; sint8 _terminator }` has the same
`uint8`-then-padding shape and no container at all, and loses `buckets` *and* `checksum`.

### F49 — cancelling a Collection element renders as a *priority update* on a different element plus a zero-out; no `(removed)`, and the moved order is invisible

**Repro** (clang × core, XCHG@29 with three asks at prices 100/200/300 → `_assetOrders._elements[0..2]`, priorities −100/−200/−300):
```
qinit call --proc XCHG RemoveFromAskOrder --args '{"issuer":"BZBQ…QEXK","assetName":23735438096418132,"price":200,"numberOfShares":10}' --trace --json
  state rows (non-internal):
    _assetOrders[1].priority        -200 → -300
    _assetOrders[2]                 {entity: "BZBQ…QEXK", numberOfShares: 10} → 0
    _assetOrders[2].priority        -300 → 0
    _assetOrders                    3 → 2 entries
    (and the same four for _entityOrders)
```
What happened in core (`qpi_collection_impl.h:879-890`): the −200 order at element 1 was deleted and the last element
(the −300 order) was **moved into slot 1**; slot 2 was zeroed. What the diff says: element 1's price changed from 200 to
300 and element 2 was cleared. The −200 order's disappearance is never stated, and the −300 order's move is invisible
because its `value` bytes (same entity, same 10 shares) did not change — only its `priority` row moved, and that reads as
an edit. `_assetOrders 3 → 2 entries` is the only hint, on a different line.

The same holds for `LinkedList`: removing the middle node of three (NEXUS `ProcessUnlocks`, `d45/process.json`)
renders as `unlocks._nodes[1].value {…} → 0` plus link/flag/free-list bookkeeping — no `(removed)`.
**Cause**: `state-diff.ts:185-189, 331-386` — `collapseEntries` emits `(new)`/`(removed)` only for keyed containers
(records + key member: HashMap/HashSet); Collection and LinkedList records have no key member, so their rows are
byte-faithful field diffs. Byte-faithful is not wrong, but for a compacting container it is the wrong *story*.
**Expected**: `_assetOrders[1] (removed) {…, p-200}` and `_assetOrders[2] → [1] (moved)`, or at least `(removed)` on
the deleted record, the way HashMap rows already read.
**Severity**: wrong diagnostic (silent misdirection — an order-book developer debugging a cancel sees a price change).
**Control**: the duplicate-price add (`AddToAskOrder price=100 shares=5`, Qx's `replace` path) produces 5 rows that
*are* an update and read correctly as one. Offline replay of the same frame through `stateDiffLines()`
(`precheck/replay.ts`) reproduces the CLI's 25 rows exactly, so the renderer, not the transport, is the source.

### F50 — a log struct with a field *after* `_terminator` builds on both compilers with no diagnostic; the field is never logged and the whole log becomes undecodable

**Build-level repro** (`~/Projects/qinit-c4/nexus-bt/contracts/NEXUSBT.h`, Nexus with `AuditLog` reordered):
```cpp
struct AuditLog { uint32 _contractIndex; uint32 _type; uint8 version; Array<uint64, 4> buckets; sint8 _terminator; uint64 checksum; };
```
`qinit build --compiler clang` → ok; `--compiler typescript` → ok; no warning from either. The IDL entry that both
compilers emit for it: `size 48`, fields `[_contractIndex@0, _type@4, version@8, buckets@16, checksum@56]`.
The node logs `offsetof(_terminator)` = **48** bytes (`logging.h`, `emitLogMessage` passes `offsetof(_terminator)`),
so `checksum` never reaches the log; and the decoder's `loggedSizeOf` for the catalog entry is `56 + 8` = **64**
(`decode-log.ts:23-28`, last field's end), which can never equal 48, so every `AuditLog` renders as hex only.
Function-level proof: `precheck/h2h6.ts` (`loggedSizeOf 24` vs node `8` on a smaller shape → `name undefined`).

**Cause**: `enums-and-logs.ts:76-90` strips `_terminator` and forces `size = terminator.offset`, but keeps every field
declared after it; `log-call-validation.ts` checks the header word and the terminator's presence, not its position;
clang's wrapper only asserts `offsetof(_terminator) >= 8`.
**Expected**: a build error (`_terminator must be the last member`) — the contract author's intent cannot be honoured.
**Severity**: silent data loss in the protocol log (the trailing field is dropped on chain, not just in Qinit) plus a
silently undecodable log in the CLI. **Control**: the same struct with `_terminator` last decodes (`AuditLog` in
`NEXUS.h`, IDL `size 56 / loggedSize 56`).

**CLI-edge repro** (clang × core, NEXUSBT@30):
```
qinit call --proc NEXUSBT Audit --args '{"bucket":1,"amount":777,"auditor":"BZBQ…"}' --trace --json
  "logs": [{"severity":"INFO","type":6,"name":null,"fields":null,"hex":"0x1e000000 07000000 01000000 00000000 …"}]   # 48 bytes, undecoded
  state rows: ledger.version 0 → 1 · ledger.auditors.slot[31] (new) · … · ledger.checksum 0 → 777
qinit call --proc NEXUSBT Audit … --trace        ->   log    INFO 48B
```
The contract computed and stored `checksum = 777`; the log carries 48 bytes (no `checksum`), and the catalog wants 64,
so the record is shown as `INFO 48B` with no name. Both compilers built this without a word.

### F51 — `--amount` is parsed with `Number()`: `18446744073709551615` is sent as **0** with `ok:true`; `1e3` and `0x10` are silently accepted

**Repro** (clang × core, NEXUS@29, `Refuel` burns its invocation reward and reports it):
```
qinit call --proc NEXUS Refuel --amount 1000                  -> ok, out 1000
qinit call --proc NEXUS Refuel --amount 1e3                   -> ok, out 1000        # accepted, not an integer literal
qinit call --proc NEXUS Refuel --amount 0x10                  -> ok, out 16          # accepted; --in rejects hex
qinit call --proc NEXUS Refuel --amount 1.5                   -> exit 1 "Not an integer"
qinit call --proc NEXUS Refuel --amount -1                    -> exit 1 "Option '--amount' argument is ambiguous."  (F1's parser)
qinit call --proc NEXUS Refuel --amount 9007199254740993      -> exit 1 "Invalid validity"   (2^53+1; > the 10 B balance, node-rejected — opaque message)
qinit call --proc NEXUS Refuel --amount 18446744073709551615  -> ok:true, tx sent, out 0, in '{}'   # UINT64_MAX became 0
Stats.burnedTotal afterwards: 2016 = 1000 + 1000 + 16.
```
**Cause**: `call.tsx:377` `amount: Number(amount ?? 0)`; `Number("1e3")`/`Number("0x10")` are numbers, `Number("1.5")` trips
the later integer check, and 2^64−1 rounds to 1.8446744073709552e19, which the int64 conversion folds to 0.
**Expected**: the same grammar as `--in`/`--args` integers (digits only, exact, range-checked), and a refusal for a value
outside `sint64`. **Severity**: money path — a wrong amount is sent with a success verdict (silent), though the realistic
range (≤ ~1e15 qu) is unaffected; the exotic spellings are a consistency defect. **Control**: `--in`/`--args` reject
`0x10`, `1_000`, `+5`, `5 uint64` (correct messages) — `--args` however accepts `""`→0, `"0x10"`→16, `true`→1 for
integer fields (`abi-fmt.ts:536-545`, `BigInt()` coercion), verified by the raw state bytes after a `Mirror` call
(`~/Projects/qinit-c4/nexus/d1.log` row `h9`).

### F52 — `--in` lays the input out from the *spelling*, checks only the total length against the IDL, and so accepts a wrong-typed or reordered spelling that writes silently wrong values

**Repro** (clang × core, NEXUS@29; `Mirror` copies its input struct verbatim into state; raw bytes read back over
`GET /live/v1/dev/state-read`, no Qinit decoder involved). The declared input has `sint8 s8 @80, sint16 s16 @82, sint32 s32 @84`:
```
--in="{…, -1sint8, -2sint16, -3sint32, …}"     -> ok; bytes[80..88] = ff 00 fe ff fd ff ff ff      (s8=-1, s16=-2, s32=-3 ✓)
--in="{…, -2sint16, -1sint8, -3sint32, …}"     -> ok, no warning; bytes[80..88] = fe ff ff 00 fd ff ff ff
                                                  contract now holds s8 = -2, s16 = 255, s32 = -3
--in="{1uint64, {2uint8, 5uint64}, …}"          -> ok (the field is a uint8; the extra 7 bytes land in padding)
--in="{…, [4; 0uint64, 0uint64, 0uint64, 0uint64],}"  -> ok (trailing comma)
```
Rejected correctly, with a good message, when the *token* is malformed: `1_000uint64`, `+5uint64`, `5 uint64`, `5UINT64`.
`0x10uint64` is rejected with the wrong message — `unknown type 'x10uint64'` — because `x` is the repeat multiplier
(`abi-fmt.ts:600`).

**Cause**: `encodeInput` (`abi-fmt.ts:640-749`) pads and places each token by its own spelled width (`tokenAlign`
`:615-634`); the IDL is consulted only through `checkInputSize` (`:945-949`), a byte-length equality. `--args` goes
through `encodeAbiType` (`:390-439`) at the IDL's offsets, so the two roads agree only while the spelling happens to
reproduce the declared layout. The docs (§9.1) say a *named* entry needs the IDL — it is loaded, but not used to type
the tokens.
**Expected**: when an IDL is present, each `--in` token is checked against the declared field type (or at least a
warning names the first mismatch); the error for `0x10` should say "hex is not accepted".
**Severity**: wrong diagnostic — the user's spelling is illegal against the IDL Qinit holds, and it is accepted instead
of rejected; the consequence is a silently wrong value with `ok:true`. **Control**: `--args` with the same
values by name produces the declared layout (D1 `plain` row: `--args` bytes == `--in` bytes == the Python oracle).

### F53 — two log structs with the same logged size make *both* undecodable: the catalog is matched by size alone and `_type` is never consulted

**Repro** (clang × core, NEXUS@29; `Repay` and `Swap` each emit a `TradeLog {…; uint64 amount; …}` and a
`FeeLog {…; uint64 fee; …}`, both 16 logged bytes, `_type` 3 and 4):
```
qinit call --proc NEXUS Swap --args '{"poolIndex":0,"minOut":1}' --amount 50000 --trace --json
  out {amountOut: 50, fee: 150}
  logs: [{"severity":"INFO","type":6,"name":null,"fields":null,"hex":"0x1d000000030000003200000000000000"},
         {"severity":"INFO","type":6,"name":null,"fields":null,"hex":"0x1d000000040000009600000000000000"}]
```
The payloads are intact and self-describing — word 1 is `_type` = 3 (`LOG_TRADE`) and 4 (`LOG_FEE`), enum names the
IDL knows — yet neither gets a name or fields. A contract with **one** 16-byte log struct decodes fine (campaign 3,
`Small`), and `PositionLog` (64 B), `EpochLog` (72 B) and `VoteLog` (144 B) in the same contract decode, so the
failure is purely the size collision. Function-level: `precheck/h2h6.ts` (`hit.length === 2` → base record).

**Cause**: `proto/src/decode-log.ts:40-41` — `catalog.filter(loggedSizeOf(entry.type) === size)`, decode only if exactly
one; `_type` is read at `:57` *after* the match, only to look up an enum name. The `_type` word is at a fixed offset in
every Qubic log payload (`_contractIndex` @0, `_type` @4 — the convention every contract in `core-lite/src/contracts`
follows) and is the natural discriminator.
**Expected**: disambiguate same-size candidates by `_type` (the `LogType` enum is already in the IDL: `enums-and-logs.ts`).
**Severity**: silent loss of readability for a shape production contracts hit routinely — any two "amount-shaped"
events collide (Qx's `TradeMessage` is safe only because it is the sole log struct). **Control**: `PositionLog`,
`EpochLog`, `VoteLog`, `AuditLog` in the same frames decode with names and fields.

### F54 — `qinit debug` cannot hold a selection while frames arrive: ↑/↓ moves by index, new rows insert above, so the cursor slides to a different frame every tick

**Repro** (clang × core, NEXUS@29 with `END_TICK` recording a frame every tick — every production contract with a tick
handler does; captures in `~/Projects/qinit-c4/nexus/tui/`, one key per `send-keys`, `capture-pane` after each):
```
open            selected: (newest)                    01-06 Down ×6   selected: sys#4 (END_TICK)  — six different ticks
07 Down         selected: proc#16 (Cleanup)           08 Down         selected: sys#4 (END_TICK)  — the list moved under the cursor
09 ctrl+t, 10 pgup                                    selected: sys#4 (END_TICK)
```
With ~3 frames/s the row a keypress lands on has usually been displaced by the time the pane redraws; reaching a frame
20 rows back is a race the user loses. The right pane always describes "the row at index N", not the frame the user
picked. There is no pause key; `x`'s effect was not determined (one press under load, `debug-frame4.txt`).
**Expected**: selection pinned to a frame `seq`, or capture pause/follow toggle.
**Severity**: usability (the one-shot `call --trace` and `--json` are unaffected). **Control**: expected to be static on
a contract without a tick handler; not re-run — every probe in this campaign has `END_TICK`.

## Verified correct (oracle-checked, no defect)

- **Layout**: clang's wasm32 `sizeof`/`offsetof` (a C++ TU compiled against the real `qpi.h`, `bin/offsets.sh`) equals
  the IDL for every top-level state field of XCHG (22), EARNX (9), QUOTX (25), NEXUS (28) and the three threshold variants,
  and the clang and TypeScript IDLs are byte-identical for all of them. State sizes: 621 806 120 / 214 171 656 /
  923 559 560 / 550 832 968 B.
- **Dump ↔ digest**: `state --digest` == K12 of the `--dump` bytes at 593 MB on both runtimes (sim `a99d2586…`, core
  `6ed48f77…`), and `--dump` size == `stateSize` (72 s sim, 59 s core, ~10 MB/s over the hex RPC).
- **Container decoding vs raw bytes**: an independent Python decoder of `Collection<AssetOrder, 2^21>` written from
  `qpi_containers.h` alone (`oracle/collection.py`), run over the raw core dump, reproduces `state --container 1`
  exactly — population 35, PoV[874783] flag `01`, BST in-order priorities −100, −300, −1000…−1032 (Qx stores `-price`,
  so the signed-priority row is inherent and renders `(p-100)` correctly).
- **Encode parity**: for a 136-byte production-shaped input (nested struct, two BitArrays, id, every signed width, bit,
  array) `--args` bytes == `--in` bytes == the Python-packed image built from the wasm32 offsets, on all four cells
  (`d1.log` `plain`; `ts-core`/`ts-simulator` `mirror bytes`). `INT*_MIN`, `UINT64_MAX`, `2^53±1` round-trip exactly.
  `BitArray` differs between the roads only above the declared length, as documented (`--in` = physical words).
- **Decode**: `uint128` decodes on every road (IDL, `--out uint128`, `--json`, generated client) including a real sum
  past 2^64 (`tally 18446744073709601615`); `sint8/16/32` extremes render signed; nested `Array<Struct,2>` in a log
  decodes; `EpochLog` with a nested `Pool` (padded struct) decodes with names at the top level.
- **Single-field outputs** (H11, observation): `Params` → IDL road `30`, `--out uint32` → `30`, `--out "{uint32}"` → `[30]`;
  the format-string road never applies the one-field unwrap (`abi-fmt.ts:374-381`). Consistent with the docs, noted for D2.
- **Generated client** (`qinit gen`) returns structured, bigint-typed values that agree with `call --json`'s text on
  `Stats`, `PoolInfo`, `LedgerView`, `MirrorView`, `Mirror128View`.
- **Diff controls**: a write of the same value (`SetDrift -5` twice) produces 0 rows; a `HashMap<StructKey, …>` insert
  renders `slot[n] (new)`, an update as one `value` row; a partial write to an `Array<Struct>` element renders the one
  field (`pools[0].flags 0 → 7`); `BitArray` bit set renders `breakers[0] 0 → 1`; a `Cleanup` with nothing to compact
  is 0 rows; the LinkedList middle removal renders every link and the free-list head.
- **Cross-cell**: the same 8-step protocol session produces identical diff row sets, log names and outputs on
  clang×sim, clang×core, ts×sim and ts×core (only tick-stamped values differ).
- **Design, not defects** (ground rule 4): dormancy on an exhausted fee reserve (`fees.ts:62`, core `contract_exec.h:409`);
  `BitArray::set` masking out-of-range indexes into real bits; a never-used `LinkedList` reading head 0 (guarded by
  population); `LOG_PAUSE` not suppressing the debug trace (F5); the 2-bit tombstone `10` rendering as unoccupied;
  the 10 MiB collapse and the 4 MiB page (D6 rows below).

## D6 — scale and boundaries (core, `~/Projects/qinit-c4/nexus/d6.log`)

| row | result |
|---|---|
| 10 MiB collapse threshold, `Array<Probe,131072>` at 72 / 80 / 88 B per element (`NEXTHRUNDER/EXACT/OVER`) | 9 437 184 B → `loaded` (`0 set · 131072/131072 zero`); **10 485 760 B → `collapsed`**; 11 534 336 B → `collapsed`. "≥ 10 MiB" as documented. |
| a struct straddling the 4 MiB page inside a container (element 52428 of the 80 B array spans container bytes 4 194 240–4 194 320; `w3` ends at 4 194 304, `w4` starts there) | raw bytes `03… 04…`; `state --container 8` renders `[52428] {…, w0: 7, w1: 0, w2: 0, w3: 3, w4: 4, …}`; `--json` `totalEntries 4` with `[1..52426]` and `[52430..131071]` zero runs. Both pages joined correctly. |
| the same `Poke` on four elements | diff rows differ in *shape*: `probe[0]`, `probe[52427]`, `probe[52428]` → one whole-element row; `probe[52429]` → two field rows (`.tag`, `.w0`) because its 256-byte window cuts the element — the whole-struct shortcut's on/off is what decides F48's outcome. |
| `state --dump` / `--digest`, XCHG 621 806 120 B | sim 72 s / 7 s, core 59 s / 1 s; digest == K12(dump) both; size == `stateSize` |
| empty containers over RPC, NEXUS | HashMap 151 MB 7 s, Collection 160 MB 8 s (population short-circuit); `Array<Voter>` 235 MB **80 s** (no population word → full scan) |
| a third 550 MB contract on one core node | deploy 31 s → 80 s → 107 s as residents accumulate (RAM 17 GB free → 3 GB) |
| 593 MB / 550 MB contracts on the simulator | deploy 10–20 s, RSS ~750 MB steady, tick rate unchanged (3.3/s at `--tick-ms 300`); the constraint is the fee reserve (F46), not CPU |


## Compiler × runtime matrix (computed values)

| probe / row | clang×sim | clang×core | ts×sim | ts×core |
|---|---|---|---|---|
| NEXUS `Mirror` plain row, 136 state bytes vs Python image | == (after `Refuel`) | == | == | == |
| NEXUS 8-step session: diff rows / logs per step (pool 6, deposit 6, borrow 12, repay 14, vote 9, audit 7, drift 1, driftsame 0) | identical | identical | identical | identical |
| NEXUS `Stats.totalVolume` after one 50 000 swap | 50000 | 50000 | 0 (no swap in the TS subset) | 0 |
| NEXUS `Vote` log `tally` = 50 000 + 2^64−1 | 18446744073709601615 | 18446744073709601615 | — | — |
| NEXUS second state-changing procedure without `Refuel` | **skipped** (F46) | runs | **skipped** | runs |
| NEXUS `Refuel 5e9` then procedures before dormancy | 9 | n/a | ≥ 8 | n/a |
| XCHG `IssueAsset` then `AddToAskOrder` ×3 | 1 ran, 3 skipped | 4 ran, book = 3 entries | — | — |
| XCHG `state --digest` == K12(`--dump`) | a99d2586… == | 6ed48f77… == | — | — |
| XCHG `Fees` | 1000000000/100/3000000 | same | — | — |
| Deploy time, 593 MB / 550 MB | 10 s / 20 s | 10 s / 44 s | 13 s | 15 s |
| Build size (NEXUS wasm) | 149 233 B | 149 233 B | 24 577 B | 24 577 B |

## Suite counts (commands, exit codes as observed)

| suite | rows | ran / skipped by the node / rejected by the CLI | findings |
|---|---|---|---|
| D0 layout | 8 contracts × 2 compilers; 84 fields checked | 16 builds exit 0 (after 3 probe-side fixes to `Nexus.h`) | 0 |
| D1 encode parity (`nexus/d1.log`) | 10 rows: `plain` (2 roads agree), `bounds` (documented BitArray asymmetry), `h9`, 7 malformed `--in` | 5 exit 0 (3 of them wrongly accepted: `h9` coercions, `1uint64` for a `uint8`, trailing comma) / 5 exit 1 (`0x10`, `1_000`, `+5`, `5 uint64`, `5UINT64`) | F52, F51 (`--args` coercions) |
| D2 output decode | 14 | 14 / 0 / 0 | F47, H11 |
| D3 state inspection | 11 renders + 2 dumps + 2 digests + 1 oracle decode | all exit 0 | F9, H7 (confirmations) |
| D4 diff ladder | XCHG core 39 procs (`qx/core-f46.log`, `core-d4/`, `fill33.log`); XCHG sim 9 (`qx/*.json`); NEXUS clang×core 20 (`nexus/d45.log`); clang×sim A 11 + B 3 (`nexus/sim.log`); ts×core 9 (`ts-core.log`); ts×sim 10 (`ts-sim.log`) | 90 ran / 11 skipped by the node with `ok:true` (XCHG sim 8, NEXUS sim A 1, B 2 — F46) / 0 rejected | F48, F49 |
| D5 logs | 12 log-bearing frames + NEXUSBT 2 | all decoded except the two collisions and the variant | F50, F53 |
| D6 scale | 3 threshold deploys, 4 pokes, 2 renders, 4 dumps/digests, 3 container timings | all exit 0 | 0 |
| pre-checks (pure functions) | `h1.ts` 3 cases, `h2h6.ts` 4, `replay.ts`, `audit-frames.py` 22 frames | H1/H2/H6 confirmed, H4 withdrawn | — |

## Index
F46 dormancy · F47 `--json` prose · F48 diff drops after padding · F49 Collection removal story · F50 field after
`_terminator` · F51 `--amount` `Number()` · F52 `--in` layout unchecked · F53 same-size logs · F54 TUI selection drift.
Workspace `~/Projects/qinit-c4/` (`bin/`, `oracle/`, `precheck/`, `matrix/STATUS.md`, per-probe dirs with every JSON).
