# Browser IDE — campaign 1 (W1+)

First campaign against the browser IDE (`Qinit-web/frontend/src/ide`), driven the way a contract developer uses it: write a
contract in the editor, Compile & Run, call procedures and functions, read state, run TS tests. The campaign itself was
report only. The fixes came afterwards: every finding below ends with a "Fixed in" line naming the commit, and the two small
items left as they are say why.
Findings are numbered from **W1** so they do not collide with the CLI campaigns' F-series (F219–F226 are taken, F227+ is
reserved for the oracle campaign).

Under test: Qinit-web `c19e4ba`, Qinit `dd93a3d7`, Vite dev server at `http://localhost:5180`, plus one pass of the core loop
against a production build (`bun run build` + `vite preview`), which behaved the same.
Browser: Google Chrome 140.0.7339.185, headless, a fresh profile per scenario, driven by `playwright-core` (real clicks and
key input, no page-internal APIs).
Workspace: `~/q/webide/` — `lib/ide.ts` (driver), one script per phase (`p0a.ts` …), `runs/<script>/` (console log and
screenshots). Each finding names the script that reproduces it: `cd ~/q/webide && bun run <script>.ts`.

Severity ladder: **lost work or silent wrong value/state** > wrong or missing diagnostic > loud rejection of legal input >
crash or hang with a message > cosmetic.

## Summary

31 findings (W1–W31) and 22 one-line items from thirteen phases of developer work. What holds up: every value that went
through a call form came back exact (all integer widths and signs, `bit`, `id` with checksum, arrays, nested structs, range
checks with clear messages), the ledger product's numbers matched paper answers at every step, a procedure that never
returns is timed out and the engine recovers, 100 edit-build-call rounds ran with flat memory and no failure, and the
production build behaves like the dev server. What does not: the IDE reports success for things that did not happen, shows
stale results as fresh, and accepts contracts and layouts the CLI refuses.

| # | Severity | One line |
|---|---|---|
| **W16** | silently accepts what the build rejects | `/`, `%`, plain arrays, `#include`, local variables and an empty file all deploy green; `qinit build` refuses each |
| **W23** | silent wrong state | a changed `StateData` layout is deployed over live state, old bytes read as new fields; the CLI refuses |
| **W12** | silent wrong state report | from the 65th call of a session every result block is the 64th call's; tx explorer rows go blank |
| **W8** | silent no-op shown as success | a call paid above the balance shows "applied ✓" and the previous call's result |
| **W18** | silent wrong value | in a TS test the typed call form sends 0 qu; the form that works is a red squiggle |
| **W25** | wrong result | scenario asserts on any multi-field output always fail with "got undefined" |
| **W31** | silent wrong contract | `a/Thing.h` and `b/Thing.h` are one contract; the open file is not the code that runs |
| **W26** | lost work | two tabs on one project overwrite each other silently |
| **W6** | lost work (session) | running a test file wipes the interactive chain with no notice |
| **W27** | lost work | text typed in the 400 ms before a reload is lost |
| **W28** | lost-work risk | palette "New file…" creates a second `Counter.h` and unchecked paths |
| **W19**, **W22**, **W20** | false green | `toBe(5)` on `5n` passes; a test file with a syntax error passes; `confirmed: true` for a call that never ran |
| **W1** | hang with an unhelpful message | one failed `CC_ASSERT` kills the engine; only "↺ reset" recovers and nothing says so |
| **W3** | missing diagnostic | `CC_PRINT` output is shown nowhere |
| **W5** | wrong diagnostic | a procedure that calls another contract shows the callee's frame as its result |
| **W24** | wrong diagnostic | "0 compile problem(s)" for a missing callee or a cycle; a callee's error pinned on the caller's file |
| **W13**, **W14** | wrong behaviour | "⤓ epoch" stops one tick short; on that tick every procedure fails with "tick 41 is outside 41..40" |
| **W15** | missing diagnostic | the contract's own qu balance is shown nowhere |
| **W17**, **W11** | weak diagnostic | compile messages with wrong column / internal names / "clang" label; function results without field names |
| **W21** | hang | a test with an endless loop freezes the tab for good |
| **W2**, **W9**, **W30** | crash dialog | time buttons after a fault; faucet `1.5`; a harmless editor cancellation |
| **W10** | silent acceptance | "value" takes `abc` as 0, `1e3`, `0x10` |
| **W4** | shipped input rejected | examples `Bank.h` and `Token.h` do not build |
| **W29**, **W7** | wrong default / hint | every new file is a C++ contract; a test file is treated as an undeployed contract |


## Findings

### W1 — one failed `CC_ASSERT` leaves the engine dead: every later call and even Compile & Run fail with a raw abort code, and nothing says "reset"

Repro (`p0c.ts`, `p0d.ts`): gallery → "dev ▸" project → `Cheats.h` (shipped, untouched) → ▶ Compile & Run → CALLS →
`Add` → Run with the field left blank (the default; blank means 0, and the contract has `CC_ASSERT(input.amount > 0)` on
line 28).

```
› Add failed: engine faulted: abort(3422552092)
```

From then on, with valid input and on read-only functions too:

```
› Total failed: virtual node faulted: abort(3422552092)
› Add failed: virtual node faulted: abort(3422552092)          (amount = 5)
› compiling Cheats (slot 28)…
› deploy failed: virtual node faulted: abort(3422552092)       (▶ Compile & Run)
```

Only "↺ reset" clears it (`Cheats.Total() → "0"` afterwards). Meanwhile the footer keeps saying `● deployed … ✓ no errors`,
STATE keeps showing the last values, the engine log (`⊟ log`, "all") has no fault row, and no toast was on the page 300 ms
after the fault.

Expected: the docs (`cheatcodes.md`) say a failed assert in a procedure "aborts with the source line" and "halts the local
node". Halting is design. What is missing is everything a developer needs to get out of it: the message is the decimal
abort code (`3422552092` = `0xCC00001C`, line 28) with no file or line, no word that the chain is halted, and no pointer to
"↺ reset". Compile & Run, the button a developer presses after fixing the contract, fails with the same code, so the fixed
contract cannot be deployed until they find reset.

Control: `Add` with `5` on a fresh chain → `applied ✓ @ tick 2`, `Δ total: 0 → 5`.
Severity: **crash/hang with a message that does not help**, reached by the default input of a shipped example.
Attribution: IDE. `engine.ts:183` (`assertOperational`) rethrows the stored fault text for every method; `Ide.tsx` never
turns `EngineFaultInfo` (abort code → `CC_ASSERT` + line) into text, and the `faultInfo` engine method has no caller.
Fixed in Qinit-web `3cde260` (wording shared in Qinit `cf25ce1c`): the fault is one line naming contract, entry, file and line (`Cheats.Add halted the chain at tick 4: CC_ASSERT failed at Cheats.h:28 (abort(0xCC00001C))`), shown in the console, a banner and the footer (`● halted`); ▶ Compile & Run on a halted chain resets it first, leaving the faulting contract's old build off it.

### W2 — after a fault, "⏭ +1", "+10", "⤓ epoch", "+Fund" and "↻ replay" throw uncaught errors; the first one opens the "Unexpected error" crash dialog

Repro (`p0d.ts`): reach the faulted state of W1, then press each button.

```
after "⏭ +1":  crash dialog "Unexpected error" — Error: virtual node faulted: abort(3422552092)
[pageerror] virtual node faulted … at IdeEngine.step (engine.ts:223) at stepTicks (Ide.tsx)
[pageerror] … at IdeEngine.advanceEpoch (engine.ts:239) at advanceEpoch
[pageerror] … at IdeEngine.fundAccount (engine.ts:243) at fundFromFaucet
[pageerror] … at IdeEngine.replay (engine.ts:266) at replayChain
```

The crash dialog shows once (it dedupes); the other four presses do nothing visible and leave an uncaught error in the
browser console. Expected: the same console line the call buttons give (`… failed: …`), or disabled buttons.
Control: the call buttons in the same state write `Add failed: …` to the CONSOLE and do not crash.
Severity: crash with a message (the "report a crash" dialog for an ordinary contract assert).
Attribution: IDE, `Ide.tsx` `stepTicks` / `advanceEpoch` / `replayChain` / `fundFromFaucet` have no `try/catch`.
Fixed in Qinit-web `3cde260`: every engine button runs through one guarded wrapper and prints `… failed: the chain is halted. Press ↺ reset or ▶ Compile & Run to restart it.`.

### W3 — `CC_PRINT` output is shown nowhere

Repro (`p0d.ts`): `Cheats.h` (shipped) → Compile & Run → `Add` with `5` → `Total`. The contract prints `"adding", 5`,
`"total is now", 5` and `"reading", 5`.

None of the three lines appears in the call row, the CONSOLE, the step debugger (`HOST EVENTS —`, `LOGS —`), the tx explorer,
or the engine log with the "all" filter. The row is:

```
→ applied ✓ @ tick 2 · caller SINUBY…XHUN · in 5 · out {} · Δ total: 0 → 5
```

Expected: the example's own header says "CC_PRINT … its output shows in the trace pane", and `cheatcodes.md` documents
`CC_PRINT` as the first debugging tool. The engine does collect the lines (`TxDetail.prints`, `DebugStep.prints` in
`engine-core.ts`); no component renders them.
Control: `LOG_INFO` in `Counter.h` does show (`log INFO CounterLog·CounterIncremented {…}`).
Severity: **missing diagnostic** — the main cheatcode is silent in the IDE.
Attribution: IDE (`Ide.tsx` CallRow, `Debugger.tsx`, `TxExplorer.tsx` never read `prints`).
Fixed in Qinit-web `3cde260`: prints of every frame are merged in run order and shown as `print` lines in the call row, the console and a PRINTS group in the debugger.

### W4 — two shipped examples, `Bank.h` and `Token.h`, do not build

Repro (`p0b.ts`): "dev ▸" project → open `Bank.h` → ▶ Compile & Run (same for `Token.h`).

```
› ✗ Bank: 2 compile problem(s) — see the editor
› error Bank.h:50:18 — __qinit_log_info payload must open with a 4-byte word reserved for the contract index
› error Bank.h:59:18 — __qinit_log_info payload must open with a 4-byte word reserved for the contract index
› ✗ Token: 3 compile problem(s) — see the editor      (Token.h:77:18, 98:18, 117:18, same text)
```

The examples' log structs (`MoveLog { id account; uint64 amount; sint8 _terminator; }`) have no `_contractIndex` / `_type`
header, which the compiler now requires; `Bank.h`'s own comment still teaches "a QPI log message is any struct ending in
`sint8 _terminator`". The other six examples build (Counter, Adder, Proxy, Shares, Equity, Cheats).
Second defect in the same output: the message names the internal `__qinit_log_info`, not the `LOG_INFO` the developer wrote,
and does not say which field is missing.
Severity: loud rejection of shipped input (only reachable through the hidden "dev ▸" corner, so low reach); wrong
diagnostic wording for anyone who writes a log struct without the header.
Attribution: `ide/examples.ts` (stale examples); compiler message text.
Fixed in Qinit-web `4765c0a`: both log structs carry `_contractIndex` / `_type`; a test builds every shipped example through the build gate.

### W5 — a procedure that calls another contract reports the callee's frame as its own result

Repro (`p0e.ts`): "dev ▸" project → `Proxy.h` → Compile & Run → `BumpCounter` → Run, signed by acct 0 (`SINUBY…XHUN`).

```
→ applied ✓ @ tick 2
caller DBAAAA…HQAH                      ← Proxy's own contract id, not the account that signed
in {} · out {}
Δ counter: 0 → 1                        ← Counter's state, shown without a contract name
log INFO CounterLog·CounterIncremented {"_contractIndex":28,"_type":1,"value":"1"}
```

Proxy's own change is missing: STATE shows `bumps 1`, but the row and the CONSOLE have no `Δ bumps: 0 → 1`, and the
`invokeProcedure → @28 proc #1` host call is not listed either. The step debugger has both frames, in completion order:
step 1 `Counter.procedure #1` (caller = Proxy), step 2 `Proxy.procedure #1` (caller `SINUBY…`, `bumps 0 → 1`, host event
`invokeProcedure → @28 proc #1 reward=0`). The row and console summarise step 1.
Expected: the summary of a call is the frame the developer invoked (the last step, or all steps labelled by contract).
Control: `Counter.Inc` called directly shows `caller SINUBY…XHUN` and its own diff.
Severity: **wrong diagnostic** (wrong caller, another contract's diff under this procedure's name).
Attribution: IDE, the detail picked for the row is the first trace step (`engine-core.ts` `traceOf` / detail assembly).
Fixed in Qinit-web `3cde260`: the summary is the frame the developer invoked (slot, kind, entry); callee frames are listed beneath it with their own diff and logs.

### W6 — running a test file wipes the interactive chain with no notice

Repro (`p0e.ts`): "dev ▸" project → build `Proxy.h`, call `BumpCounter` once and `Counter.Inc` four times
(`Counter` STATE `counter 5`, Proxy `bumps 1`, `≡ txs 5`) → open `Counter.test.ts` → ▶ Run tests (`✓ 2/2 passed`) → back to
`Counter.h`.

```
Counter STATE after tests: counter 2        (was 5 — this is what the tests left behind)
Proxy STATE after tests:   bumps 0          (was 1)
≡ txs 7                                     (the 5 interactive txs stay listed beside the 2 test txs)
```

Nothing on the page says the chain was reset: no console line, no toast, and the tx explorer keeps listing the five
transactions whose effects no longer exist. The starter test's comment does say "the chain is one fresh node for the file",
which explains the reset but not that the developer's own session is the chain being replaced.
Expected: a visible "chain reset for the test run" line, or tests on a separate chain.
Severity: **lost work (session state) without notice**.
Attribution: IDE, `tests/runner.ts` resets the one shared engine; `Ide.tsx` `runTestFile` only refreshes the views.
Fixed in Qinit-web `52818f0`: a test or scenario run prints `chain reset to genesis for the test run — earlier calls and state are gone …` and clears the tx list and call results; one chain is kept, as decided.

### W7 — with a `.ts` test file active, the engine panel and footer treat it as an undeployed C++ contract

Repro (`p0a.ts`): new project → Compile & Run → open `Counter.test.ts`.

```
Counter.test isn't deployed yet — hit ▶ Compile & Run to deploy this contract.     (engine panel)
● deployed   Counter.test   C++ · qpi.h                                            (footer)
```

There is no Compile & Run button in this state (the top button is "▶ Run tests"), and STATE / CALLS for `Counter` disappear
while the test file is active, so the developer cannot see the contract the test is about to drive.
Severity: cosmetic / misleading hint.
Attribution: IDE, the panel derives a contract name from any active file (`workspace.ts` `baseName`).
Fixed in Qinit-web `4765c0a`: a file's kind comes from its extension; with a test file open the panel keeps the last contract, and the footer names the file and `TypeScript · bun:test`.

### W8 — a procedure paid with more than the signer's balance shows "applied ✓" and the previous call's result; nothing ran

Repro (`p1d.ts`, contract `products/zoo/Zoo.h`): build `Zoo.h` → `Store` with every field set (u8 = 255 …) → Run. Then
`Store` again with `u8 = 9`, all else blank, and `value` = `2000000000000` (acct 0 holds 1,000,000,000,000).

```
→ applied ✓ @ tick 3
in {u8: 255, u16: 65535, …}            ← the FIRST call's input, not the one just sent (u8: 9)
out 1
Δ u8: 0 → 255                          ← the first call's diff again
…
› Store() processed @ tick 3
› Zoo.Store() from acct SINUBY…XHUN · 2000000000000 qus → applied @ tick 3
```

STATE still says `u8 255` and the balance is still `1,000,000,000,000`: the procedure never ran and no money moved. The only
trace of that is a missing word: a paying call that works ends its first line with `· moneyFlew` (see the control), this one
does not.
Expected: "not executed: balance too low" (or any failure line), and no result block.
Control: `Store` `u8 = 7`, `value 5` → `applied ✓ @ tick 4 · moneyFlew`, `Δ u8: 255 → 7`, balance `999,999,999,995`.
Severity: **silent no-op reported as success**, made worse by a stale result block that looks like a full execution. Same
family as CLI finding F55.
Attribution: IDE. `Ide.tsx` `runProcedure` clears `outputs[key]` but not `txDetail[key]` (`runFunction` clears both), and
the "applied ✓" line is printed for any included transaction, whether or not the procedure executed.
Fixed in Qinit-web `3cde260`: a call is `applied ✓` only when its own frame is in the trace, else `not executed`; the row's old detail is always cleared; a value above the signer's balance is refused before sending.

### W9 — the faucet field: `1.5` opens the crash dialog, bad input is ignored without a word, and there is no upper bound

Repro (`p1d.ts`): ACCOUNTS → type into "faucet" → "+Fund".

| Typed | Result |
|---|---|
| `1000` | `faucet → SINUBY…XHUN +1,000 qus`, balance up by 1,000 (control) |
| `1.5` | "Unexpected error" crash dialog; `RangeError: The number 1.5 cannot be converted to a BigInt because it is not an integer` |
| `-5`, `abc`, empty | nothing happens, no message |
| `1e3` | funds 1,000 |
| `9007199254740993` | funds `+9,007,199,254,740,992` (one less than typed) |
| `99999999999999999999999` | funds `+100,000,000,000,000,000,000,000`; balance shows `100,000,009,008,199,250,000,000` |

The last row leaves an account balance far above the signed 64-bit range Qubic balances live in (max 9.2e18), and the
balance readout is rounded through a float (`…250,000,000`).
Severity: crash dialog on a typo; silent ignore; an impossible balance.
Attribution: IDE, `Ide.tsx` `fundFromFaucet` (`BigInt(Number(text))`, no validation, no `try/catch`).
Fixed in Qinit-web `3cde260`: one strict parser for qu (digits only, capped at the node's `MAX_AMOUNT`), a console line for bad input, balances formatted from `BigInt`.

### W10 — the procedure "value" field takes `abc` as 0, accepts `1e3` and `0x10`, and reports a number the developer did not type

Repro (`p1c.ts`): CALLS → `Store` → type into "value" → Run.

| Typed | Result |
|---|---|
| `100` | `· 100 qus → applied`, balance down by 100 (control) |
| `abc` | `applied ✓`, sent with 0 qus, no complaint |
| `1e3` | sent with 1,000 qus |
| `0x10` | sent with 16 qus |
| `-5` | `Store failed: invalid amount: -5 (must be 0..2^63-1)` |
| `1.5` | `Store failed: invalid amount: 1.5 (must be a whole number below 2^53, or a bigint)` |
| `9007199254740993` | `Store failed: invalid amount: 9007199254740992 (must be a whole number below 2^53, or a bigint)` |

The input fields of the same form refuse `1e3`, `0x10` and `abc` (`uint64 must be an integer`), so the two kinds of field on
one row disagree. An amount at or above 2^53 cannot be sent from the IDE at all, the message quotes a different number from
the one typed, and "or a bigint" means nothing to someone typing into a text box.
Severity: silent acceptance of garbage as 0 on the money field. Same family as CLI finding F51 (fixed in the CLI).
Attribution: IDE, `Ide.tsx` CallRow `onRun(vals, Number(value) || 0)`.
Fixed in Qinit-web `3cde260`: the same parser as W9: `abc`, `1e3`, `0x10`, `1.5` and `-5` are refused with `value must be a whole number of qu (got '…')`.

### W11 — a function's result is a positional array with no field names, and `null` for an empty output

Repro (`p1b.ts`, `p1c.ts`): `Zoo.h` → `EchoU` with the four maxima; `EchoNest`; `One`; `Nothing`.

```
EchoU    → [255,65535,4294967295,"18446744073709551615"]
EchoNest → [[7,"-8"],[[1,"-2"],[3,"-4"]],"99"]
One      → "42"
Nothing  → null
```

The fields are `u8, u16, u32, u64`; the row gives no names, 64-bit values are quoted and narrower ones are not, a nested
struct is an array inside an array, and an empty output is `null`. The detail block two lines below has the named form
(`out {p: {a: 7, b: -8}, ps: [{a: 1, b: -2}, {a: 3, b: -4}], tail: 99}`), and a procedure's result uses the named form
only. With eight `uint64` outputs the developer has to count commas.
Expected: the named form as the headline result.
Control: the values themselves are exact for every width, both signs, `bit`, `id`, arrays and nested structs (see coverage).
Severity: missing diagnostic (readability), no wrong value.
Attribution: IDE, `Ide.tsx` `formatOut` over `decodeAbi`'s positional result.
Fixed in Qinit-web `3cde260`: the result line names every field at every depth (`→ {p: {a: 7, b: -8}, ps: […], tail: 99}`), `{}` for an empty output.

### W12 — from the 65th traced call of a session, every result block is the 64th call's, and the tx explorer rows go blank

Repro (`p5c.ts`): new project (starter `Counter.h`) → Compile & Run → `Inc` → Run, 75 times.

```
Inc #64: → applied ✓ @ tick 64 · Δ counter: 63 → 64 · log … "value":"64"
Inc #65: → applied ✓ @ tick 65 · Δ counter: 63 → 64 · log … "value":"64"      ← stale
Inc #75: → applied ✓ @ tick 75 · Δ counter: 63 → 64 · log … "value":"64"      ← stale
Get:     → "75"                                                               (no "step debug", no in/out lines)
tx explorer: 75 rows; rows 65–75 read "Counter.Inc | — | no flow" (no caller, no Δ, no 🐞)
```

STATE is right (`counter 75`); only the reporting is wrong. The first line of the row keeps moving (`@ tick 65 … 75`), so the
block reads as fresh.
Expected: each call's own diff and log, for the whole session.
Control: calls 1–64 are each correct.
Severity: **silent wrong state report** — after 64 calls every diff and log the developer reads belongs to an older call.
Attribution: IDE. `engine-core.ts` asks `engine.debugTrace()` with its default limit of 64 entries and slices from a running
base index; once 64 entries exist the slice is empty, so no new detail arrives, and the stale-detail defect of W8 keeps the
old one on screen.
Fixed in Qinit-web `3cde260`: a call's frames are read by trace sequence number, not array position; tracing is on from the first tick.

### W13 — "⤓ epoch" stops one tick short: no `END_EPOCH`, epoch number unchanged

Repro (`p5b.ts`, contract `products/ledger/Ledger.h`, which counts `END_TICK` and `END_EPOCH`): set "ticks/epoch" to 20 →
↺ reset → ⏸ pause → ⤓ epoch. The button's tooltip reads "Jump to tick 20 (the next epoch boundary) — fires END_EPOCH →
BEGIN_EPOCH".

```
before:        tick 1  · epoch 0 · 1/20 · epochs 0
⤓ epoch:       tick 20 · epoch 0 · 0/20 · epochs 0      ← no END_EPOCH; bar already wrapped to 0/20
⏭ +1:          tick 21 · epoch 1 · 1/20 · epochs 1      ← engine log: "t21 epoch 0 → 1"
```

A second press of ⤓ epoch (instead of +1) goes to tick 40 with `epoch 1`, `epochs 1`: always one boundary behind.
Expected: one press ends the epoch, as the tooltip says and as `qinit epoch advance` does.
Severity: wrong behaviour against the control's own label; a developer testing an `END_EPOCH` hook sees nothing happen.
Attribution: IDE / engine glue (`engine-core.ts` `advanceEpoch` target tick).
Fixed in Qinit-web `3cde260`: the button calls the engine's own epoch advance, which crosses the boundary; the progress bar reads the node's epoch bounds (the panel also assumed 3000 ticks while the engine default is 2701).

### W14 — on the tick "⤓ epoch" lands on, every procedure fails with "transaction tick 41 is outside 41..40"

Repro (`p5b.ts`): as W13, paused, press ⤓ epoch, then `Deposit` → Run.

```
› Deposit failed: transaction tick 41 is outside 41..40
```

The allowed window printed is empty (41..40). The call works again after one more tick (⏭ +1, or the running ticker within a
second), so it bites exactly the developer who paused to inspect the epoch boundary. The row keeps the previous call's
result block (W8).
Expected: the transaction is scheduled for the first tick of the next epoch, or the message says "advance one tick first".
Control: the same `Deposit` at any other paused tick → `applied ✓ @ tick N+1`.
Severity: loud rejection of legal input with a message that cannot be acted on.
Attribution: engine scheduling window at the epoch's last tick, surfaced verbatim by the IDE.
Fixed in Qinit `65c25fc1`: the refusal reads `transaction tick N cannot be scheduled: epoch E ends at tick T; advance into the next epoch first`; with W13 fixed the epoch button no longer lands on such a tick.

### W15 — the contract's own qu balance is shown nowhere

Repro (`p2a.ts`): `Ledger.h`, deposits of 1000 and 500, a withdrawal of 200. The contract now holds 1300 qu.
DEPLOYED shows `Ledger · slot 28 · CBAAAA…RUCN`; STATE, ASSETS, the tx explorer and the debugger never show `1300`, and
ACCOUNTS only looks up the three dev accounts (the address in DEPLOYED is shortened and has no copy button, so it cannot be
looked up either). A contract that keeps or loses money by mistake is invisible in the IDE.
Expected: the balance beside the contract in DEPLOYED (the CLI prints `address` and `balance` on deploy, call and state
since F72).
Severity: missing diagnostic on the money path.
Attribution: IDE (`balanceOf` is only called for the selected dev account).
Fixed in Qinit-web `3cde260`: each DEPLOYED row shows the contract's balance and a copy button for its full address.

### W16 — the IDE deploys contracts that `qinit build` refuses: `/`, `%`, plain arrays, `#include`, local variables, and an empty file

Repro (`p3a.ts`, `p3b.ts`): new project → edit the starter `Counter.h` as in the table → ▶ Compile & Run.
Oracle: the same edit in a `qinit new counter` project, `qinit build` and `qinit verify` (CLI 0.1.17, default TypeScript
compiler — the same compiler the IDE runs).

| Edit | IDE editor | IDE Compile & Run | `qinit build` / `verify` |
|---|---|---|---|
| `counter = state.get().counter / 2;` | ⚠ "The `/` operator is forbidden … Use `div(a, b)`" | `● deployed`, `✓ no errors` | exit 1, "Division operator `/` is not allowed" |
| `… % 2;` | ⚠ "The `%` operator is forbidden" | deployed | exit 1 |
| `uint64 raw[4];` in `StateData` | ⚠ ×2 "`[` is forbidden" | deployed | exit 1, "Plain arrays are not allowed" |
| `#include <vector>` on line 1 | ⓘ info only, counts `⊘ 0 ⚠ 0` | deployed | exit 1, "Preprocessor directives (character `#`) are not allowed" |
| `uint64 tmp = 1;` in a procedure body | ⚠ "Stack-local `tmp` is forbidden in QPI" | deployed | exit 1, "Local variables are not allowed" |
| file emptied | "no problems detected" | deployed, `4107 B` | exit 1, "a contract declares `struct Name : public ContractBase`" |
| `state.mut()` inside a function (control) | ⊘ ×2 | `● error` | — |

The editor's own text says "forbidden", but the marker is a warning (or info), the footer says `✓ no errors`, and the
contract deploys and runs. A developer who iterates in the IDE ends with a contract that the CLI build, `qinit integrate`
and Core all reject; for `#include` there is not even a warning count to notice.
Expected: Compile & Run refuses what `qinit build` refuses (the protocol-rule check), with the same messages.
Severity: **the IDE silently accepts what the build rejects** — the top rung for an editor.
Attribution: IDE. `compile/worker.ts` runs the compiler without the protocol-rule gate that `qinit build` applies, and
`qpi/markers.ts` files those rules as warning/info.
Fixed in Qinit `cf25ce1c`, Qinit-web `4765c0a`: the compile worker applies the verifier's rules (`VERIFIER_RULES`, each one proven against the native tool by a test) and the CLI's build gate, a file with no contract struct is refused with the CLI's sentence, and the editor marks the same rules as errors.

### W17 — compile messages: wrong column, internal spellings, a `0:0` location, and the source label "clang"

Repro (`p3a.ts`): starter `Counter.h` with one edit each.

| Edit | Message | Problem |
|---|---|---|
| `state.mut().countr += 1;` | `Counter.h:32:1 — unsupported assignment target [state.mut(0).countr]` | column 1, not the member; does not say `countr` is not a member; prints the internal `state.mut(0)` |
| `const char* s = "hi";` | `Counter.h:34:1 — unsupported reference initializer for 's'` | column 1; nothing about string literals |
| `REGISTER_USER_FUNCTION(Get, 1);` twice | `Counter.h:0:0 — function input type 1 is registered twice ('Get' and 'Get')` | no location (line 0) |
| `uint65 counter;` / `float ratio;` | `Codegen failed: unknown type 'uint65'` | "Codegen failed" is an internal stage name |
| log struct without the header word (W4) | `__qinit_log_info payload must open with a 4-byte word reserved for the contract index` | internal macro name |

Every compiler row in the PROBLEMS panel is labelled `clang · line:col`, though the compiler is the TypeScript one (the
second bar says `TS-QPI v0.1.0`).
Control: a missing semicolon gives `Counter.h:14:5 — Expected semicolon but got r_brace (}) in variable`, right line.
Severity: wrong or weak diagnostic.
Attribution: compiler message text and spans (Qinit `packages/compiler`); the "clang" label is the IDE's (`Ide.tsx`, marker
owner/source).
Fixed in Qinit `08444de8`, Qinit-web `4765c0a`: the two messages carry their own span, a duplicate registration points at its line, an error with a span drops the `Codegen failed:` prefix, log messages say `LOG_INFO`; markers are labelled `qinit` and cover the word.

### W18 — in a TS test, the call form the editor accepts for a paid empty-input procedure sends 0 qu; the form that works is underlined as an error

Repro (`p4b.ts`, `p4c.ts`, contract `Ledger.h`, `Deposit` has an empty input struct):

```ts
const r = await l.Deposit({ amount: 1000 });        // editor: no error
// → {"ok":true,"tick":1,"confirmed":true,"included":true}; Stats: totalDeposited 0, depositCount 1

const r = await l.Deposit({}, { amount: 1000 });    // editor: ⊘ "Expected 0-1 arguments, but got 2. (2554)"
// → totalDeposited 1000, test passes
```

The generated typings (`./.qinit`) declare an empty-input procedure as `(options?)`; the in-page runner always reads the
first argument as the input and the second as the options. So the typed form runs the procedure with amount 0 and reports
success, and the working form carries a red squiggle.
Expected: runner and typings agree (the CLI's generated client is what the typings describe).
Severity: **silent wrong value** (a paid call sent with 0) plus an editor error on correct code.
Attribution: IDE, `tests/runner.ts` argument handling vs `tests/dts.ts`.
Fixed in Qinit-web `52818f0`: the runner and the typings both follow the CLI's generated client: an empty-input procedure takes `Name(opts)` and `Name({}, opts)`.

### W19 — `expect(5n).toBe(5)` passes in the IDE and fails under `bun test`

Repro (`p4a.ts`): `expect((await l.Stats()).totalDeposited).toBe(5)` after a deposit of 5 → `✓ 1/1 passed`.
Oracle: `bun test` on `expect(5n).toBe(5)` → `(fail)`, `Expected: 5 Received: 5n`.
The starter test's first line promises "the SAME test the qinit CLI runs under `bun test`"; a suite written with number
literals is green here and red in the CLI.
Severity: wrong result (false green). Attribution: IDE, `tests/runner.ts` `toBe` compares through `BigInt`.
Fixed in Qinit-web `52818f0`: `toBe` is `Object.is`, `toEqual` does not equate a bigint with a number.

### W20 — a test cannot tell that a procedure did not run: `ok: true, confirmed: true` for a call paid above the balance

Repro (`p4a.ts`): `const r = await l.Deposit({}, { amount: 2000000000000 })` (balance is 1,000,000,000,000).

```
{"ok":true,"tick":1,"confirmed":true,"included":true}        Stats.depositCount stays 0
```

The typings also declare `txId` and `moneyFlew` on the result; neither exists at run time (`expect(r.txId).toBeTruthy()` →
"expected undefined to be truthy"), so the one field that would reveal the no-op is missing.
Severity: silent no-op reported as success (test-side twin of W8). Attribution: IDE, `tests/runner.ts` result shape vs
`tests/dts.ts:274`.
Fixed in Qinit-web `52818f0`: the result carries the transaction's own `txId`, `included` and `moneyFlew`.

### W21 — a test with an endless loop freezes the tab for good

Repro (`p4c.ts`): `test("spins", async () => { while (true) {} });` → ▶ Run tests. The page stops answering (checked at 3,
10, 30 and 60 s); there is no timeout and no stop button, the only way out is to kill the tab.
Control: the same loop inside a contract procedure is handled — "Inc failed: virtual node submitProcedure timed out after
60000ms; worker restarted", and the next call works (`p3c.ts`).
Severity: hang with no message. Attribution: IDE, `tests/runner.ts` runs the test on the page thread.
Fixed in Qinit-web `52818f0`: the test body runs in a worker; a file is cut off after 60 s and the panel has a stop button.

### W22 — a test file with a syntax error runs and passes

Repro (`p4a.ts`): `test("broken", async () => { expect(1).toBe(1) ` (file ends there). Editor: `⊘ 1`. ▶ Run tests →
`✓ 1/1 passed`. `bun test` refuses the file.
Severity: wrong result (false green). Attribution: IDE, `tests/runner.ts` transpiles without checking syntax diagnostics.
Fixed in Qinit-web `52818f0`: a syntax error fails the file: `syntax error — line N: …`.

### W23 — a changed `StateData` layout is deployed over the live state with no warning; the old bytes are read as the new fields

Repro (`p6a.ts`): starter → Compile & Run → `Inc` ×3 (`counter 3`) → add `uint64 extra;` **before** `counter` in `StateData`
→ ▶ Compile & Run.

```
› deployed Counter → slot 28 · 4418 B · CBAAAA…RUCN
STATE: extra 3 · counter 0            Get → "0"
```

The developer's counter is now in `extra`. No warning, no reset, no mention of `MIGRATE`. Restoring the old layout brings
`counter 3` back, so the bytes are simply reinterpreted.
Oracle: the CLI refuses this deploy ("state layout changed — was 8 B (uint64), now 16 B (uint64, uint64) …", docs
`migrate-state.md`) unless `--allow-state-carryover` is passed.
Control: rebuilding the unchanged source keeps `counter 3`, which is correct carry-over.
Severity: **silent wrong state**. Attribution: IDE deploy path (`Ide.tsx` `runCompile` → `engine.deploy`), which lacks the
CLI's layout check.
Fixed in Qinit `cf25ce1c`, Qinit-web `4765c0a`: the CLI's layout check runs before a deploy over live state; a refusal shows the CLI's sentence and a `↺ Reset chain and deploy` button; a `MIGRATE` handler that fits runs as before.

### W24 — cross-contract build failures: the red panel says "0 compile problem(s)", and a callee's error is pinned on the caller's file

Repro (`p7a.ts`): project with `Counter.h` and `Caller.h` (calls `Counter`).

| Case | CONSOLE | Red panel in ENGINE | PROBLEMS of the open file |
|---|---|---|---|
| `Caller.h` names a contract with no file | `deploy failed: Caller calls 'Missing', but there's no Missing.h in this project` | `0 compile problem(s) — see the editor.` | `⊘ 1` |
| `Counter` ↔ `Caller` call each other | `deploy failed: circular inter-contract calls involving Counter` | `0 compile problem(s) — see the editor.` | — |
| `Counter.h` has an error, build started from `Caller.h` | `error Counter.h:32:1 — unsupported assignment target …` (right file) | `0 compile problem(s) — see the editor.` | the error is listed under **Caller.h** at `32:1`, a line of `Caller.h` that has nothing wrong |

Expected: the red panel repeats the console's reason; a callee's error is shown on the callee's file.
Control: `Caller → Counter` with both files clean deploys Counter at slot 28, Caller at 29, and `Bump` / `Read` work.
Severity: wrong diagnostic (wrong file, wrong text). Attribution: IDE, `Ide.tsx` red panel text (`result.error ?? "N
compile problem(s)"`) and marker placement on the active model; `compile/worker.ts` returns a callee's diagnostics as the
main ones.
Fixed in Qinit-web `4765c0a`: the red panel repeats the console's reason; a callee's diagnostics carry the callee's file and are marked there.

### W25 — scenario asserts on a function with more than one output field always fail with "got undefined"

Repro (`p8b.ts`, contract `Ledger.h`): two deposits and a transfer → "+ capture session" → add asserts → ▶ run.

```
Ledger test 1 · 3 calls · 7 asserts · ✗ 0/7
expect Stats().totalDeposited == 1500      ✗ got undefined       (true value 1500)
expect Stats().depositCount == 2           ✗ got undefined
expect BalanceOf().balance == 800          ✗ got undefined       (true value 800)
expect BalanceOf().found == 1              ✗ got undefined
```

`Stats` has five output fields and `BalanceOf` two; every assert on them fails whatever the expectation. The replayed calls
themselves are right (the console shows the same diffs as the first run).
Control: on the starter, `Get().value == 1` (one output field) → `✓ 1/1` (`p9a.ts`).
Also: an expected value of `abc` is accepted by the form; the assert row does not show the function's input (`BalanceOf()`
with no `who`).
Severity: **wrong result** — the feature cannot check any multi-field function. Attribution: IDE, `Ide.tsx` scenario run
reads `res[a.field]` from a positional result.
Fixed in Qinit-web `3cde260`: asserts read the named output; a field that does not exist says so.

### W26 — the same project open in two tabs: the last tab to save overwrites the other, silently

Repro (`p9b.ts`): open one project in tabs A and B. Type `// from-tab-A` in A, wait for "saved"; type `// from-tab-B` in B.
Stored project afterwards: has B's line, not A's. Neither tab says anything, and A still shows its own text until reload.
Severity: **lost work**. Attribution: IDE, `projects/store.ts` saves the whole project from each tab's memory; nothing
listens to the `storage` event.
Fixed in Qinit-web `b4a2495`: a save from a copy older than the stored record is refused; a tab with no edits of its own takes the other tab's version, and a tab with edits gets a `Load theirs` / `Keep mine` banner.

### W27 — text typed in the last 400 ms before a reload or tab close is lost

Repro (`p9b.ts`): type a line, reload at once → the line is gone. Type, wait 0.7 s, reload → kept.
Autosave is debounced 400 ms and nothing flushes it on `beforeunload` / `pagehide`.
Severity: lost work (small window). Attribution: IDE, `Ide.tsx` autosave effect.
Fixed in Qinit-web `b4a2495`: pending edits are saved on `pagehide` and when the tab is hidden.

### W28 — command palette "New file…" creates a second `Counter.h` and takes any path

Repro (`p9c.ts`): Ctrl+Shift+P → "New file…" → answer the browser prompt with `Counter.h`; again with `bad name/../x`.

```
stored file names: [… "Counter.h", … "Counter.h", "bad name/../x.h"]
explorer: folders "bad name" and ".." appear; React warns "two children with the same key Counter.h"
```

The explorer's own "New file" button refuses the duplicate ("Counter.h" already exists) and cleans names. With two files of
one name the tab, the build and delete all pick by name, so which copy is edited or compiled is not defined.
Also: the prompt is a native `window.prompt`, and the gallery uses native `confirm` / `alert` for delete and import errors.
Severity: lost-work risk (two files, one name). Attribution: IDE, `Ide.tsx` palette `createFile` skips `normalizePath` and
the duplicate check.
Fixed in Qinit-web `4765c0a`, `b4a2495`: every way of naming a file uses one rule; the palette opens the explorer's own input; gallery delete and import errors use in-app dialogs.

### W29 — every new file starts as a C++ contract, and any non-`.ts` file is compiled as one

Repro (`p9c.ts`): explorer → New file → `helper.ts` → first line is `using namespace QPI;` (the contract template) in a
TypeScript file. New file → `notes.md` → same template, top button "▶ Compile & Run", footer "C++ · qpi.h"; with markdown
text in it: `⊘ 1`, and Compile & Run reports `error notes.h:3:21 — Expected semicolon …` (the file is `notes.md`; the
message says `notes.h`).
Severity: wrong diagnostic / wrong default. Attribution: IDE, `workspace.ts` `NEW_CONTRACT` for every extension;
`Ide.tsx` file-kind check (anything not `.ts`/`.cpp` is a contract).
Fixed in Qinit-web `4765c0a`: only `.h` / `.hpp` builds as a contract; a new `.ts` file starts as a test, any other file starts empty; messages use the real file name.

### W30 — the "Unexpected error" crash dialog opens for a harmless editor cancellation (intermittent)

Seen once in two runs of `p9c.ts`, while switching from one file to another right after select-all + copy in a `.ts` file:

```
Qinit crash report … [pageerror] Canceled: Canceled
    at Delayer.cancel … at Delayer.dispose … at _DisposableStore.dispose   (monaco-editor)
```

Monaco rejects a pending delayed task with `Canceled` when a model is switched; the IDE's global unhandled-rejection hook
treats it as a crash and covers the page with the report dialog. The second run of the same script did not hit it.
Severity: crash dialog for a non-error. Attribution: IDE, `crash.ts` does not filter Monaco's `Canceled`.
Fixed in Qinit-web `b4a2495`: the crash hook ignores Monaco's `Canceled` rejection (and the browser's resize-observer notice, found while checking the narrow layout).

### W31 — two files with the same name in different folders are one contract: the open file is not the code that runs

Repro (`p9e.ts`): `a/Thing.h` whose `Which` returns 1 → Compile & Run → `Which → "1"`. `b/Thing.h` whose `Which` returns 2 →
Compile & Run.

```
› deployed Thing → slot 30 …      (both times: same name, same slot)
DEPLOYED: … Thing · slot 30        (one row)
back on a/Thing.h:  Which → "2"    ← the open file returns 1
```

The contract name is the file stem without its folder, so the second build replaces the first, and the engine panel of
either file drives whichever was built last. Nothing warns about the clash.
Severity: **silent wrong contract**. Attribution: IDE, `workspace.ts` `baseName`.
Fixed in Qinit-web `4765c0a`: a second contract file of one stem is refused on create, rename and paste, and a build refuses a stem two files share, naming both.

## Small things (one line each)

| # | What | Script | Status (Qinit-web commit) |
|---|---|---|---|
| W-s1 | `/favicon.ico` → 404 on every page load (console error) | all | fixed, `b4a2495` (favicon) |
| W-s2 | React dev warning on each deploy: style `border` vs `borderLeftWidth` in `DeployedList` | `p0a` | fixed, `b4a2495` |
| W-s3 | engine panel hint says "byte-identical to the node, feeless, instant"; "feeless" is banned from user-facing copy | `p0a` | fixed, `b4a2495` |
| W-s4 | second bar and explorer root always say "my-contract", whatever the project is called | all | fixed, `b4a2495` |
| W-s5 | result line says `· moneyFlew` (internal word); the tx explorer says `moneyFlew` / `no flow` | `p1c`, `p2a` | fixed, `3cde260` ("qu moved") |
| W-s6 | `A`×60 is accepted as the zero identity although its checksum letters are wrong; other bad checksums are refused | `p1b` | by design: 60×`A` is the usual spelling of the null (burn) address, which `identityToBytes` accepts on purpose |
| W-s7 | `0` is refused for an `id` field (the CLI and the test runner accept `0`); blank means zero | `p1b` | fixed, `3cde260` |
| W-s8 | a wide integer inside an array must be quoted (`[1,2,3,"18446744073709551615"]`); the placeholder shows the unquoted form | `p1c` | fixed, `3cde260` |
| W-s9 | a zero struct or zero id is `0` in Δ lines (`Δ pair: 0 → {a: 5, b: -6}`) but `{a: 0, b: 0}` / 60 letters in STATE | `p1d` | by design: the shared diff renderer collapses an all-zero value to `0` on purpose (ten CLI tests pin it) |
| W-s10 | one diff labels the same map two ways: `balances.slot[6].value: 1000 → 700` and `balances[<id>]: 500 → 800` | `p2a` | fixed, `3cde260` (the IDE now passes the key reader) |
| W-s11 | "↺ reset" silently resumes ticking when the developer had paused | `p5a` | fixed, `3cde260` |
| W-s12 | "ticks/epoch" set to `0` or `-5` snaps back to the old value with no message; `1.5` becomes `1` | `p5a` | fixed, `3cde260` (console line) |
| W-s13 | "+ capture session" tooltip and hint say "run some procedures" but the button is enabled as soon as the contract is deployed | `p8a` | fixed, `52818f0` |
| W-s14 | the test runner has no `it`, `afterAll`, `.not`, `toThrow`, `console.info`; before a build it fails with "(runner) Ledger is not defined" instead of "Compile & Run first" | `p4a` | fixed, `52818f0` |
| W-s15 | an un-awaited rejected call in a test leaves an uncaught page error while the suite stays green | `p4a` | fixed, `52818f0` |
| W-s16 | during a 60 s stuck call every call button is disabled and there is no cancel | `p3c` | fixed, `3cde260` (■ stop after 2 s) and `30d6533` (the restart after a stop or a timeout replayed the session through the contract that hung: a minute's wait, then an empty node; it now falls back to genesis within seconds and says so) |
| W-s17 | renaming a deployed contract's file leaves the old name in DEPLOYED for the rest of the session; the new name deploys beside it | `p7b` | fixed, `4765c0a` |
| W-s18 | explorer names: spaces and non-ASCII letters are dropped without notice (`my token.h` → `mytoken.h`, `über.h` → `ber.h`) | `p9c` | fixed, `4765c0a` (notice) |
| W-s19 | import accepts `..` path segments, an empty name and duplicate names; a corrupt `ide.projects.index` shows "0 projects" with the records still in storage | `p9a`, `p9b` | fixed, `b4a2495` |
| W-s20 | a truncated `#p=` share link does nothing and says nothing; export of a non-ASCII project name is called `_.qinit.json` | `p9a`, `p9b` | fixed, `b4a2495` |
| W-s21 | search in regex mode with an invalid pattern (`(`) keeps the previous result count and reports no error | `p9c` | fixed, `b4a2495` |
| W-s22 | at 400 px width the editor has no visible lines and the top bar is cut off after "Compile & Run"; footer can read `● error` and `✓ no errors` together | `p9c` | fixed, `b4a2495` |

## Leads from reading the source, and how each ended

| Lead | Outcome |
|---|---|
| `CC_PRINT` output shown nowhere | confirmed, W3 |
| result blocks go empty after about 64 traced calls | confirmed, W12 (they go stale, not empty) |
| time buttons open the crash dialog after a fault | confirmed, W2 |
| faucet `1.5` crashes; no precision above 2^53; "value" takes anything | confirmed, W9, W10 |
| integer inputs have no range check | **withdrawn** — every width is range-checked with a clear message (`p1b`) |
| function output is positional; scenario asserts read `undefined` | confirmed, W11, W25 |
| endless loop in a test freezes the tab; typings promise `txId` / `moneyFlew`; `it` etc. missing | confirmed, W21, W20, W-s14 |
| palette "New file…" skips checks; every new file is a C++ contract | confirmed, W28, W29 |
| `README.md` / `notes.md` compiled as a contract | confirmed, W29 |
| same stem in two folders is one contract | confirmed, W31 |
| renaming a deployed contract leaves the old DEPLOYED row | confirmed, W-s17 |
| a callee's errors show as the caller's | confirmed, W24 |
| markers land on the wrong file when switching mid-build | not reached (needs a build slow enough to switch during) |
| "0 compile problem(s)" for a missing callee or cycle | confirmed, W24 |
| a typed call draft carries over between contracts | **withdrawn** — the form is empty after switching (`p9e`) |
| capture-session tooltip mismatch | confirmed, W-s13 |
| import accepts unchecked paths | confirmed, W-s19 |
| deleting down to a `.keep` placeholder | not reached |
| "clang" label, footer "C++ · qpi.h" on a `.ts` file, "my-contract", Ctrl+W | confirmed (W17, W7, W-s4); Ctrl+W not checked |

## Coverage

| Phase | Result |
|---|---|
| P0 first contact | exercised: starter loop and shipped test pass; 6 of 8 shipped examples build (W4); W1–W7 |
| P1 type zoo | exercised: 70+ input rows, all values exact; W8–W11 |
| P2 ledger product | exercised: 6 steps, every figure equal to the paper answer; W15 |
| P3 faults | exercised: 18 broken variants against `qinit build` / `verify`; endless loop in a procedure handled; states of 128 MiB and 1 GiB deploy (15 s for 1 GiB); W16, W17 |
| P4 TS tests | exercised: 17 test files; W18–W22 |
| P5 time and lifecycle | exercised: pause, +1, +10, speed, ticks/epoch, reset, replay, 75 calls, 25 calls at 10×; W12–W14 |
| P6 upgrade | exercised: same source, new field, removed entry, renamed procedure; `MIGRATE` not exercised; W23 |
| P7 two contracts | exercised: call and invoke, missing callee, cycle, callee error, rename, same stem; W5, W24, W31 |
| P8 scenarios | exercised: capture, asserts, run, persistence across reload; W25 |
| P9 IDE shell | exercised: gallery, rename, export, import (good, broken, hostile), share link, unknown id, reload, two tabs, corrupt storage, explorer names, palette, delete, search, shortcuts, widths 1280/900/400, theme toggle; drag and drop, multi-select and the nine editor themes not exercised; W26–W30 |
| P10 editor help | partly: completion (12 probes, all sensible; `QPI::` offers nothing), hover (one-line text), format (no change on formatted sources); quick fixes, signature help and F12 not confirmed either way |
| P11 production build | exercised: starter loop, shipped test, ledger slice, completion — same as dev, no build-only defect |
| P12 soak | exercised: 100 edit-build-call rounds, 0 failures, counter 5050 as expected, page heap 81 → 116 MiB, 3 workers throughout; the 10-minute ticking run was not done |
| Not present in the IDE | oracle answering, system contracts, GitHub, sharing with collaboration, sign-in, undeploy |

Method notes: findings were reproduced by the named phase script rather than by one script per finding. W30 was seen in one
of two runs. Oracle 2 of the plan (a stand-alone engine harness) was not built; the CLI (`qinit build`, `qinit verify`,
`bun test`) and paper answers served instead.
