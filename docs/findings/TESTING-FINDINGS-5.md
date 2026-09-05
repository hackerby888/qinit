# qinit CLI test campaign 5 — the toolchain and its consumers (F55+)

Binary: `/home/kali/Projects/Qinit/dist/qinit` rebuilt from `41aff6ce` (2026-09-05 12:46).
Node: cached `qinit-v0.0.46`; latest release is `qinit-v0.0.47`; the CLI's core-lite pin is `b2e03720`,
which is on `develop` only — **no released node carries it**, so `feeReserve` / the `(dormant)` label
are unreachable on any fetchable core node this campaign could run.
Plan: `~/.claude/plans/given-cli-exploratory-merry-newell.md`. Workspace: `~/Projects/qinit-c5/`.
Scope: (B) toolchain + environment, (D) the CLI's consumers. Report only; nothing fixed.

## Summary

Ten new findings (F55–F64) and five extensions (F24, F30, F45, F47, F9) from the two axes campaigns 1–4
never took: the toolchain around the contract (setup/clean/doctor/uninstall, caches, version drift,
node lifecycle, binary vs `bun run dev`, two clients on one node, `install.sh`) and the layers a developer
builds on (the `qinit gen` client, `qinit test` on core, `qinit gtest` incl. the upstream corpus, `strip`
and `integrate`). Every value checked against an oracle outside the road under test: a Python
`struct.pack` byte image, `state --dump`, the other compiler, the other runtime, core-lite's own source
(`MAX_AMOUNT`, `uint128_t`), `du`, or Qinit's own second road. Report only; nothing fixed.

| # | severity | one line | cells |
|---|---|---|---|
| **F64** | high (one killed client blocks all deploys) | a CLI interrupted mid-upload leaves the node's upload session active forever; every later deploy says `wait for it to complete`; only a node restart clears it | core (node-side session; the simulator emits the same *message* from `engine/transport.ts:605`, not tested) |
| **F55** | high (silent no-op on the money path) | `call --proc --amount` above the signer's balance → `✓ processed` + tx id, procedure never runs; the node's `moneyFlew:false` reaches the gen client but not the CLI | all four |
| **F56** | medium (missing diagnostic) | `doctor` is green under the headers/node drift that `node status` and `setup` both flag | runtime-independent |
| **F59** | medium (green suite that checks nothing) | every scaffolded `gtest` has 0 assertions and renders `[passed ✓]` | simulator (gtest is sim-only) |
| **F60** | medium (wrong diagnostic) | full slot window reported as "keeping every callee below its caller"; error rows mid-elided at the 80-column width a pipe gets (full at 220) | core (slot window) |
| **F61** | medium (legal contract refused by a generated file) | gtest scaffold `in{}` does not compile for an input holding `uint128` | simulator |
| **F57** | low (envelope) | `ls --json` has no `ok`/`error`; exits 0 on a dead node with `nodeDown:true` | both |
| **F58** | low (wrong number) | `clean` follows symlinks and prints MiB as MB: `552.7MB` for 382 MB of files | — |
| **F62** | low (help vs parser) | `tick show` / `epoch show` advertised, rejected | both |
| **F63** | low, 1/10 | one `info --json` document missing two sections, node text inside `qinit.binary` | binary only |
| F45 ext | high | the assert guard vanishes on `strip`, `--production` **and** `integrate`, all silent | all |
| F30 ext | medium | switching `--runtime` relaunches and discards the other backend's contracts with `ok:true` | both |
| F24 ext | low | `integrate --json` and `clean --json` render Ink frames; `system ls` has no JSON road | — |
| F47 ext | low | `--trace --json` state rows are still rendered text | all |
| F9 ext | low | a state whose only containers are nested: `container index 1 is outside 1..0` | all |

Withdrawn before filing: amounts above 2^53 being refused (they exceed `MAX_AMOUNT = 1e15`, protocol rule);
a stale `local` system-wasm cache (§19 warns of it; it recompiles); the `A×60` vs `A×56+FXIB` zero
identity (design, `qubic.ts:60`); `--container N` returning every container (they are all `loaded` on a
small state — the filter only matters above the collapse threshold, not exercised here).

## Findings

### F55 — a `--proc` call whose `--amount` exceeds the signer's balance reports `✓ processed` with a tx id and runs nothing; the tx-status road the generated client uses says `moneyFlew:false`, and `qinit call` never reads it

Severity: **high** — silent no-op on the money path, reported as success. The generated client, on the
same node and the same call, does surface the signal, so this is one Qinit road disagreeing with another.

Repro (simulator, clang; signer is the saved funded seed, balance 2 000 000 000 000 qu):

```
qinit call --fn PWide Peek --json | jq -c '{calls:.out.calls,lastReward:.out.lastReward}'
# {"calls":"4","lastReward":"1000000"}

qinit call --proc PWide Pay --amount 3000000000000 --json | jq -c '{ok,error,tx,tick}'
# {"ok":true,"error":null,"tx":"cqmagftahjpyhbzohdedyhnxitcamdpjlfaoidttxfqqgjyuqncmcgxcrxce","tick":4935}

qinit call --fn PWide Peek --json | jq -c '{calls:.out.calls,lastReward:.out.lastReward}'
# {"calls":"4","lastReward":"1000000"}   <-- unchanged: the procedure never ran
```

Control, same session, amount inside the balance:

```
qinit call --proc PWide Pay --amount 7 --json | jq -c '{ok,error}'   # {"ok":true,"error":null}
qinit call --fn PWide Peek --json | jq -c '{calls:.out.calls,lastReward:.out.lastReward}'
# {"calls":"5","lastReward":"7"}          <-- it ran
```

The oracle is the CLI's own generated client against the same node and the same amount:

| amount | `qinit call --proc` | `new PWide().Pay({amount})` | ran? |
|---|---|---|---|
| 7 | `ok:true` | `ok:true confirmed:true included:true **moneyFlew:true**` | yes |
| 3 000 000 000 000 (> balance) | `ok:true`, no error | `ok:true confirmed:true included:true **moneyFlew:false**` | **no** |
| 9 007 199 254 740 993 (> MAX_AMOUNT) | `ok:false invalid transaction amount …` | `ok:false included:false` | no |
| 18 446 744 073 709 551 615 | `ok:false … exceeds the signed 64-bit range` | throws `invalid amount … (must be 0..2^63-1)` | no |

So the tx-status RPC the client's `invokeProcedure` settles on carries `moneyFlew:false`; `qinit call`'s
settle path never consults that field (`grep moneyFlew packages/cli/src` hits only the explorer and the
wallet). In `--json` the keys are absent entirely (`moneyFlew`, `included`, `confirmed` are all `null`), so a
machine consumer of the CLI cannot tell the two rows apart either.

With `--trace` the rendered frame is worse:

```
✓ PWide.Pay     processed
  tx   faqroipjvkmueeexnspfldcoaulghvwryfhoddsceaukyifurharbsaaaaia
  tick 5400
(no trace captured — is the debug toggle available on this node?)
```

which is the same "blame the debug toggle" wording F26 was fixed for (`06ede6a7`) — the fix covered a
signer with **zero** balance ("fail an unfunded-signer call before submitting"); a funded signer whose
`--amount` merely exceeds its balance is the sibling case and still passes the gate.

Not a re-file of F26: that one is an unfunded seed, this one is a funded seed and a legal amount.

**Reproduces identically on core** (`qinit-v0.0.47`, signer balance 10 000 000 000 qu, `--amount 20000000000`):
CLI `{"ok":true,"error":null,"tx":true}` and `✓ PWide.Pay processed … (no trace captured — is the debug
toggle available on this node?)`; client `{ok:true, confirmed:true, included:true, moneyFlew:false}`;
`calls` unchanged before and after. Runtime-independent — all four cells.

**Withdrawn from this entry before filing:** the `9 007 199 254 740 993` row is not a bug. `MAX_AMOUNT`
is `ISSUANCE_RATE * 1000 = 1e15` in core-lite's `common_def.h` (mirrored in
`packages/compiler/src/generated/qpi-protocol-prelude.ts`), so any amount above 1e15 is protocol-invalid
and both roads are right to refuse it. The message could name the limit, but the rejection is correct.

### F45 (extension) — the cheat-assert guard vanishes on *three* roads, and none of them says a word

F45 filed one road (`--production`). All three roads a developer can take now agree with each other and
disagree with the developer: **`qinit strip`, `qinit build --production` and `qinit integrate` all remove
`CC_ASSERT` silently**, with no warning in the rendered frame, in `--json`, or in `verify`.

Probe: `PCheat.h` with every cheatcode in every position — an assert as an input guard, an assert and a
print inside a `for` body and inside an `if`, `CC_PAY`/`CC_DEAL`/`CC_PRANK`/`CC_UNPRANK`/`CC_WARP_TICK`/
`CC_WARP_EPOCH` in a procedure, a print and an assert in a **function**, and a print in `BEGIN_TICK`.

```
qinit strip contracts/PCheat.h --out /tmp/PCheat-clean.h        # ok, silent
qinit build /tmp/PCheat-clean.h  --compiler clang --json | jq -r .hash
# 0e2225b10224deadc061bffd0414dcb90b11bb222e67583135c7f48603c8114b   17835 bytes
qinit build contracts/PCheat.h --compiler clang --production --json | jq -r .hash
# 0e2225b10224deadc061bffd0414dcb90b11bb222e67583135c7f48603c8114b   17835 bytes  <-- identical
```

Then, on the deployed production build:

```
qinit call --proc PCheat Guard --in="{ 0uint64 }" --json   # {"ok":true,...}
qinit call --fn   PCheat Read  --json
# {"ok":true,"out":{"total":"0","ticks":"35","guarded":"0"}}   <-- the guard wrote the forbidden 0
```

`qinit integrate` is the third road and the most dangerous one, because it is the hand-off to real Core:

```
qinit integrate contracts/PCheat.h --out ./pcheat-core --asset PCHT --construction-epoch 200
# ✓ check contract  PCheat.h  6ms
# ✓ wire contract   created index 29
grep -c CC_ ./pcheat-core/src/contracts/PCheat.h      # 0
sed -n '/PUBLIC_PROCEDURE(Guard)/,/^    }/p' ./pcheat-core/src/contracts/PCheat.h
#     PUBLIC_PROCEDURE(Guard)
#     {
#                                    ;
#                                            ;
#         state.mut().guarded = input.amount;
```

The removal itself is deliberate — `core-integration.ts:301` says cheatcodes "must not survive" this
hand-off, and `analyzeCheatcodes()` only rejects *misuse*, so a legally-used `CC_ASSERT` is stripped, not
refused. The gap is the silence: the step that deletes a developer's only input guard prints `✓`.

**Verified correct in the same probe:** `strip` blanks each cheat **in place**, preserving line and column
(a bare `;` is left), so line-mapped traces still point at the right source line; and `strip` and
`--production` produce **byte-identical wasm** (same k12, same 17 835 bytes) — the two roads agree.

### F24 (extension) — `qinit integrate --json` renders the Ink progress frames to stdout and exits 0

F24 listed six commands that accept `--json` and ignore it. `integrate` is a seventh, and the worst of
them: it is the command that mutates a real git checkout, and with `--json` it writes spinner frames and
ANSI cursor codes to stdout, then exits 0.

```
qinit integrate contracts/PCheat.h --out ./pcheat-core --asset PCHT --construction-epoch 200 --json > out.json
echo $?          # 0
head -c 80 out.json
# qinit  ▸  integrate\n\n⠋ checking Qubic Core target…
```

`docs/cli-guide.md` §19 already records that `integrate` only *reads* `output.json` to suppress prompts,
so this is documented behaviour rather than a surprise in the code — but a machine caller that pipes the
one destructive command into `jq` gets a parse error and a zero exit status.

### F56 — `qinit doctor` is blind to the headers/node version drift that `node status` flags and `setup` refuses to ignore

Severity: **medium (missing diagnostic)** — `doctor` is the command whose only job is to check the setup,
and it is the one command that does not check this.

Repro (a hardlinked copy of the real cache so the live one is untouched; only `current.json` is rewritten):

```
C=~/qinit-c5/sandbox/cache-real          # cp -al ~/.cache/qinit
jq '.headersVersion="qinit-v0.0.45" | .coreHeaders="'$C'/qinit-v0.0.45/core-headers"' \
   $C/current.orig.json > $C/current.json

QINIT_CACHE=$C qinit node status --json | jq -c '{headersVersion,nodeVersion,versionDrift,error}'
# {"headersVersion":"qinit-v0.0.45","nodeVersion":"qinit-v0.0.46","versionDrift":true,
#  "error":"⚠ headers/node version drift — run `qinit setup`"}

QINIT_CACHE=$C qinit doctor ; echo "exit=$?"
# [toolchain ✓]  wasi-sdk ✓ / qubic-core-lite headers ✓ / contract-verify tool ✓
# exit=0
```

`setup.tsx` throws `headers/node version drift (X != Y)` on the same state and `node status` reports it,
so two of the three setup-facing commands agree that this is a fault; `doctor` renders three green rows.
A `qinit build` under the same drift also succeeds with no mention (here it even produced an identical
k12 to the matching-headers build, so no wrong code was generated in this particular pair — the gap is
that nothing tells you which headers you compiled against).

Control: `qinit doctor` on the same cache with `current.json` restored is also green and exit 0, i.e. the
output is identical whether or not the drift exists.

Also `doctor --json` renders the Ink frame instead of a document — already known as F24, which lists
`doctor` by name.

### F57 — `qinit ls --json` is the only JSON command with no `ok` / `error` envelope

Severity: **low (machine consumers)** — new code; `ls.tsx` and `ls-json.test.ts` landed today.

```
qinit ls --json | jq -c 'keys'
# ["deployed","nodeDown","system"]              <-- no "ok", no "error"

qinit state PPad --json | jq -c 'keys'
# ["complete","containers","contract","error","fields","ok","slot"]
qinit call --fn PPad Read --json | jq -c 'keys'
# ["contract","entry","error","kind","ok","out","slot","tick","tx"]

qinit ls --rpc http://127.0.0.1:45999 --json > out.json ; echo $?      # 1
jq -c 'keys' out.json                       # ["deployed","nodeDown","system"]   nodeDown:true
qinit state PWide --rpc http://127.0.0.1:45999 --json ; echo $?
# {"ok":false,"error":"the node did not answer, so its contracts are unknown — is it running? …"}  1
qinit node status --rpc http://127.0.0.1:45999 --json ; echo $?
# {"ok":false,"up":false,"error":"rpc: down (node not reachable)"}  1
```

(An earlier reading of "exit 0" for `ls` was `jq`'s status through a pipe — ground rule 6; every dead-node
row exits 1.)

`docs/cli-guide.md` §19 states every JSON-capable command emits a document and that an error emits
`{ok, error}`; `ls` is listed there as JSON-capable. A consumer that branches on `.ok` reads `null` from
`ls` on both success and node-down; the exit code (1) and `nodeDown:true` are the only signals, and the
rendered frame says `node unreachable — deployed contracts hidden` — so this is an envelope
inconsistency, not lost information.

### F58 — `qinit clean` reports the space it frees by following symlinks and labelling MiB as MB: `552.7MB` for a wasi-sdk that holds 382 MB of files

Severity: **low (wrong number in a diagnostic)**.

```
QINIT_CACHE=$E qinit setup --force          # fresh cache: headers + node v0.0.47 + wasi-sdk + verifier
QINIT_CACHE=$E qinit clean --dry-run
# • would free 593.5MB
#   wasi-sdk      552.7MB
#   qinit-v0.0.47 38.7MB
#   tools         2.0MB
du -sh --apparent-size $E/wasi-sdk           # 365M   (MiB)
```

Oracle (Python over the same tree): `lstat` sum of real files **382.3 MB**; `stat` sum that follows the
SDK's 33 symlinks (clang, clang++, wasm-ld … all point at the same binaries) **579.6 MB** = **552.7 MiB**.
So the figure is the symlink-following total in MiB, printed with an `MB` suffix. `qinit-v0.0.47 38.7MB`
is likewise 38.7 MiB (`du --apparent-size` says 39M). The real `clean` afterwards prints `✓ freed 593.5MB`
from the same sum. Source: `packages/cli/src/ops/cache.ts:24` sums `statSync(entryPath).size` (which
follows a symlink to its target; `lstatSync` would not), and `:34` formats in steps of 1024 with the `MB` label.

### F59 — a freshly scaffolded `qinit gtest` asserts nothing and is reported `✓ tests 3/3 passed`, `[passed ✓]`

Severity: **medium (wrong diagnostic — a green suite that checks nothing)**.

```
qinit new PCounter --template counter          # ships tests/PCounter.test.cpp
grep -cE '^\s*(EXPECT|ASSERT)_' tests/PCounter.test.cpp     # 0
grep -n TODO tests/PCounter.test.cpp
#  25: // TODO: set in.<field> = ...;
#  44: // TODO: assert the initial state via a checker over contractStates[PCounter_CONTRACT_INDEX].
#  55: // TODO: EXPECT_EQ(out.<field>, ...);
qinit gtest --compiler clang
# ✓ PCounter.Initialize   ✓ PCounter.Inc   ✓ PCounter.Get
# ✓ tests     3/3 passed
# [passed ✓]
```

Same for every template (`hashmap` 4/4, `asset` 4/4, `intercontract` 3/3, all with 0 assertions) and
for `gtest --new` on a fresh contract (`PPad` 3/3, 0 assertions). Nothing in the frame says the suite is
a stub. The scaffold is deliberately a stub (`std-gtest.ts:35/66/80/92` write the `TODO`s), and a
`qinit test` spec is documented as "the developer's to write" — but `gtest` renders the stub as a pass
with the same `[passed ✓]` box a real suite gets. Control: `--corpus QUTIL --core-dir <core-lite>` runs the
real upstream suite, 51/51 in 42 s, with the same box.

### F60 — `qinit test` reports a full slot window as a callee-ordering problem, and its error rows are mid-elided at the 80-column width every pipe gets

Severity: **medium (wrong diagnostic)**.

With slots 29–32 all occupied (`PWide`, `PCounter`, `PHashmap`, `PAsset`) on a 4-slot node:

```
cd PIntercontract && qinit test --runtime core --compiler clang ; echo $?
# ✗ ERROR         cannot assign 2 project contr…very callee below its caller
# 1
```

The full string (`project-slots.ts:160`) is `cannot assign 2 project contracts to dynamic slots 29..32
while keeping every callee below its caller`. Two problems: the cause is "no free slot", and the text
names an ordering constraint instead; and the rendered row cuts the middle out at the 80-column
non-TTY width every pipe gets (`COLUMNS=220` and `--plain` do not change it — Ink reads
`stdout.columns`, which a pipe does not have). `qinit deploy` on the same full window prints the whole
sentence, wrapped, in the same pipe, and in a 220-column tmux; so it is the `test`/`gtest` step-row
renderer that elides, and only where the developer is most likely to be reading through `2>&1 | tee`.
Control: the same project passes on `--runtime simulator` (its own in-process node, empty window),
1 pass / 4 expect() calls.

### F61 — the gtest scaffolder emits `in{}` for an input struct that contains a `uint128`, which does not compile against core's `uint128_t`

Severity: **medium (loud rejection of a legal contract by a generated file)**.

```
qinit gtest --new --compiler clang            # PWide: Vals { uint128 u128; id who; … }
# ✓ scaffold  tests/PWide.test.cpp (core-lite)
# ✗ build     test-wasm build failed
# │ stderr PWide.test.cpp:23:31: error: no m…n of 'uint128' (aka 'uint128_t') │
sed -n 23p tests/PWide.test.cpp
#         PWide::Store_input in{};
```

`src/platform/uint128.h:31` declares `class uint128_t{` with only `uint128_t(uint64_t)` and
`uint128_t(uint64_t, uint64_t)` constructors, so `Store_input in{}` needs a default constructor the class
does not offer. The contract itself builds and deploys on both compilers and passes C1 12/12; only the
generated test refuses it. In a pipe the diagnostic is elided to `no m…n of 'uint128'` (F60's renderer);
in a 220-column tmux the row reads in full: `error: no matching constructor for initialization of
'uint128' (aka 'uint128_t')`. `QINIT_GTEST_TRACE=1` / `QINIT_DUMP_GTEST_SOURCE=1` do not widen it.

### F62 — `qinit tick show` and `qinit epoch show` are advertised by their own `--help` and rejected as unknown subcommands

Severity: **low (loud rejection of documented input)**.

```
qinit help tick   # usage: qinit tick [show | advance <n> | advance-to-last [gap] | rate <ms>]
qinit tick show --json
# {"ok":false,"action":"show",…,"error":"unknown subcommand 'show' (use: advance <n> | advance-to-last [gap] | rate <ms>)"}
qinit help epoch  # usage: qinit epoch [show | advance]
qinit epoch show --json
# {"ok":false,"action":"show",…,"error":"unknown subcommand 'show' (use: advance)"}
qinit tick --json    # {"ok":true,"action":"show","tick":77700156,"error":null}   <-- bare form works
```

The error's own `use:` list omits `show`, the usage line includes it, and the JSON reports `action:"show"`
while refusing it. Same on the binary and under `bun run dev` (`tick show --json` → the same `error`).

### F63 — one `info --json` document from the binary came back with two sections missing and the node's status text inside `qinit.binary`

Severity: **low, trigger unknown** — it appeared in **both** T4 harness runs (2/2, the first of which had
no concurrent `bun` process at all, so "under load" is not the explanation) and in 0/13 runs outside the
harness, including three with the harness's exact `> file 2>&1` redirection. Kept because the artifact is
unambiguous and the shape (rendered text leaking into a data field, F47's family) is one the codebase has
had before.

Captured during the T4 row set, immediately after an `epoch --json` row, with the core node up
(`~/Projects/qinit-c5/work/t4/info.bin.out`, both runs):

```
{"qinit":{"version":"0.0.0","binary":" · tick 77700081 · epoch 229"},
 "core":{"checkout":"…/qinit-v0.0.47/core-headers","qpiHeader":"…/qpi.h"}}
```

The same command under `bun run dev` in the same second, and the binary on nine later runs, emit the full
document: keys `["compiler","core","qinit","runtime"]`, `qinit.binary` = the executable path,
`runtime.node` = `"up · tick N · epoch 229"`. In the bad document the `compiler` and `runtime` sections are
absent and `qinit.binary` holds the tail of `runtime.node`. Not reproduced in isolation; filed as a
candidate in the document assembly, not as a confirmed defect. The harness is `bin/suite`-style
`row() { … > $OUT/$name.bin.out 2>&1 }` in `~/Projects/qinit-c5/work/t4/`.

### F30 (extension) — `qinit node run --runtime <other>` replaces a running node of the other backend and discards its contracts with `ok:true` and no notice

F30 is "restart discards everything". The sibling: with a **core** node up holding four contracts,
`qinit node run --runtime simulator` (and the reverse) kills it, launches the other backend, and reports:

```
{"ok":true,"runtime":"simulator (in-process)","tick":"3002","contracts":"(none)","error":null}
# human: ✓ node running    launched pid 926293, ticking at 77700002 … contracts (none)
```

`qinit test --runtime core` against a ticking simulator does the same (`✓ node launched core node`).
`docs/cli-guide.md` §12 documents that a backend mismatch forces a relaunch; neither road says that a
node was stopped or that `PWide@29, PCounter@30, PHashmap@31, PAsset@32` are gone. A stale
`~/.config/qinit/runtime` (the persisted default) is enough to trigger it without typing `--runtime`.

### F47 (extension) — `call --trace --json` still carries the state diff as rendered text

F47 was fixed for `out` and for `state --json` field values (`acb6b263`). The trace rows are the remaining
road: `"state":[{"label":"h1","detail":"h1","text":"0 → {a: 1, b: 77, c: 2, d: 3, e: 4}"}]` — the before and
after values exist only inside `text`, with the unquoted-key struct syntax and the `→` glyph.

### Cosmetic — `self-update --dry-run` concatenates two labels

```
• latest qinit-cli-v0.1.12current v0.0.0
```

(`latest …` and `current …` are rendered with no separator.) The dry run itself is correct: it prints the
asset URL and replaces nothing.

### F64 — a CLI killed mid-upload leaves the node refusing every later deploy, with a message that tells the developer to wait for something that never completes

Severity: **high (one dead client wedges deployment for every client until the node is restarted)**.

How it happened: a probe side-effect, not a developer workflow — during the F60 width check a
`qinit test --runtime core` running in tmux was killed while its deploy step was between chunk 0 and
chunk 1 of a 15-chunk upload. It then reproduced deterministically (below), which is the point. From then on:

```
qinit deploy contracts/PWide.h --compiler clang --json
# {"ok":false,"error":"another contract upload is active (session 9832066150880345479, 1/15 chunks); wait for it to complete"}
curl -s http://127.0.0.1:41841/live/v1/dyn-upload
# {"active":true,"chunkCount":15,"receivedCount":1,"missingCount":14,"missing":[1,…,14],
#  "sessionId":"9832066150880345479","totalSize":15063,"complete":false}
qinit test …        # ✗ deploy   another contract upload is ac…ks); wait for it to complete
```

Every deploy, from any project and any client, is refused for as long as the node runs — ten samples over
**9 minutes** (30 s then 45 s apart, `~/Projects/qinit-c5/work/stuck-upload-wait.log`) all returned the same
refusal while the node ticked from 77700342 to 77700553; this is not a halt.

Deterministic repro (`~/Projects/qinit-c5/bin/repro-F64.sh`): fresh core node, `qinit deploy` in tmux, poll
`GET /live/v1/dyn-upload` and kill the tmux session the instant `active:true`:

```
killed the CLI at {"receivedCount":0,"chunkCount":18,"sessionId":"5576161678251381396"}
node view:        {"active":true,"receivedCount":0,"chunkCount":18,"complete":false}
next deploy:      {"ok":false,"error":"another contract upload is active (session 5576161678251381396, 1/18 chunks); wait for it to complete"}
after --restart:  {"ok":true} {"ok":true,"slot":29}
```

Why it never clears — both sides, read before filing:
- node (`core-lite src/extensions/wasm/runtime/deployment.h`, `beginModuleUpload`): a new `UploadBegin`
  is rejected while `moduleUpload.active` (`LITEDYN: UploadBegin rejected; session N is active`), and
  there is no expiry, timeout or abandon path for a session that stops receiving chunks (no such code in
  `src/extensions/wasm`);
- CLI (`packages/cli/src/ops/deploy/upload.ts:78-82`, `:171-174`): on a foreign active session it returns
  `activeUploadError()` and stops; there is no abort route to call, no `--force`, and no resume of a
  session the CLI itself did not start. No signal handling was found in the deploy path (grep for
  `SIGINT`/`SIGHUP`/`beforeExit` in `index.tsx`, `app.tsx`, `project-deploy.ts`, the RPC client), so an
  interrupted deploy leaves the session half-sent by construction.

The only way out is `qinit node run --restart`, which on the simulator (F30) and on core (C2's reuse
rows) also discards every deployed contract. The error text — "wait for it to complete" — is wrong for
the only case in which a developer will ever see it from a single-user workstation.

Where the fix belongs is a core-lite question (expire a session after N ticks without a chunk, or let a
new `UploadBegin` replace a stale one); the CLI could at least say that the session is stale
(`receivedCount` has not moved) and name the restart.

## Verified correct (oracle-checked, no defect)

- **T4, binary vs `bun run dev`** (`docs/cli-guide.md` §20 suspects): 22 rows through both roads —
  `version`, `help call`, an unknown command, `ls/state/call/build(clang,ts)/verify/node status/tick/epoch
  --json`, `strip`, `doctor`, `cheat-sheet`, `system ls`, `seed --show`, `gen`, a bad flag, `explorer`
  without a TTY — **20 identical** after normalising paths/timings/ticks (same stdout, same exit code).
  The two differences are F63 (the `info` document, 2/2 in-harness, 0/13 outside) and `system ls` piped text carrying a variable
  number of repeated Ink frames (28/28/53/48 `available` lines for 28 contracts — no JSON road, F24).
- **T6, the global debug toggle**: with `qinit debug PWide` open in tmux, a second client's
  `call --proc … --trace` still captured (2 state rows, caller present), the TUI showed the new frame, a
  third client traced as well, and after `q` the trace still captured — no interference observed on core.
  Caveat: every client here *added* a reader; the interference §19 warns of is a client turning capture
  *off* (`qinit test` sets `setDebug(false)` on its private simulator). Traces taken after the C2 runs that
  reused the shared core node still captured, but none was taken *during* one.
- **T5**: `QINIT_BIN=<sandbox> sh install.sh` installed the released `qinit-cli-v0.1.12` in 71 s, ran
  `setup` (which reused the real cache's `qinit-v0.0.46` node rather than fetching `v0.0.47`) and printed
  the PATH hint; no rc file was edited. `install.ps1` reviewed read-only: `%LOCALAPPDATA%\qinit\bin` or
  `$env:QINIT_BIN`, appends to the user `Path` — no Windows host, not executed (as in C2).
- **System contracts on core**: `system add QX` → `already embedded by the core node`, `system rm QX` →
  `removed from simulator startup; still embedded by core`, `qinit.json.system` follows; `call --fn QX
  Fees` answers `0/0/0` (F39, known).
- **C2, `qinit test` on core** (`qinit-v0.0.47`, node reused): `counter` 1 pass / 4 expect in 10 s,
  `hashmap` 11 s, `asset` 13 s — each deploys into the running node and runs its shipped spec; the
  spec's `--runtime simulator` road starts a private in-process node on a random port without disturbing
  the running core node.
- **C3 corpus**: `gtest --corpus QUTIL --core-dir ~/Projects/qubic-core-lite` 51/51 in 42 s; without
  `--core-dir` it refuses with `QUTIL has no test/contract_*.cpp in core-lite` and exits **1**; an unknown
  name exits 1 with `unknown contract 'NOPE'`. (Earlier "exit 0" readings were `tail`'s status — ground rule 6.)
- **T3 reuse**: `node run --runtime core` against an already-ticking core node reuses it and keeps all
  four deployed contracts.
- **T6 slot race**: two `deploy`s launched in the same instant both chose slot 29; the node accepted the
  first and refused the second loudly — `slot 29 is occupied by 'PPad', not 'PArr'` — no overwrite, no
  silent success.
- **T1 lifecycle in a sandbox** (`QINIT_CACHE`, copied binary): `setup --force` from an empty cache in
  30–43 s fetches headers + node `qinit-v0.0.47`, the WASI SDK and the verifier; `clean --dry-run` on an
  empty cache says `would free 0B`; a real `clean` under a sandbox `QINIT_CACHE` wiped only that cache and
  left the node running from the real cache untouched (it is not tracked there); `uninstall --dry-run`
  names only the running copy and its cache; `uninstall --yes --keep-cache` removed the binary and kept
  the cache; plain `uninstall --yes` removed both. In every row `~/.config/qinit/{seed,theme,runtime,
  compiler-backend}` survived byte-for-byte and `qinit seed --show` still resolved the saved identity.
- **C1 on core** (`qinit-v0.0.47`, clang): 12/12 rows identical to the simulator cells.
- **T7, `QINIT_STATE_DIFF` as an oracle**: with the node started under `QINIT_STATE_DIFF=snapshot`
  (verified live in `/proc/<pid>/environ`), the `--trace` diff rows for a struct with two interior padding
  holes, the same struct inside an `Array<Hole,2>`, and a counter are **identical** to the default journal
  differ. A six-procedure session replayed under `QINIT_STATE_DIFF=verify` (`runtime.ts:724`, on the
  dispatch path: runs both mechanisms and throws on disagreement) passed 6/6 with no fault and the node
  still ticking.
- **F48 fix holds on the family**: `Hole { uint8 a; uint64 b; uint8 c; uint32 d; uint16 e; }` keeps every
  field after both padding holes in the diff — `h1 0 → {a: 1, b: 77, c: 2, d: 3, e: 4}` — alone and as
  `arr[0]`/`arr[1]` inside an array.
- **The `local` system-wasm cache key does not serve stale code** (§19 warns it might): editing
  `QUtil.h` in a checkout and re-running `qinit system add QUTIL` recompiled it
  (`34ad50ed…` → `6105d10d…`) while its unchanged dependency reported `QX @ 1 unchanged`.
- **`feeReserve` is live on the simulator**: `ls --json` reports `99378192520`-scale reserves, i.e. the
  new 1e11 dev seed from `a609ab02`. On core it is unreachable — no released node carries `b2e03720`.
- **C6, strip vs `--production`**: byte-identical artifacts (k12 `0e2225b1…`, 17 835 B) on clang.
- **C1 write road**: `Store` of the two extreme vectors, read back with `state --dump`, is byte-exact
  against the Python `struct.pack` oracle (112 B of `Vals`, 128 B of state) on both compilers.
- **`state --digest` == K12 of `state --dump`** (`18f90dc0…`, 128 B).
- **clang and TypeScript IDLs are identical** for the wide-type probe (`diff` of the sorted `.idl`), and
  C1 passes 12/12 on the TypeScript backend too.

- **C1 read road, all four cells pending core**: `Echo` round-trips every scalar width identically on
  three roads — `--args` JSON, `--in` braced spelling, and the `qinit gen` client — for `UINT64_MAX`,
  `INT64_MIN`, 2^53−1 / 2^53 / 2^53+1, `uint128` max (2^128−1), `uint32/16/8` and their signed twins at
  their limits, a 4-element `Array<uint64,4>`, and `bit`. 12/12 rows equal to a Python `struct.pack`
  oracle built from clang's own offsets (`u128@0 id@16 u64@48 s64@56 arr@64 u32@96 s32@100 u16@104
  s16@106 u8@108 s8@109 b@110`, size 112).
- **`--amount` after the F51 fix**: `1e3`, `0x10`, `5.0`, `5qu`, `' 5'` and `18446744073709551615` are
  all rejected with `--amount must be a whole number of qu` / `exceeds the signed 64-bit range`. F51 is
  closed on this road.
- **identity checksums are validated** on `--args`: a 60-char uppercase identity with one data character
  changed is rejected rather than silently decoded.

## Compiler × runtime matrix (computed values)

Probe `PWide.Echo` round-trip, 4 vectors × 3 roads (`--args`, `--in`, gen client), Python oracle:

| value | clang×sim | ts×sim | clang×core | ts×core |
|---|---|---|---|---|
| `u64 = 18446744073709551615` | 18446744073709551615 | same | same | same |
| `s64 = -9223372036854775808` | -9223372036854775808 | same | same | same |
| `u128 = 2^128−1` | 340282366920938463463374607431768211455 | same | same | same |
| `arr = [2^53−1, 2^53, 2^53+1, 2^64−1]` | exact | exact | exact | exact |
| `u32/s32/u16/s16/u8/s8/bit` at their limits | exact | exact | exact | exact |
| C1 rows | 12/12 | 12/12 | 12/12 | 12/12 |
| `Store` bytes vs oracle (`state --dump`) | 112/112 ×2 | 112/112 ×2 | — | — |
| F55 (`--amount` > balance) | reproduced | reproduced | reproduced (1e10 balance) | reproduced |
| IDL clang vs ts | identical | | | |
| strip vs `--production` k12 | `0e2225b1…` both | — | — | — |
| journal vs snapshot diff | identical (+ `verify` 6/6) | — | — | — |

Node: simulator in-process (`qinit-v0.0.46` headers for the sim cells run from the real cache;
`qinit-v0.0.47` headers + node for the core cells from the sandbox cache). `feeReserve` reported on the
simulator only.

## Suite counts (commands, exit codes as observed)

| suite | rows | result |
|---|---|---|
| C1 parity | 48 (12 × 4 cells) + 2 byte rows + 12 amount rows | 48 OK, 2 OK; F55 |
| C6 strip/production | 3 builds + 2 calls + 1 integrate | hashes equal; F45 ext |
| T7 state-diff | 1 pair + 6 verify-mode procs | identical; 6/6 exit 0 |
| T2 staleness | 2 drift rows × (status, doctor, build) + 1 wasm-recompile row | F56; recompile OK |
| T1 lifecycle | setup ×2 (30 s, 43 s), clean ×3, uninstall ×3 | all exit 0; config byte-identical; F58 |
| T3 node | reuse, backend switch ×2, `--history-ticks 20` + explorer ×3 | F30 ext; pruning honest |
| T4 binary vs dev | 22 rows | 20 same; F63 (2/2 in-harness, 0/13 outside); frames |
| T6 two clients | slot race (2 deploys), debug toggle (3 traces) | loud reject; no interference |
| C2 `qinit test` core | 4 templates | 3 pass (exit 0), 1 exit 1 (F60); sim control pass |
| C3 gtest | 5 project, 2 `--new`, corpus QUTIL, 2 corpus negatives | 51/51 corpus; F59, F61; exits 1 on both negatives |
| T5 distribution | install.sh ×1 (71 s), self-update dry-run ×1 | exit 0; cosmetic |
| C4 vscode ext | — | **skipped** — installs into the user's editor; not run without an explicit go-ahead |
| C5 browser bundle | — | **skipped** — `~/Projects/Qinit-web` absent |

Sandbox integrity at the end: `~/.config/qinit/*` byte-identical to the step-0 backup;
`~/.cache/qinit/current.json` differs only in `syncedAt`/`verifyCheckedAt` — written by `install.sh`'s
post-install `setup`, which I ran without `QINIT_CACHE` (probe omission, recorded). No other file in the
real cache changed. All nodes stopped.

Harness: `~/Projects/qinit-c5/bin/{suite-C1.sh,vectors.py,lib.sh,cell.sh,k12.py}`, probes in
`~/Projects/qinit-c5/work/{PWide,PArr,PPad,PCheat,P*}`, raw outputs per row under `work/c1-*`, `work/t4`.

## Index

F55 money no-op · F56 doctor drift · F57 ls envelope · F58 clean size · F59 vacuous gtest · F60 slot
diagnostic + elision · F61 uint128 scaffold · F62 tick/epoch show · F63 info json race · F64 stuck upload session ·
extensions: F9, F24, F30, F45, F47.
