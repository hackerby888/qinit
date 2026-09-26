# State and state-diff inspection agent — Qinit

You have **5 hours**. You are hunting four failure classes in how Qinit _reads back_ contract
state, through real deploy-and-invoke flows on a running node:

1. **Abnormal parsing** — a field or row that renders as `undefined`, `[]`, `0`, `(read failed: …)`,
   or raw hex where a decoded value belongs.
2. **Missing records** — a container entry that exists in the state bytes but never appears in a view.
3. **Missing diffs** — a byte that changed with no row naming it.
4. **Incorrect parsing** — a rendered value the raw bytes do not support, or a row labelled by the
   wrong field, element, or key.

Companion prompts: `docs/testing-agent-prompt.md` (compiler semantics), `docs/testing-cli-developer-prompt.md`
(CLI as a developer uses it). Read the first one's **"The one rule that matters"** section before starting —
it applies here unchanged.

**Do not fix anything. Do not commit anything. Report and stop.**

## Work by hand, not by script

Drive `qinit` yourself, one operation at a time, and read each output before choosing the next. Do **not**
write a fuzz loop or a generated operation list.

This is a deliberate constraint, not a stylistic one. A script asserts only what you thought to assert in
advance; the bugs in this layer look like a row that is merely _odd_ — a plausible number, a label naming the
bucket instead of the key, a container that reads "empty" — and they are caught by a person noticing that a
frame does not match what they just did. `packages/compiler/tests/differential/container-parity.test.ts` and
`container-view-native.test.ts` already do the scripted version (seeded operation sequences, WAMR vs
TypeScript), so repeating it adds nothing.

Keep a hand-written ledger as you go: one line per operation with what you sent and what each view said.
The ledger is what makes the conservation check below possible.

## What is already covered, and what is not

Covered by CI, do not re-test: container **semantics** across runtimes (`container-parity.test.ts`, seeded
op sequences), and `createQpiContainerView` against native WAMR-executed state at fixed checkpoints
(`container-view-native.test.ts`).

**Not covered anywhere:** `packages/cli/src/trace/state-diff.ts` (the diff rows) has no cross-runtime or
cross-compiler coverage at all, and `state-read.ts` / `state-format.ts` rendering is only unit-tested against
hand-written expectations. That is your target.

## Oracles, strongest first

1. **`QINIT_STATE_DIFF=verify`** — runs the write-journal and copy-snapshot diff mechanisms on _every_
   dispatch and **throws on disagreement** (`packages/engine/src/contract/runtime.ts:34`). Set it on the node
   for your whole session. It is a free differential and it fires where the divergence happened, not three
   views later. Also run a second pass with `QINIT_STATE_DIFF=snapshot` (ignores the journal entirely): any
   row that differs between the two modes is a finding on its own.
2. **Raw bytes.** `qinit state <C> --dump` writes the state to `state/<Name>_dump.bin`. With the field
   offsets from the IDL (`qinit.idl.json`), decode a value by hand and compare it to the rendered one. The
   bytes are the ground truth; every view is a hypothesis about them.
3. **The conservation check — your best tool for "missing diffs".** From a known state, run N operations,
   capturing the diff rows of each (`qinit call --trace --json`, field `state[]`). Applying every row in
   order to the starting bytes must reproduce `qinit state --all` exactly. A byte that moved with no row
   naming it is failure class 3; a row that does not correspond to a byte that moved is class 4.
4. **Three independent readers over the same bytes.** They must agree:
    - `qinit state <C> --all --json` — the container reader (`qpi-container-view`)
    - `qinit call --trace --json` → `state[]` — the diff reader (`state-diff.ts`)
    - `qinit state <C> --digest` — K12 over the raw state, so it changes if and only if bytes changed
      Two readers agreeing is weak evidence; the digest moving while no row appears is strong.
5. **`CC_PRINT` in the contract** — the contract's own read of its container (`state.get().bal.get(k)`)
   versus the CLI's parse of the bytes. Genuinely independent paths. See `docs/cheatcodes.md`; prints work
   under both compilers. Note they appear in the human output, **not** in `--json`.
6. **Your expectation of C++/qpi.h** — weakest. Prove it with a control first.

## The four cells — use all of them

Both compilers **and** both runtimes, same source, same operation sequence:

```
qinit node run --runtime simulator --compiler typescript
qinit node run --runtime simulator --compiler clang
qinit node run --runtime core --core-dir <core> --node-bin <bin>     # + --compiler on each build
qinit build --compiler <clang|typescript>                            # per-contract compiler choice
```

A view that renders correctly in three cells and oddly in the fourth is the highest-value finding shape
here, because it cannot be explained away as your misreading of qpi.h. Record which cell each finding is in;
if a finding reproduces in all four, say so — that is a different bug than one that does not.

Core runtime needs a core checkout and a node binary; `QINIT_CORE` and the tool paths are in the repo's
setup docs. If a cell cannot be started, say so explicitly in the report rather than quietly testing three.

## State shapes to build

One contract is not enough and a counter is useless. Build states that are hard to read back:

- **A container followed by a scalar.** `HashMap<id,uint64,8> bal; uint64 marker;` — if the container's size
  is computed wrong by even a byte, `marker` renders at the wrong offset. `fixtures/DbgMap.h` is the minimal
  version of this trick; make yours deeper.
- **Every container kind**, since each has its own member table in `packages/proto/src/qpi-layout.ts`:
  `HashMap`, `HashSet`, `Collection` (PoV priority queues — the richest internals), `LinkedList`, `BitArray`,
  `Array`.
- **Nesting.** A struct holding a container; an array of structs each holding a `BitArray`; a container whose
  value type is a struct containing an array. `holdsContainer` decides whether a struct collapses to one row,
  so a container buried two levels down is a distinct path.
- **Two containers in one state**, so a size error in the first shifts everything after it.
- **A struct whose widest member is not last**, and one with tail padding.

Capacity and lifecycle edges, per container: empty; exactly one entry; **full**; full then remove then
re-insert (tombstone reuse — the 2-bit occupation flags are `0b00` empty, `0b01` occupied, `0b10` marked for
removal, per `core/src/qpi/qpi_containers.h:327`); remove everything and re-fill; a key that hashes to an
already-occupied bucket (collision → probe chain).

## Flow discipline

Real flow only: `qinit build` → `qinit node run` → `qinit deploy` → `qinit call --proc` → inspect. No calling
`stateDiffLines` directly, no hand-built `DebugStateRegion` arrays — those are the unit tests' job and they
already pass.

- `qinit call --trace --json` emits the diff rows non-interactively (`state[]`, with `label`, `detail`,
  `text`, `internal`, `before`/`after`, `change`). Prefer it for capture.
- `--trace-full` adds container internals, `--all` shows zero and empty fields. Run both: a row hidden behind
  `internal` that should be visible, or the reverse, is a finding.
- `qinit debug` is an Ink TUI. If you need it, drive it with tmux and `capture-pane` for true frames, one key
  per `send-keys`. Do not scrape its stdout.
- Valid 60-char identities for keys, without a wallet:
  `bun -e 'import {bytesToIdentity} from "@qinit/core"; import {contractAddress} from "@qinit/proto"; console.log(await bytesToIdentity(contractAddress(30)))'`
  Avoid the all-zero id (60 `A`s) as a container key — a removed record's key bytes are zeroed, so it sits on
  an edge you do not want to confuse with a real bug.
- Run core binaries and gtests from a temp directory; they scatter files in cwd.
- `cmd | tail` returns tail's exit status. Check exit codes separately.

## Leads

These are **unconfirmed suspicions** from a code audit, not known bugs. Treat each as a hypothesis to prove
against an oracle or discard — and do not report one as a finding without a real repro through the flow.

- `state-format.ts` coerces a shape mismatch to `[]` in four places
  (`Array.isArray(value) ? value : []`, around `:142`, `:147`, `:154`, `:168`). The predicted symptom is a
  struct rendering every field as `undefined`, or a `BitArray` reading as entirely zero, where a type
  mismatch actually occurred. Try to make it happen.
- `StateField.bad` is declared (`state-format.ts:42`) and never set, so `state-read.ts`'s "undecodable"
  branch may be unreachable. If you can produce an undecodable field, see what renders.
- `state-read.ts` detects a failed read by string-matching `"read failed"` in the rendered value. A contract
  whose own data contains that text is the obvious probe.
- The container views return `[]` when the population word is `0` while occupation flags are set —
  _before_ the consistency check that would have thrown (`hash-map-view.ts` ~`:34`). Predicted symptom: a
  container with live entries rendering as empty.
- `state-diff.ts` attributes a byte past every known member to the **last** member rather than reporting it
  (the `?? layout[layout.length - 1]` fallback, ~`:171`).
- `decodeAbi` drops trailing bytes on the typed path and performs no union/overlap check on decode, though
  the encode side refuses overlapping types.
- `decode-log.ts` accepts a lone same-size catalog entry without checking the `_type` discriminator; and one
  unparseable log can empty the whole log list for an entry (`format.ts` ~`:83`).

**Known-correct, do not file:** an update whose changed window covers only the value bytes renders as
`bal.slot[6].value | 45 → 50` rather than `bal[<KEY>]`. The key sits before the window start, so it cannot be
read, and the row keeps its bucket label instead of inventing a key. This was verified against the
pre-rename binary. Likewise, an all-zero value renders as `0` by design.

## Reporting

Append findings to a new `docs/findings/TESTING-FINDINGS-STATE-INSPECTION.md`. Per finding:

- **Which of the four classes** it is, and **which of the four cells** it reproduces in.
- **Minimal repro** — smallest contract, exact commands, exact operation sequence.
- **Expected vs actual**, with the oracle that says so — raw bytes, digest, the other reader, `verify` mode.
- **Evidence** — the bytes, the row, the JSON. Not "looks wrong".
- **Severity** — silently wrong value or label is dangerous; a loud failure or a missing row you can see is
  lower tier. Say which.
- **The control that rules out your own error** — the same shape rendering correctly elsewhere.

If a probe misbehaves, suspect the probe first. Confirm your contract compiled and deployed the version you
think it did (`qinit deploy --json` reports `codeHash`; compare it to the build's).

## Suggested budget

| Time      | Work                                                                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:40 | Set up all four cells. Confirm each starts and a trivial contract deploys and calls in each. Report any cell you cannot start, then continue with the rest.                       |
| 0:40–1:30 | Build the complex-state contracts. Verify the IDL round-trips and `marker`-after-container reads correctly — this is your control.                                                |
| 1:30–3:30 | The main pass: per container kind, walk the lifecycle edges in each cell, capturing all three readers each step. Run the conservation check after every sequence, not at the end. |
| 3:30–4:20 | Chase the leads above, and anything odd you parked earlier. Second pass under `QINIT_STATE_DIFF=snapshot` and compare to the `verify` pass.                                       |
| 4:20–5:00 | Write the report. Re-run every repro from a clean node before filing it.                                                                                                          |

## Before reporting anything clean

A clean result is a claim that needs the same evidence as a finding. State how many operations you ran, in
which cells, over which container kinds, and which oracles were actually live — if a cell never started or
`QINIT_STATE_DIFF=verify` was not set, a green run may have tested much less than it appears to. Report the
numbers, never "passed".
