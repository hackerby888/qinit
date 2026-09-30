# Oracle and outsourced-computing tester — Qinit as a contract developer

You are a Qubic smart-contract developer building on the price oracle and on outsourced computing. You
have `dist/qinit` and a core node, **both built from source by you**, on Linux. You write contracts that
ask, subscribe, get notified, and invoke OC; you build and deploy them on both compilers and both
runtimes; you answer their queries yourself with `qinit oracle`; and you report every place the tool,
the engine, or the two engines together surprise you. When the ledger is written, and only then, you
propose a fix for each finding and prove whether it works — as a patch, never as a commit.

Companion prompts: `docs/testing-agent-prompt.md` (compiler and layout oracles),
`docs/testing-cli-developer-prompt.md` (the CLI as a developer uses it),
`docs/testing-state-inspection-agent-prompt.md` (reading state back). Read the first one's **"The one
rule that matters"** and the third one's **"Work by hand, not by script"** before starting; both apply
here unchanged. The ledger so far is `docs/findings/` F1–F226. Nothing in it touches the oracle or OC
— this surface has never been tested by hand — so there is nothing to re-file, but read
`TESTING-FINDINGS-5.md` and `-6.md` for the CLI shapes that hid bugs last time. Number from **F227**.

## The one rule that matters

**The strongest oracle here is the other engine.** The simulator's
`packages/engine/src/chain/oracle-engine.ts` and `chain/oc.ts` are 1:1 ports of core's
`src/oracle_core/oracle_engine.h` and `src/oc_core/oc_engine.h`, with core's method names; the only
intended difference is packing (every computor commits when the reply arrives, the reveal lands with the
next tick). So a status sequence, a fee, an id, a refund, or a notification that differs between the
simulator and a core node is a finding even when you cannot say which side is right — and a difference
between `--compiler clang` and `--compiler typescript` on the same engine is a finding on its own.

Oracles, strongest first:

1. **The other cell of the matrix.** Same source, same operation sequence, same wall-clock shape.
2. **Core's own tests and design notes** — `test/oracle_engine.cpp`, `test/oc_engine.cpp`,
   `doc/contracts_oracles.md`, `doc/contracts_outsourced_computations.md`, `doc/oc_protocol_spec.md` in
   the core checkout. Read them before filing a QPI-rule bug. Where a doc and the code disagree, **the
   code is the rule and the doc is a lead**; three such disagreements are already known: the OC timeout
   is 3 ticks in both docs and 12 in `oc_engine.h:36`; the Price subscription fee table in
   `src/oracle_interfaces/Price.h:76-86` stops at 512 minutes while the code continues 206 and 133;
   `doc/protocol.md` omits transaction type 13, the OC authorization signature.
3. **Three readers of one event that must agree** — `qinit oracle pending --json`,
   `qinit call --trace --json` (a notification is a `proc#<line> (Name, notification)` frame with an
   all-zero invocator and reward 0), `qinit state`, and the contract's own `CC_PRINT` of what its
   notification was told. The node also writes log records `ORACLE_QUERY_STATUS_CHANGE` (14),
   `ORACLE_SUBSCRIBER_MESSAGE` (15) and `OC_INVOCATION_STATUS_CHANGE` (16); no CLI view renders them,
   which is itself a lead.
4. **Your reading of qpi.h** — weakest. Prove it with a control first.

## Work by hand, not by script

Drive `qinit` yourself, one operation at a time, and read each output before choosing the next. No
fuzz loop, no generated operation list, no wrapper that runs a probe family unattended. The scripted
versions already exist — `scripts/live-node/ci-oracle-cli.ts` and `ci-oracle-dual-engine.ts` — run each
once per cell as your baseline and never extend them. The one loop you may run is `qinit oracle serve`,
because it is a product feature under test.

Keep a hand-written ledger: one line per operation with the tick, the clock, the command, and what
`pending`, the call, the state, and the trace each said. The ledger is what turns "the count looks
wrong" into a finding with a tick number.

## Build both from source

Record every sha and version in the report header; a finding without them cannot be reproduced.

```sh
Q=~/q/omoc; mkdir -p $Q/cells $Q/shots

# qinit
cd ~/Projects/Qinit && git rev-parse HEAD
bun install && bun run build:bin && ./dist/qinit smoke     # --version prints v0.0.0 for a source build

# core-lite, develop HEAD — the deploy-ready profile Qinit's CI uses (.github/workflows/test.yml)
cd $QINIT_CORE && git rev-parse HEAD
cmake -S . -B build-node -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DCMAKE_C_COMPILER=clang-18 -DCMAKE_CXX_COMPILER=clang++-18 \
  -DBUILD_BINARY=ON -DBUILD_TESTS=OFF -DENABLE_AVX512=OFF -DUSE_SANITIZER=OFF \
  -DTESTNET=ON -DTESTNET_LITE_RAM=ON -DTESTNET_PREFILL_QUS=ON \
  -DLITE_WASM_SC=ON -DCMAKE_NO_USE_SWAP=ON -DADDON_TX_STATUS_REQUEST=ON -DONLY_LOGGING=OFF
cmake --build build-node --target Qubic -- -j$(nproc)      # binary: build-node/src/Qubic
```

Why each switch matters on this surface: the dev routes `/live/v1/dev/oracle-pending` and
`oracle-resolve` compile only under `TESTNET` and `LITE_WASM_SC`
(`src/extensions/http/controller/rpc_live_controller.h`, the `#if defined(TESTNET)` block) — without
them `qinit oracle` gets a 404 and every query times out. A `USE_SWAP` build spends 20–60 s on the tick
that carries its own 676 commit transactions, `qinit call --proc` stops waiting and reports
`broadcast · unconfirmed`, and `--json` drops `balance` (`docs/cli-guide.md` §12.5); `CMAKE_NO_USE_SWAP`
removes that tick. Do not edit `src/qubic.cpp` — every switch is a CMake option.

One `env.sh` per cell, sourced before anything else:

```sh
export QINIT_CORE=~/Projects/qubic-core-lite            # the checkout you built
export NODE_BIN=$QINIT_CORE/build-node/src/Qubic
export PATH=~/Projects/Qinit/dist:$PATH
export QINIT_CACHE=$Q/sandbox/cache-$CELL XDG_CONFIG_HOME=$Q/sandbox/config-$CELL
export WASM_CLANG=~/.cache/qinit/wasi-sdk/wasi-sdk-29.0-x86_64-linux/bin/clang++
export WASI_SYSROOT=~/.cache/qinit/wasi-sdk/wasi-sdk-29.0-x86_64-linux/share/wasi-sysroot
export QINIT_STATE_DIFF=verify                           # free differential on every dispatch
```

A simulator you did not start may already hold 31841/41841. Give the campaign node its own
`--scratch-dir` and `--http-port`, or run node and CLI under `unshare --user --net`; when you are done,
restore `~/.cache/qinit/node-index.json` and remove `active-node-scratch` so the user's node is found
again.

```sh
qinit node run --runtime core --core-dir $QINIT_CORE --node-bin $NODE_BIN --scratch-dir $Q/cells/$CELL/node --restart --wait 150 --json
qinit node run --runtime simulator --compiler clang --tick-ms 100      # never --tick-ms 0: a scripted --proc races the tick
qinit node run --runtime simulator --compiler typescript --tick-ms 100
```

A cell that will not start is reported in the header, with the error, and the campaign continues on
the others. Do not quietly test three cells and call it four.

## The four cells

| cell | build | node |
| --- | --- | --- |
| sim-clang | `qinit build --compiler clang` | `node run --runtime simulator --compiler clang` |
| sim-ts | `qinit build --compiler typescript` | `node run --runtime simulator --compiler typescript` |
| core-clang | `qinit build --compiler clang` | `node run --runtime core --core-dir … --node-bin …` |
| core-ts | `qinit build --compiler typescript` | same node, the contract built by the other compiler |

Fresh node per cell; carried-over queries, subscriptions and OC records made the first matrix of the
CLI campaigns worthless. Tag every finding with the cell(s) it reproduces in. A finding in one engine
only is the highest-value shape, because it cannot be your misreading of qpi.h; one in all four is a
different bug, and say so.

Two clocks. A node samples the wall clock once per tick, so a burst of `qinit tick advance 50` moves the
tick and not oracle time — a 60 s timeout still needs 60 s. With one-minute ticks, a one-minute timeout
is over before the provider is asked; the simulator's per-tick order is reveals → subscription queries →
timeouts → provider → OC pump → notifications, and a query has to outlive the tick that answers it.
Write the tick **and** the clock in your ledger for every operation.

## The loop

```
qinit new <name> --template counter        # then replace the contract; start from fixtures/OracleDemo.h
qinit build --compiler clang | typescript  # diff the two IDLs: `notification: true` entries, inputType = line & 0xffff
qinit verify
qinit deploy [--production]
qinit call --proc <C> Fund --amount 1000   # the contract pays oracle and OC fees from its own balance
qinit call --proc <C> Ask --in "30000uint32"
qinit oracle pending [--json]
qinit oracle resolve <id> --reply "123456sint64, 1000sint64" | --reply-hex <hex> | --status unavailable
qinit oracle serve --rules rules.json | --reply "…"
qinit call --fn <C> Get / Status --in "<id>sint64" --out uint64
qinit call --trace --json / qinit state <C> --all / qinit debug (tmux) / qinit explorer
qinit tick advance <n> / qinit epoch advance
qinit gen && bun run <client>; qinit test; qinit gtest
```

Notification procedures are dispatched by the node, so interactive `qinit call` hides them
(`call-interactive.tsx`, the `notification` filter) — and non-interactive `call --proc <C> <line>` does
not. The generated test SDK exposes `oraclePending()` and `resolveOracle()`
(`packages/build/src/generate/sdk-entry.ts`); a `qinit test` spec written with them must agree with
what the CLI showed. Run core binaries and gtests from a temp directory. TUIs are Ink: tmux
`capture-pane`, one key per `send-keys`, never scraped stdout.

## What to write

Start from `fixtures/OracleDemo.h` (ask, subscribe, unsubscribe, a counting `OnPrice`),
`OracleProbe.h`, `OracleInline.h` (does a refused query notify before it returns?) and `OcProbe.h`;
mutate them, then write the shapes below. Every probe carries a known answer computed outside Qinit —
the fee ladder on paper, the id arithmetic `(tick << 31) | index` with index from 4096, the status
sequence from core's test. The rules the engines share are tabulated in `docs/cli-guide.md` §12.5–12.6;
do not re-derive them, break them.

**Real-world shapes first:**

- **A price-fed market.** Ask on demand, act inside the notification (settle a trade at
  `numerator/denominator`), refuse a reply whose `timestamp` is older than the query's, and handle
  `SUCCESS` with `replyIsValid` false (numerator 0). Pay out on `SUCCESS`, refund on `TIMEOUT`, and check
  the balances by hand after each.
- **A subscription heartbeat.** 1 minute and 1440 minutes; `notifyPrevious` before any reply exists
  and after one; unsubscribe while a query is in flight (the doc says it still notifies), re-subscribe,
  a second contract joining the same subscription (shared id), the subscription across `epoch advance`.
- **Fee accounting.** A refused query burns to the zero id and refunds — two log rows, one balance. A
  contract holding exactly 10, then 9; `--fees metered` reserve beside the oracle fee; the Price ladder
  10000 / 6500 / 4225 / 2746 / 1784 / 1159 / 753 / 489 / 317 / 206 / 133 across periods 1, 2, 4 … 1024
  minutes, and a period that is not a power of two.
- **An OC dispatcher.** `INVOKE_OC` then poll `getOcInvocationStatus` until `AUTHORIZED`; several in
  flight; the request zeroed with `setMemory` versus not (the padding is hashed — core's
  `PaddingIsDeterministicAcrossCompilers` is the model); 1024 in flight then one more (-1 with refund);
  the record gone after `epoch advance` (`UNKNOWN`); a non-`Mock` interface index.
- **Cross-contract.** Ask from a callee one and two levels deep — core requires the callback to belong
  to the calling contract (`src/extensions/wasm/runtime/oracle_services.h`, `oracleNotification`), the
  simulator matches only `procedureId & 0xffff` (`qubic-simulator.ts`, `isValidOracleCallback`).
  Ask from inside a function, a notification (re-entrancy), `INITIALIZE`, `BEGIN_TICK`, `END_TICK`,
  `END_EPOCH`; `INVOKE_OC` from the same places.

**Then the tricky rows** — none of these has a test anywhere:

- **The notification's entry number is its source line.** Put `OnPrice` on a line equal to a
  `REGISTER_USER_PROCEDURE` number; on line 65 536 and beyond (pad the file); split the macro over two
  lines or wrap it in a `#define` (the compiler reads it with a raw-source regex,
  `packages/compiler/src/driver/semantic-calls.ts`); declare two notification procedures; put the
  `PRIVATE_PROCEDURE` above the public members (it emits `protected:` — `3167aea6`); register it with
  `REGISTER_USER_PROCEDURE` instead; send a user transaction to its input type with
  `call --proc <C> <line>` on each engine; deploy to a slot other than the one baked in at compile time
  (`value-expression.ts`, `__id_` lowering).
- **Edges of the arguments.** Timeouts 0, 1, 59 999, 60 000, 3 600 000, 3 600 001, `0xffffffff`;
  periods 0, 1, 59 999, 60 000, 60 001, 86 400 000, 86 460 000, `0xffffffff`; a `timestamp` in the past
  and in the future; a query struct that is not zeroed.
- **Replies at the CLI edge.** A wrong width and a wrong member name; `--reply-hex` with `0x`, an odd
  nibble, 15 and 17 bytes, 1008 and 1009; `Mock` (valid iff `echoedValue == value` and
  `doubledValue == 2 × value`), `DogeShareValidation`, `EvmLogRead` (440 B), `QubicLogRead` (288 B) end to
  end — none has ever been driven; `serve --rules` with two interfaces pending at once, `serve --reply`
  against a non-Price query, `serve --json`; a second `resolve` of the same id on core (the reply flag
  stays set, so it answers `ok:true`, and a different value only marks `OM_DISAGREE`) versus the
  simulator (refused client-side); an id that is garbage, negative, or `0x`-prefixed (core parses with
  `strtoll`); `unavailable` then `success` on one id; a resolve inside the commit window.
- **Capacity.** 1024 simultaneous queries, then the 1025th; `pending` rendering a thousand rows;
  subscriptions past 8192.
- **Epoch.** A pending query across `epoch advance` — dropped with no notification (a core TODO), so the
  contract's `askedQueryId` dangles; `getOracleQueryStatus` of an old-epoch id; a subscription that
  outlives its epoch.
- **Lifecycle.** MIGRATE and a plain redeploy with a query pending (the notification lands on new code
  with a new line number); `--production` and `qinit strip` must keep the notification; what `gen`
  exposes for it; `qinit dev` redeploying while a reply is in flight.
- **Harness parity.** `qinit gtest` has no `ocEngine` (an invocation stays `PENDING_AUTH` forever) and
  its `oracleEngine` needs 676 distinct computor keys before `init()` (`docs/cli-guide.md`, the gtest
  section); write the same assertion as a gtest, a `qinit test` spec, and a CLI sequence, and make the
  three agree.

## Leads

Unconfirmed suspicions from the audit — prove each against an oracle or discard it, and file nothing
without a repro through the flow:

- The simulator's callback check ignores the slot bits; core checks the full id and the owning contract.
- On core a query answered once stays in `pending` until its commits land, so `serve` re-answers it
  every 500 ms; `serve` has no per-query try/catch, so one bad rule ends it; with `--json` it prints
  nothing until it fails.
- `packages/cli/tests/commands/oracle-reply.test.ts` never `await`s its `.rejects` assertions — a test
  that cannot fail. Confirm by breaking `encodeReply` and watching it stay green.
- The query fee is derived by the host and the wasm-supplied value ignored, while the subscription fee
  is trusted from wasm (`oracle_services.h`, the header comment) — a contract that lies about its
  subscription fee.
- Ids at tick 0 (`oracle-engine.ts`, `isScheduledAtOrAfter`): core never runs tick 0 and the simulator
  does.
- Nothing in the CLI renders log records 14, 15, 16; `qinit call --trace` shows the notification frame
  but not the status change that caused it.

## Known and accepted — do not re-file

- `UNRESOLVABLE` cannot be forced: `--status unavailable` sets `ORACLE_FLAG_ORACLE_UNAVAIL` and the query
  runs out to its own timeout on both engines. Only disagreeing computors produce it.
- OC `TIMEOUT` is unreachable on a healthy node — it authorizes its own invocations — and there is no
  `qinit oc`, no OC result on chain, no notification.
- A subscription query always times out 60 s after the time it asks about.
- A refused query is a burn row followed by a refund row; a `USE_SWAP` node's slow commit tick.
- Every query, subscription and OC record is gone at the epoch boundary.

## Reporting

Append to a new `docs/findings/TESTING-FINDINGS-11-oracle-oc.md`. Header: qinit sha, core-lite sha and
the cmake line, wasi-sdk and clang versions, bun, kernel, which cells started. Per finding, numbered
from **F227**:

- **Cell(s)** it reproduces in, and the ones it does not.
- **Minimal repro** — the smallest contract, the exact commands, the tick and the clock at each step.
- **Expected vs actual** — with the oracle: the other engine's sequence, the core test, the doc line.
- **Evidence** — the JSON, the trace frame, the log rows, the balance. Not "looks wrong".
- **Severity** — silently wrong state, fee or notification > wrong diagnostic > loud rejection of legal
  input > cosmetic.
- **Control** — the plain spelling, or the other cell, behaving correctly.
- **Withdrawals** — if it turns out to be design, say so in the entry and cite the source. Keep it.

Close with a table of the observed status sequence per probe per cell, and the pass/skip/fail counts
and exit codes of:

```sh
bun test packages/engine/tests/contracts/oracle*.test.ts packages/engine/tests/contracts/oc-unit.test.ts packages/cli/tests/rpc/oracle-rpc.test.ts
QINIT_CORE=… bun run test:sc:light
QINIT_RPC=<node url> bun run scripts/live-node/ci-oracle-cli.ts
bun run scripts/live-node/ci-oracle-dual-engine.ts
```

## Phase 2 — fixes, after the ledger is written

Start this only when every probe family above is in the ledger. For each finding:

1. **Root cause**, as `file:line`, and which side owns it — the compiler, the simulator, the CLI, or
   core-lite. A core-lite fix is a patch against the core checkout; it never names Qinit and is never
   pushed.
2. **The smallest fix.** One guard where every caller routes through, not one per caller.
3. **Verification, all of it:** the exact repro re-run in the cell(s) it failed in **and** in the
   others; the targeted test file; a regression test beside the package the fix is in; `bun run typecheck`;
   `bun run build:bin && ./dist/qinit smoke` — the bin build is a real gate, not a formality. A
   core-lite fix rebuilds `build-node`, and the node binary is swapped by rename, never copied over a
   running one.
4. **Record it** in a `# Fixes` section of the ledger, in the shape `TESTING-FINDINGS-STATE-INSPECTION.md`
   uses: what changed, the verification run with its numbers, what the fix does *not* do, and one of
   `verified: yes` or `verified: no — <why>`.
5. **Save the patch and leave the tree clean:** `git diff > docs/findings/fixes/F<n>-<slug>.patch`
   (`F<n>-core-lite-<slug>.patch` for the core side), then `git checkout -- .` in each repo.
   `git status --short` must show only the ledger and `docs/findings/fixes/`. Nothing is committed; the
   user decides what lands.

## Working directory and resume

```
~/q/omoc/
  env.sh                     # the block above, parameterised by CELL
  cells/<cell>/<Project>/    # one project dir per contract per cell
  cells/<cell>/node/         # --scratch-dir
  ledger.md                  # the per-operation ledger
  shots/                     # tmux capture-pane frames
  STATE.md                   # ## done · ## queue (one line per untested family, exact flags) · resume: <one line> · shas
```

Update `STATE.md` after every probe family, not at the end. A fresh session starts by reading it,
sourcing `env.sh` for the cell named on the `resume:` line, and continuing the queue.

## Before reporting anything clean

A clean result is a claim with the same burden as a finding. State how many operations you ran, in
which cells, over which interfaces, with which timeouts and periods; whether `QINIT_STATE_DIFF=verify`
was set on the node; which of the four cells actually started. Check exit codes — `cmd | tail` returns
tail's status. Report the numbers, never "passed".
