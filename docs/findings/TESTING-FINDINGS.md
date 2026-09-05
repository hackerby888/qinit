# qinit CLI test campaign — findings

Workspace: `/home/kali/Projects/qcounter-qinit/Counter` (Counter@30 + Calle@29)
Binary: `/home/kali/Projects/Qinit/dist/qinit` (rebuilt from HEAD 73ec695+ at start — the shipped one was stale)
Probe procs added to `contracts/Counter.h`: Flow(4) Containers(5) BigWrite(6) Chain(7) Logs(8), fns PrintZoo(2) Peek(3)

## Confirmed defects

### F1 — `--in "-1sint64"` is rejected; every negative literal is unreachable via the documented syntax
`qinit call --proc Counter 4 --in "-5sint64"` → `invalid arguments: Option '--in' argument is ambiguous.`
The arg parser treats the leading `-` of the value as a flag. `--in=-5sint64` and `--in " -5sint64"` both work,
but `--help`/`cheat-sheet` document the space form. Verdict: CLI bug.

### F2 — `--args` loses precision on 64-bit integers (silent corruption near the top of the range)
`--args '{"n":18446744073709551615}'` → `--args: uint64 out of range: 18446744073709551616`.
The JSON is parsed into a JS `Number`, so any value above 2^53 is rounded before the range check —
the max valid uint64 is rejected *and* the error prints a number the user never typed. Same for
`{"s":9223372036854775807}` → reported as `9223372036854775808`. Values above 2^53 that do not land on
the boundary are accepted and silently wrong. `--in` (the string parser) handles the full range correctly.
Verdict: CLI bug, the most severe of the input findings.

### F3 — calling an unregistered procedure number reports success
`qinit call --proc Counter 9` → `{"ok":true,...,"tx":"njwqy…"}`. Counter registers procs 1,2,3 only.
No trace entry is produced for that tick, so nothing executed. A typo'd entry number looks like a
successful on-chain write. Verdict: CLI/engine reporting bug.

### F4 — `--out` narrower than the real output truncates silently; wider errors with an internal message
With counter = 5000000100: `--out uint64` → `5000000100`; `--out uint32` → `705032804`; `--out uint8` → `100`.
No warning, though the IDL knows `Get_output.value` is uint64. `--out id` (32B > 8B) → `Out of bounds access`,
a raw internal string rather than a size-mismatch message. Verdict: CLI bug.

### F5 — `LOG_PAUSE()` is honoured by core's log buffer but ignored by the debug trace
`Logs(n=1, pause=1)` emits INFO, WARN, DEBUG, then `LOG_PAUSE(); LOG_ERROR(x); LOG_RESUME();`, then a final
`LOG_ERROR(x)`. The trace carries **five** logs — two identical ERROR entries — so the paused one was
captured. The contract's own counter (`output.emitted`, which does not count the paused call) says 4.

This is *not* a no-op: core implements the pause (`logging.h:1019 pause() { isPausing = true; }`, honoured at
`logging.h:405` `logMessage(): if (isPausing) return;`) and the wasm path is wired through
(`lhost_imports.h:130 → qpi_services.h:161 → __pauseLogMessage`). What ignores it is Qinit's **debug-trace
ring**, a separate capture. Consequence: a log the chain deliberately does not record still shows up in
`qinit debug` and `call --trace`, so the trace over-reports relative to the real log stream.
Identical on all four matrix cells. Verdict: trace-capture bug, not a QPI bug.

### F6 — `--json` never emits the `cheats` key, so CC_PRINT output is invisible to machine consumers
`call --fn Counter 2 --trace --json` returns keys `[ok, contract, slot, entry, kind, tick, tx, out, error,
execNs, caller, in, state, logs]`. The node's trace entry for that same call carries 17 cheat records and the
human `--trace` renders all 12 prints. `logs` and `state` are exported; `cheats` is dropped.

The exported `logs` also flatten nested structs into positional arrays — `"abc":[["13","39"],"39"]` where the
human renderer shows `{ab: {a: 13, b: 39}, c: 39}`. Field names are lost for machine consumers.
Verdict: CLI bug, both halves.

### F7 — a one-field struct renders as a bare scalar (design, but inconsistent)
`Logs_output {uint64 emitted}` renders as `out 8`, and `CC_PRINT("Output is", output)` prints `Output is 13`;
two-field and larger structs render `{a: 0, b: 0}`, and a **zero**-field struct renders `{}`. This is
deliberate — `state-format.ts:155`, *"A one-field struct read as a whole field is its value, so it keeps the
bare form."* Not a defect; noted only because 0 fields and 2+ fields both keep braces while 1 field does not,
so the rendering does not round-trip to a type. Verdict: design, worth a doc line.

### F8 — a bare container in CC_PRINT renders a stray "no scalar fields" and an unnamed header
`CC_PRINT("array container", state.get().abc_array)` →
```
  print :498 array container
          no scalar fields

        · 4096 set · 0/4096 zero
```
The block header has no container name (compare `qinit state`'s `abc_array · 2 set · …`) and "no scalar fields"
is noise. A struct that *holds* a container renders correctly (`value 47` / `map · 6 entries · …`).
Verdict: rendering bug, top-level-container case only.

### F9 — nested containers have no `--container` index
`qinit state Counter` lists `[1]..[6]` for the six top-level containers but prints `test_struct.map` and
`test_struct2.map` with no index; `--container 7` → `container index 7 is outside 1..6`. Only `--all`
(which loads every container, 735KB of JSON on this contract) reaches them. Verdict: usability gap.

### F11 — `--compiler typescript` skips the protocol-rule gate, so prohibited C++ reaches the chain
`qpi.h` prohibits `%`, `/` as a division operator, and locals declared outside `_locals`. Built four
minimal violating contracts:

| contract | violation | `--compiler clang` | `--compiler typescript` | `qinit verify` |
|---|---|---|---|---|
| Modop | `input.n % 7` | rejected | **ACCEPTED** | rejected |
| Divop | `input.n / 7` | rejected | **ACCEPTED** | rejected |
| Localvar | `uint64 tmp = …` in a procedure body | rejected | **ACCEPTED** | rejected |
| Floatop | `double x = 1.5` | rejected | rejected (`unsupported expression 'float_literal'`) | rejected |

clang says `Qubic protocol violations: • Modulo operator ``%`` is not allowed. Use the ``mod`` function
provided in the QPI instead.` and `qinit verify Modop.h` reports the same. The TypeScript path builds
cleanly and never prints the `✓ protocol rules passed` line the clang path emits.

`deploy` does not close the gap — `qinit deploy Modop.h --compiler typescript` (no `--skip-verify`)
put it on slot 31, and `call --proc Modop 1 --args '{"n":13}'` returned `6` with `counter 0 → 6`.
A contract Core would reject was compiled, deployed and executed. Verdict: highest-severity finding.

### F12 — a migration is invisible in the trace on the core runtime, visible on the simulator
Same contract, same MIGRATE, two runtimes:

| | migrated correctly | `kind=3` trace entries | `qinit debug` row |
|---|---|---|---|
| simulator | yes | 1 (`inSize=24`, `diff=1`) | yes |
| core-lite (node `qinit-v0.0.43`) | yes | **0** | no |

On the simulator the row renders fully — `in {counter: 2, lastReward: 5, incCalls: 2}` decoded through
`OldStateData`, and a five-field diff over the new layout. On core the state proves MIGRATE ran
(`migratedAtTick 77700407`, `carriedCounter 19000 = 19 × 1000`) but nothing is recorded. This is the gap
already fixed in unreleased core-lite `31d1be18`; the shipped node binary still has it. Verdict:
runtime divergence, fix exists but is not in the released node.

### F13 — `CC_PRINT` does not compile inside a callee contract
`CC_PRINT("…", oldState.counter)` in `Calle.h` builds fine when Calle is the primary contract
(`qinit build contracts/Calle.h --contract-name Calle` → built ✓) but fails when Calle is pulled in as a
callee of Counter: `Calle.h:66:9: error: use of undeclared identifier 'CC_PRINT'`. The cheat macro is only
injected for the primary contract, so a cross-contract flow cannot be print-debugged on the callee side.
The failure is also mislabelled — the header reads `✗ build wasm  Counter: compile failed` while the error
is in `Calle.h`. Verdict: CLI/compiler bug.

### F14 — `/live/v1/tick-info` returns a different shape per runtime
simulator: `{"tick":3060,"epoch":1}`; core-lite: `{"alignedVotes":0,"mainAuxStatus":3,…,"tickInfo":{"tick":…,"epoch":…}}`.
Same path, same CLI, incompatible payloads — anything scripting the RPC breaks on a runtime switch.
Verdict: RPC inconsistency.

### F15 — a state-layout change with no `MIGRATE` is silently absorbed
Growing `Calle::StateData` from 8 to 24 bytes with no `MIGRATE()` redeployed with a plain `[deployed ✓]`
and no warning. The old `counter` (7) was preserved by overlap and the two new fields were zeroed. That is
the documented fallback, but nothing tells the developer their migration was skipped rather than run.
Verdict: missing warning (pre-existing, both runtimes).

### F16 — the migrate row has no timestamp in `qinit debug`
Every other row shows `7 sec ago`; the migration row shows `—` in the `time` column while its `tick` is
correct. Verdict: cosmetic.

## F19 — a contract loop with a large trip count hangs the node with no limit, trap or error

`Flow(n=9007199254740993)` runs `while (locals.j > 0) { …; locals.j--; }` — 9 × 10^15 iterations. The node
(`qinit __serve`) stops answering RPC entirely while spinning at 100% CPU. Reproduced twice with the same
input. `gdb -p` showed the main thread inside an unmapped JIT region and the worker parked on
`pthread_cond_timedwait`; RSS stayed flat at 320MB, so it is not an OOM. Curl gets no response at all — not
a timeout error, no connection. Only `qinit node stop` recovers it.

It is not a threshold effect, it is unbounded compute with nothing metering it:

| `n` | `execNs` | result |
|---|---|---|
| 10^8 | 247,803,822 (0.25 s) | `whileSum: 5000000050000000` ✓ |
| 2 × 10^9 | 4,976,010,214 (**4.98 s**) | `whileSum: 2000000001000000000` ✓ |
| 9 × 10^15 | — | node wedged, ~260 days extrapolated |

A single invocation held the node for five uninterrupted seconds inside one tick and was accepted as
normal. There is no fuel metering, no instruction budget, no wall-clock watchdog, and no tick deadline.
An accidental infinite loop — the most ordinary contract bug there is — takes the whole dev node down with
no diagnostic. Verdict: confirmed defect, highest operational severity.

### F20 — `div()`/`mod()` on signed operands resolve to `<cstdlib>`'s `div`, and the two compilers disagree
`output.signedDiv = div(input.s, (sint64)-7);` fails under clang:

```
error: assigning to 'sint64' (aka 'long long') from incompatible type 'lldiv_t'
```

`using namespace QPI` does not stop overload resolution from picking the global
`lldiv_t div(long long, long long)` for signed arguments; `QPI::div` only wins for `uint64`, where libc has no
overload. **The same source builds cleanly with `--compiler typescript`**, which resolves the call to
`QPI::div`, and `qinit verify` reports `✓ protocol rules passed`. So a contract written against the TS
compiler can use `div`/`mod` on signed values and be uncompilable by Core's real toolchain.
Workaround: write `QPI::div(...)` / `QPI::mod(...)` explicitly — that builds under both.
Verdict: second accept/reject divergence, same class as F11.

### F21 — `sadd(INT64_MIN, INT64_MIN)` returns 0 instead of clamping (upstream QPI bug)
Boundary case `Wrap(n=2^64-1, s=-9223372036854775808)` returned `satAdd: 0`. Expected `-9223372036854775808`.
`contracts/math_lib.h:126`:

```cpp
inline static long long sadd(long long a, long long b)
{
	long long sum = a + b;
	if (a < 0 && b < 0 && sum > 0) // negative overflow
		return INT64_MIN;
```

`INT64_MIN + INT64_MIN` wraps to exactly **0**, which is not `> 0`, so the guard misses and the wrapped value
is returned. (`a + b` on signed overflow is also UB, so the check depends on the wrap it is trying to detect.)
Positive overflow clamps correctly (`sadd(INT64_MAX, INT64_MAX)` → `INT64_MAX`), and `sadd(-1,-1)` → `-2`.
This is in core's own math_lib, not Qinit — both Qinit compilers reproduce it faithfully, which is the
correct outcome for them. Verdict: upstream QPI/core defect, worth reporting there.

## Compiler × runtime matrix

Four cells, each on a **fresh node** (`node stop` → `runtime R` → `node run` → `deploy --compiler C` →
24-step suite), compared field by field: `ok`, `in`, `out`, `error`, every state-diff row, every decoded log,
every container summary, and the signature of all 32 debug-trace entries
(`index, kind, entry, ok, inSize, outSize, |stateDiff|, |logs|, |cheats|, |hostCalls|`).

| cell | vs `clang × simulator` |
|---|---|
| `typescript × simulator` | 0 differing steps |
| `clang × core` | 0 differing steps |
| `typescript × core` | 0 differing steps |

Two of the 24 steps (`03-flow-max`, `04-flow-63`) never reach the node in any cell — they are rejected by
the CLI at `--args` parse time (F2) — so the cell comparison is really **22 executed steps**, and the two
excluded ones were the 64-bit boundary probes. Those were re-run separately through a loop-free
`Wrap` function (added for this purpose, since the original probe's `while` loop makes a max-`uint64` input
hit F19) using `--in=` to dodge both F1 and F2:

| case | `n` | `s` |
|---|---|---|
| 1 | 2^64−1 | −2^63 |
| 2 | 63 | 2^63−1 |
| 3 | 0 | 0 |
| 4 | 2^53+1 | −1 |
| 5 | 2^64−1 | 2^63−1 |

Twelve outputs each — `<<`/`>>` mix, `div`, `mod`, 64-bit multiply wrap, `smul` saturation, `+1` wrap,
arithmetic right shift of a negative, signed `div`/`mod`, `sadd`, xor mix, signed compare — **identical
between clang and typescript on all five**, including the wrong `satAdd: 0` of F21. Hand-checked case 1
against Python: `shifted` 16140901073085792255, `divPart` 2635249153387078802, `modPart` 1, `addWrap` 0
(wrap), `signedShift` −1152921504606846976 (arithmetic), `signedDiv` 1317624576693539401 — all correct.

The only byte-level difference anywhere was `qpi.tick()` inside a `Log2` payload (3074 vs 3072) — wall-clock
drift between two node runs, not a divergence.

**So: for a contract that compiles on both, the two compilers and the two runtimes agree exactly.** Every
divergence found in this campaign is at the edges — what the TS compiler *accepts* (F11) and what the core
runtime *records* (F12) — not in what either computes.

## Verified correct (oracle-checked, no defect)

- `Flow(n=13, s=-5)`: all 11 outputs matched hand-computed oracles — `for` with `continue`+`break` (49),
  `while` (91), `do/while` (12), `switch` (200), signed branch (-22), shift+xor (111669149697), `div` (1),
  `mod` (6), 64-bit multiply wrap (635340061525167377), `smul` saturation (2^64-1), ternary (1).
- `Containers(n=40, removeEvery=3)`: mapPop 40 → 26 after removing every third key, re-add into a
  removal-marked slot found the new value, list head removal left head=1/tail=39, collection 39, bitarray 26.
  Same at n=1024 (full capacity): 1024 → 512.
- uint64 wrap-around through `--in`: `Inc(18446744073709551615)` leaves the counter unchanged and produces a
  zero-length state diff, i.e. the diff is value-based, not write-based.
- Nested cross-contract frames are traced as their own entries (`idx=29 kind=1` and `idx=29 kind=0` ahead of
  the parent `idx=30 kind=1`), and the parent shows `host invokeProcedure → @29 proc #1 reward=1`.
- Log decode: INFO/DEBUG/WARN/ERROR all decode `Log1`/`Log2` with struct and `id` fields intact.
- CC_PRINT: line numbers, loop retention (one instance per iteration), literal-only prints, unlabelled
  value prints (`state.get().counter=123`), and container blocks all render.
- Unaffordable invocation reward: `Chain(reward=1000000000000)` from a zero-balance contract returns
  `NoCallError` and the callee runs. This **matches** core, which documents it at
  `contract_exec.h:435` — "If transfer isn't possible, set invocation reward to 0". Initially filed as a
  defect, withdrawn after reading the core source. Identical on all four matrix cells.
- Invocation-reward semantics, funded caller: `Chain(rounds=2, reward=5)` with `--amount 1000000` gave
  `rewardSeen: 1000000` (the tx amount the caller saw), `calleeReward: 5` (what the callee saw), and the
  contract balance moved 1000000 → 999990, i.e. exactly 2 × 5 out. Matches core.
- `MIGRATE` correctness on both runtimes: old fields carried, `qpi.tick()` recorded, derived field
  `carriedCounter = oldState.counter * 1000` computed from the old layout.
- `qinit test`: 2/2 pass. `qinit gtest`: 3/3 pass on **both** `--compiler clang` and `--compiler typescript`.
- `qinit strip contracts/Counter.h`: 16 `CC_PRINT` sites → 0 in the output, contract otherwise intact.
- `qinit call --trace` no longer disables node capture (regression check on commit 83dbbf7): rows stay in
  `/live/v1/debug-trace` after a traced call.
