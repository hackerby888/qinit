# State and state-diff inspection — findings

Target: how Qinit **reads state back** — `packages/cli/src/trace/state-diff.ts` (diff rows),
`state-read.ts` / `state-format.ts` (rendering) and `packages/proto/src/qpi-container-view/*`
(container views) — hunted through real deploy-and-invoke flows.

Repo under test: `47b219d` ("name the state-diff windows and entry annotations"), run from source
(`bun run packages/cli/src/index.tsx`), Bun 1.3.11.

Nothing here was fixed or committed. Contracts, dumps and captures live outside the repo.

---

## Cells

| Cell | State | Why |
| --- | --- | --- |
| simulator × typescript | **live** | `qinit node run --runtime simulator --compiler typescript --core-dir <patched v0.0.47 headers>` |
| simulator × clang | **live** | same node; `qinit deploy --compiler clang` per contract |
| core × typescript | **could not be started** (rounds 1–6) | see below |
| core × clang | **could not be started** (rounds 1–6) | see below |

> **Superseded for the S7/S8 fixes.** The blocker below is the *published release* being ABI v6. A
> checkout of core-lite `develop` is ABI v7, and with one in hand the node builds and runs — see
> *The core cells, at last* in the S7/S8 fixes section. It still cannot be driven, for an entirely
> different reason recorded there.

### Both core cells are unavailable at this commit — ABI v6 vs v7

The repo's committed host ABI is **v7** (`packages/core/src/wasm/generated/wasm-abi.ts` →
`"abiVersion": 7`, with `assetIterBegin` / `assetIterNext` / `assetIterRecord`), landed by
`4d8f0d0 wasm: walk asset iterators per record through core's abi v7`.

The only published core-lite release is `qinit-v0.0.47`
(`https://github.com/hackerby888/core-lite/releases/latest/download/qinit-manifest.json`; there is no
`qinit-v0.0.48`…`0.0.60`). Its headers declare `#define WASM_ABI_VERSION 6u` and one
`HQ("assetEnumerate", …)` row, and it pins qinit commit `06ede6a`, which is behind this branch.

Two consequences, both reproduced:

1. **Simulator, unpatched headers.** The TypeScript backend emits an import for *every* row in the
   headers' `abi_metadata.h`, so a contract that never touches assets still imports
   `lhost.assetEnumerate`, which the engine's v7 table does not provide:
   ```
   qinit deploy fixtures/DbgMap.h --contract-name DbgMap --compiler typescript --json
   → "direct-deploy failed: import function lhost:assetEnumerate must be callable"
   ```
   The same error fails `packages/compiler/tests/differential/container-parity.test.ts` outright
   (6 fail / 7 skip / 0 pass with `QINIT_CORE` pointed at the release headers).
   Nothing compares the headers' `WASM_ABI_VERSION` against the repo's before instantiating, so the
   skew surfaces as a raw `LinkError` rather than a version message.

2. **Core runtime.** `DeployMessage.abiVersion` (`packages/proto/src/deploy.ts`) is filled from the
   repo's `WASM_ABI_VERSION` = 7. The v0.0.47 node uploads all chunks fine and then drops the deploy:
   ```
   <core node log>: [ERROR] LITEDYN: unsupported Wasm ABI version 7; expected 6
   qinit deploy … --runtime core → {"ok":false,"reason":"empty","detail":"slot empty — didn't land"}
   ```
   (Upload status at that point: `{"complete":true,"receivedCount":6,"chunkCount":6}`, finalHash equal
   to the build's `codeHash`, signer funded with 10 000 000 000 — the only rejection is the ABI word.)
   Two full deploy attempts, ~15 min each, both ended this way.

The core checkout that would match (`hackerby888/core-lite`) is outside this session's repository
scope and `add_repo` was denied, so no core cell could be brought up. **Every finding below therefore
reproduces in two cells, not four**, and no claim is made about core's window shapes.

**Workaround used for the simulator cells** (so the reader is not tested against a mismatched host):
the v0.0.47 headers were copied and three files in the wasm SDK shim were edited to v7 — the
`assetEnumerate` row in `abi_metadata.h` replaced by the three `assetIter*` rows (with
`WASM_ABI_VERSION` → 7), the matching `LH_IMPORT` rows added to `lhost_imports.h`, and
`lh_assetEnumerate` in `qpi_support.h` turned into a local stub so nothing imports the removed name.
`diff -r` confirms **`src/qpi/` is byte-identical** between the release headers and the patched tree,
so every container layout, geometry and semantic under test is the shipped one; only asset
enumeration (which no probe uses) was touched.

---

## Findings

### S1 — a keyed container with `_population == 0` and occupation flags set renders as *empty*, silently, while every other flag/population mismatch is reported

**Class 2 (missing records) + class 1 (renders as empty). Cells: simulator × typescript and
simulator × clang (all four keyed container kinds).**

`QpiHashMapView.entries()` (`packages/proto/src/qpi-container-view/hash-map-view.ts:34`) returns `[]`
as soon as the population word is zero — *before* it reads the occupation flags, so the
`slots.length !== population` consistency check a few lines below (`:41`) never runs. The identical
early return is in `hash-set-view.ts:33`, `collection-view.ts:62` and `linked-list-view.ts:40`.

**Repro** (`--allow-state-carryover` is the documented way to keep a slot's bytes across a layout
change, so this is the plain deploy flow):

```sh
# v1: a raw word array over the same bytes                (contracts/Carry1.h)
#     struct StateData { Array<uint64, 64> raw; };
qinit deploy Carry1.h --contract-name Carry --compiler typescript --slot 31

# write a live-looking record into what will be HashMap slot 0, leave _population at 0
qinit call --proc Carry 1 --in "0uint64,  8243659147065372709uint64"   # key word 0
qinit call --proc Carry 1 --in "1uint64, 14609594356816119933uint64"   # key word 1
qinit call --proc Carry 1 --in "2uint64,  2456445324331049173uint64"   # key word 2
qinit call --proc Carry 1 --in "3uint64,  4210694511342598189uint64"   # key word 3
qinit call --proc Carry 1 --in "4uint64, 4242uint64"                   # value  @32
qinit call --proc Carry 1 --in "40uint64, 1uint64"                     # _occupationFlags @320 = 0b01
qinit call --proc Carry 1 --in "43uint64, 777uint64"                   # marker @344

# v2: the same bytes as a HashMap + a marker            (contracts/Carry2.h)
#     struct StateData { HashMap<id, uint64, 8> bal; uint64 marker; };
qinit deploy Carry2.h --contract-name Carry --compiler typescript --slot 31 --allow-state-carryover
qinit state Carry --all --json
```

**Expected**: either the record, or the loud complaint the module already knows how to make.
**Actual**:

```
complete = True      fields = [('marker', '777')]
bal hashmap occ 0 tot 0 st loaded err None
   slots[0..7] | (unoccupied ×8; skipped)
```

**Oracle — the raw bytes** (`qinit state Carry --dump`, offsets from the IDL):

```
off=0   hex=25303b46515c6772   u64=8243659147065372709   <- bal.slot[0].key word 0
off=32  hex=9210000000000000   u64=4242                  <- bal.slot[0].value
off=320 hex=0100000000000000   u64=1                     <- bal._occupationFlags: slot 0 = 0b01 (occupied)
off=328 hex=0000000000000000   u64=0                     <- bal._population
off=344 hex=0903000000000000   u64=777                   <- marker  (reads correctly: the size is right)
```

**The control that rules out my own error.** One more `Put` of a real key takes population to 1 and
the flags to two occupied slots — the *same kind* of inconsistency — and the reader is immediately
loud:

```
complete = False
bal occ 0 st error err 'HashMap has 2 occupied slots but population 1'
```

So the reader can detect this; the population-0 path just returns before it looks.

**Same repro for the other three kinds** (`contracts/Zoo1.h` → `Zoo2.h`, one state holding
`HashSet<id,8> members; uint64 m1; Collection<uint64,8> queue; uint64 m2; LinkedList<uint64,8> list;
uint64 m3;`, 25 pokes then a carried-over redeploy):

```
READER1 complete= True  fields= [('m1','111'), ('m2','222'), ('m3','333')]
   members hashset    occ 0 tot 0 st loaded err None →  slots[0..7] | (unoccupied ×8; skipped)
   queue   collection occ 0 tot 0 st loaded err None →  PoV slots[0..7] | (unoccupied ×8; skipped)
   list    linkedlist occ 0 tot 0 st loaded err None →  slots[0..7] | (unoccupied ×8; skipped)

raw:  @256 = 1 (members._occupationFlags, slot 0 occupied)   @264 = 0 (members._population)
      @800 = 1 (queue._povOccupationFlags, PoV 0 occupied)   @320 = 1 (PoV[0].population)
      @808 = 4242 (queue._elements[0].value)                 @1192 = 0 (queue._population)
      @1408 = 1 (list._occupiedFlags, node 0)  @1216 = 999 (list._nodes[0].value)  @1448 = 0 (list._population)
```

All three markers (111 / 222 / 333) read at their correct offsets, so the container sizes are right —
the only thing wrong is the early return.

**Scope, stated honestly.** The injected record is unreachable from the contract too — `Carry.Look`
prints `look 0 population 0 contains 0`, because `HashMap::getElementIndex` starts probing at the
key's own bucket (slot 2 for this key) and stops at the first `0b00` flag, never reaching slot 0. So
the container is genuinely self-inconsistent, and qpi's own operations never leave one in this shape:
reaching it needs bytes the reader did not write — a carried-over layout, a partially written state,
a truncated restore, or a read racing a write (the case `readContainerBlock`'s retry loop already
anticipates). That is exactly what makes it a *reader* bug rather than a container bug: the reader's
job is to say what the bytes are, and here it says "empty" where the same module, two lines later,
would have said "inconsistent".

**Severity: dangerous (silently wrong).** Live-flagged records vanish with no row, no error and
`complete: true`, so no consumer — `stateIsComplete`, the debug TUI, a `--json` script — can tell the
container was not really read.

---

### S2 — a one-field struct container key is labelled `{field: undefined}` in every diff row

**Class 4 (incorrect parsing) + class 1 (`undefined` where a value belongs). Cells: simulator ×
typescript and simulator × clang — both, identically.**

`state-diff.ts`'s `keyText()` decodes the key with `decodeAbi(bytes, type)`, which **unwraps a
0- or 1-field struct to that field's value** (documented at `packages/proto/src/abi/decode.ts:184`),
and then hands the unwrapped value to `keyLabel(key, type)` (`state-format.ts:185`), which calls
`formatStateValue(key, type, false)` with `topLevel = false`. The struct branch (`state-format.ts:154`) then does
`topLevel && type.fields.length === 1 ? [value] : Array.isArray(value) ? value : []` — with `topLevel`
false and `value` a bigint, that is the lead's `[]` coercion, and every field renders `undefined`.
The container view is unaffected because it feeds `keyLabel` from `decodeAbiValue`, which does **not**
unwrap.

**Repro** (`contracts/KeyShapes.h`, deployed with either compiler):

```cpp
struct One { uint64 w;            bool operator==(const One& o) const { return w == o.w; } };
struct Two { uint64 a; uint64 b;  bool operator==(const Two& o) const { return a == o.a && b == o.b; } };
struct StateData {
    HashMap<One, uint64, 4> m1;  uint64 k1;
    HashMap<Two, uint64, 4> m2;  uint64 k2;   // control
    HashSet<One, 4>         s1;  uint64 k3;
};
```

```sh
qinit deploy KeyShapes.h --contract-name KeyShapes --compiler typescript --slot 30
qinit call --proc KeyShapes 1 --in "1000uint64, 7uint64"            --trace --json   # M1Set
qinit call --proc KeyShapes 3 --in "1000uint64, 2000uint64, 9uint64" --trace --json  # M2Set (control)
qinit call --proc KeyShapes 5 --in "1000uint64"                      --trace --json  # S1Add
```

**Actual** (`state[]` rows; `I` = `internal`, hidden without `--trace-full`):

```
I m1.slot[0].key          | 0 → 1000                       <- the bytes read fine here
  m1[{w: undefined}]      | = 7 (new)                      <- the entry label
I m1._occupationFlags[0]  | 0 → 1
  m1                      | 0 → 1 entries

I m2.slot[1].key          | 0 → {a: 1000, b: 2000}         <- control: two fields
  m2[{a: 1000, b: 2000}]  | = 9 (new)                      <- control: correct

  s1[{w: undefined}]      | (new)
```

**Expected**: `m1[{w: 1000}]` and `s1[{w: 1000}]`, as the other two readers over the same bytes say:

```
qinit state KeyShapes --all --json
   m1 slot[0] | {w: 1000} = 7        <- container view, correct
   m2 slot[1] | {a: 1000, b: 2000} = 9
   s1 slot[0] | {w: 1000}            <- container view, correct

qinit state KeyShapes --dump ; off=0 hex=e803000000000000 u64=1000   <- raw bytes, correct
```

The removal path is affected the same way (`m1[{w: undefined}] | 7 → (removed)`,
`s1[{w: undefined}] | (removed)`), because it labels from the same `keyBefore`/`keyAfter` pair.

**Why it is worse than it looks**: in the default `--trace` view the correct
`m1.slot[0].key | 0 → 1000` row is suppressed as an internal key row (it is `collapsed`, since the
entry line is supposed to carry the key), so the *only* identification the developer sees is the
broken one:

```
  state
    m1[{w: undefined}] = 7 (new)
    m1                 0 → 1 entries
    ⋯ 2 container internals hidden · --trace-full
```

**The control that rules out my own error**: the two-field key beside it, in the same state, in the
same call batch, renders correctly in both readers — so this is the one-field unwrap, not struct keys
in general. Reproduced byte-for-byte under both compilers.

Harmless relative of the same unwrap, noted so it is not mistaken for a second bug: the key *row*
reads `m1.slot[0].key | 0 → 1000` rather than `→ {w: 1000}`, because `renderValue` → `scalarText`
passes `topLevel = true` and a bare bigint short-circuits to `String(value)`. The value is right and
the label names the member, so this one is only a cosmetic difference from the container view.

**Severity: dangerous (silently wrong label).** The value is right, the row that names *which entry
changed* is not, and a one-field wrapper struct (`struct Key { id v; }`, `struct TokenId { uint64 v; }`)
is an ordinary shape.

---

### S3 — a phantom `@N (outside any known field)` row on every call that touches the last diff window, when the state has trailing alignment slack

**Class 4 (a row that does not correspond to a byte that moved). Cells: simulator × typescript
(structural — it does not depend on the compiler).**

`stateDiffLines` (`state-diff.ts:470`-`:494`) steps through a changed window field by field. Between
two fields it only reports unknown bytes when they actually differ (`:480`); **past the last field it
reports unconditionally** (`:487`):

```ts
if (next && next.off < windowEnd) {
    if (!bytesEqual(slice(before, stateOffset, next.off), slice(after, stateOffset, next.off))) reportUnknownBytes();
    stateOffset = next.off; continue;
}
// Past the last field, alignment slack and a changedWindow longer than the whole state look the same…
reportUnknownBytes();
break;
```

The simulator's windows are 256-byte aligned blocks (`DIFF_WINDOW = 256` in
`packages/engine/src/logging/trace.ts`), clipped to the state length — so the last window always
reaches the end of the state, and any state whose last field does not end on the state's alignment
gets the row on every dirtying call.

**Repro** (`contracts/Straddle.h`; the `p16/p8/p4/p2` arrays exist only to place `key` across a
256-byte boundary for the partial-window probe recorded under "Leads chased" — they play no part in
this finding):

```cpp
struct StateData {
    Array<uint64,16> p16;  Array<uint64,8> p8;  Array<uint64,4> p4;  Array<uint64,2> p2;  // [0,240)
    id key;      // [240,272)
    uint64 tail; // [272,280)
    uint8 last;  // [280,281)   -> IDL state size 288, align 8, slack [281,288)
};
```

```sh
qinit deploy Straddle.h --contract-name Straddle --compiler typescript --slot 29
qinit state Straddle --dump --out st-0.bin
qinit call --proc Straddle 4 --in "7uint64" --trace --json     # SetLast
qinit state Straddle --dump --out st-1.bin
```

**Actual**:

```
  last  | 0 → 7        (detail: last)
  @281  | (outside any known field)   (detail: @281)
  2 row(s)
```

**Expected**: one row. **Oracle — the two dumps**:

```
A=288 B=288 bytes
@280..280 (1B)  00 -> 07
1 run(s), 1 changed byte(s)
```

Exactly one byte moved. Bytes 281..288 are the state struct's tail padding and are provably
unchanged, yet the reader announces unknown bytes there.

**When it fires**: any write inside the final 256-byte window, not just the last field —
`SetTail` (writing `tail` at 272) produces the same `@281` row. A write in an earlier window
(`SetPad` → `p16[0]`) does not. It is visible in the default human `--trace` view as well as in
`--trace-full` and `--json`; it is not marked `internal`.

**The control that rules out my own error**: `SixPack` and `BigMap`, whose last fields end exactly on
the state size (1872 and 10 551 360), never produced an `@N` row — `grep -c "outside any known field"`
over the three 35-operation captures (172 rows each, 516 rows in total) returns 0, 0, 0. `Straddle`,
which differs only in having a `uint8` last field, produces one on every qualifying call.

**Severity: medium — loud but false.** Nothing is silently wrong, but the row says the exact thing a
developer must never ignore ("bytes changed that belong to no field"), so it costs an investigation
every time, and it desensitises the one signal that would catch a real layout error. The fix the code
already contains two branches above is the `bytesEqual` guard; note also that the "changedWindow
longer than the whole state" case the comment cites cannot be observed here, because `windowEnd` is
clipped to `min(before.length, after.length)` before the walk starts.

---

## Leads chased and *not* filed, with the reason

These are from the audit list in the brief. Each was pursued to a conclusion; none produced a repro
through the flow, so none is filed as a finding.

- **`state-format.ts`'s four `Array.isArray(value) ? value : []` coercions.** One of them *is*
  reachable and is filed as **S2** (the struct branch, via `keyLabel`). The other three
  (`BIT_ARRAY` `:142`, `LINKED_LIST` `:147`, `ARRAY` `:168`) are fed only by `decodeAbiType`,
  which returns an array for each of those kinds, or by `decodeAbiContainer`, which returns the
  logical view (`entries()` for the keyed kinds, `entry.value[]` for Array/BitArray). I could not
  construct a caller that passes a non-array. A nested `BitArray<64>` inside an `Array<Struct,2>`
  element and inside a `HashMap` value both rendered correctly
  (`holders[1] | {tag: 55, bits: [0..2]=0 ×3 (skipped), [3]=1, [4..63]=0 ×60 (skipped)}`).
- **`StateField.bad`.** Confirmed dead by inspection: `stateFieldsOf()` is the only producer of
  `StateField` for `readState`, and it never sets `bad`, so `state-read.ts`'s
  `(undecodable: … — fields below not shown)` branch is unreachable. No probe, including the
  carried-over layouts above, ever produced it. Worth deleting or wiring up, but it is not a
  misreport.
- **`"read failed"` string matching in `stateIsComplete`.** No AbiType decodes to a JS string other
  than `id`/`m256i`, which render as 60 uppercase letters and 64 hex digits respectively — neither can
  contain the lowercase literal. I could not build a contract whose own data reaches that check.
- **`state-diff.ts`'s `?? layout[layout.length - 1]` fallback (`:175`).** Unreachable for all four
  container kinds at this commit: the last region of every `*Members()` table ends at exactly
  `populationOffset + 16` (or `+ 8` for LinkedList), and `*Geometry().size` is
  `roundUp(that, align)` with `align = max(…, 8)`; since every QPI scalar has `align ≤ 8`, `align` is
  always 8 and there is no slack for `relativeOffset` to land in. Same reasoning kills the
  `offsetInElement >= type.element.size` branch in `resolveLeaf`'s ARRAY case: a struct's size already
  includes its tail padding, so `arrayGeometry().stride == element.size` for every constructible
  element.
- **`decodeAbi` dropping trailing bytes / no overlap check on decode.** Every caller in the state
  path hands it a slice of exactly `type.size` (`renderValue` is guarded by
  `leaf.off >= window.off && valueEnd <= windowEnd`, `cheatValue` compares `record.size === type.size`),
  so I could not reach a decode with extra bytes through the flow.
- **`decode-log.ts` / `format.ts` ~`:83`.** `decodeLog` wraps its whole decode in `try {} catch {}` and
  returns the hex-only `base` on failure, so an unparseable *payload* cannot empty the list; only a
  throw from `loggedSizeOf()` (i.e. a malformed IDL catalog entry) escapes into the `Promise.all`, and
  I could not produce one from a contract that compiles. The missing `_type` check when exactly one
  catalog entry matches the size is real as described, but mislabelling needs a contract that writes a
  `_type` belonging to a differently-sized log struct; I did not build one. Logs are also outside the
  four state-inspection failure classes, so I stopped here rather than spend the remaining budget.
- **Partial-window rendering of an `id`.** Reachable and behaves as its comment says, so not filed:
  with `key` at [240,272) straddling the 256-byte window boundary, changing only its upper half gives
  `key+16 | 0x00000000000000000000000000000000 → 0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a00` instead of a
  decoded identity, and the lower half is not shown. The dumps agree (`@256..270`, 15 bytes changed)
  and `qinit state` renders the whole identity correctly. I record it as a readability edge rather
  than a defect: the reader deliberately refuses to invent the bytes it cannot see.

---

## What was actually exercised (the clean part of the result)

This is a claim about coverage, so here are the numbers rather than "passed".

**Dispatches**: ≈250 `qinit call --proc/--fn` invocations across 24 successful deploys (plus 4 refused
before the ABI workaround described above), every one of them a real
`build → node run → deploy → call → inspect` flow. No `stateDiffLines` was called directly and no
`DebugStateRegion` was hand-built.

**Oracles that were actually live**

- `QINIT_STATE_DIFF=verify` was set on the simulator node for every run except the dedicated
  snapshot pass, and verified each time by reading `/proc/<node pid>/environ` (the node is detached,
  so this is not assumable). It **never threw** — the write journal and the copy snapshot agreed on
  every dispatch.
- A second full pass under `QINIT_STATE_DIFF=snapshot` (journal ignored): the 35-operation sequence
  replayed against a fresh contract produced rows **byte-identical** to the `verify` pass
  (`diff` empty, 0 lines) and the same final state digest
  `459f1e979a084f66395c57d21c85a896876fd91e3800cae5689eb2dfb0b7d750`. No row differs between the two
  modes.
- **Raw bytes**: 14 byte-level conservation checks — `qinit state --dump` before and after a single
  operation, changed runs extracted, and every run matched by hand against the IDL offsets and the
  `state[]` rows. Every changed byte was named by a row and every row corresponded to a changed byte,
  with the single exception filed as **S3**. Worked examples that passed: HashMap insert (3 runs /
  4 rows), update (1 run / 1 row), remove (4 runs / 5 rows), tombstone reuse (3 runs / 4 rows),
  Collection insert (7 runs / 10 rows), Collection remove with the two-children element move
  (13 runs / 15 rows), `Collection::cleanup()` (6 runs / 6 rows), `HashSet::cleanup()` (2 runs /
  2 rows), LinkedList middle removal (7 runs / 8 rows), the `{uint8, uint64, uint16}` struct write
  (3 runs / 1 collapsed struct row), BitArray + Array writes (4 runs / 5 rows).
- **Three readers over the same bytes**: `qinit state --all --json` (container view),
  `qinit call --trace --json → state[]` (diff reader) and `qinit state --digest` (K12) were compared
  at every checkpoint. The only disagreements found are **S1** and **S2**.
- **`CC_PRINT`** (the contract's own read) in `SixPack.Peek`, `Carry.Look` and `Zoo.Counts`: agreed
  with the CLI in every case (`print :126 peek 99 m1 1 m6 1` against `bal[…] = 99`, `marker 1`).

**Cross-compiler differential**: the same hand-written 35-operation sequence (6 marker bumps; 8
HashMap inserts to capacity; an insert into the full map; a value update; a remove; a tombstone
reuse; 3 HashSet adds and a remove; 4 Collection adds across two PoVs and three priorities; two
Collection removes including the both-children element-move path; `Collection::cleanup()`; 3
LinkedList tail appends, a middle removal and a free-list reuse; `HashSet::cleanup()`) was replayed
against a typescript-built and a clang-built copy of the identical source. Each replay produced
**172 diff rows**; the captures are **identical line for line** (`diff` returns 0 lines over 35 steps),
the final states are **byte-identical** (`cmp` clean over 1872 bytes), the digests match, and the
container views match. The `snapshot`-mode replay produced the same 172 rows again.

**Container kinds and edges covered** (each in both live cells): `HashMap`, `HashSet`, `Collection`,
`LinkedList`, `BitArray`, `Array` — empty; one entry; **full** (8/8, plus a refused 9th insert that
correctly produced 0 rows and `-1`); remove then re-insert into the tombstone; remove-everything and
`cleanup()`; a key colliding into an occupied bucket (observed as the probe chain placing keys at
slots 5, 2, 7, 4, 1, 6, 3, 0).

**State shapes built**: a container followed by a scalar marker (six times over, one marker after each
container kind — the `DbgMap` trick, deeper); two containers in one state so a size error in the first
shifts the second; a struct holding a container two levels down (`deep.holder.inner`); a container
whose value type is a struct containing an array (`HashMap<id, {uint64, Array<uint32,4>}, 8>`); an
array of structs each holding a `BitArray`; a struct whose widest member is not last and which has
tail padding (`{uint8 a; uint64 wide; uint16 b;}`); struct-typed container keys with one and two
fields; a 10 551 312-byte `HashMap` past the 10 MB collapse threshold with markers at offsets
10 551 312 and 10 551 352; an 8 MB `Array` and a 1 MB `BitArray` that cross the 4 MB
`MAX_STATE_READ` cap. Every marker read at its correct offset in every case, which is the control
that says the container sizes are right.

**Not covered, and therefore not claimed**

- Both **core** cells (see the ABI section). In particular, core reports *aligned dirty pages* rather
  than the simulator's 256-byte diff windows, so the partial-window branch, `mergeAdjacentWindows`,
  and **S3**'s trigger condition may behave differently there. **S3** in particular is a window-shape
  bug and is very likely worse on core, where windows are coarser.
- `qinit debug` (the Ink TUI) was not driven; all trace evidence comes from `call --trace[-full]`.
- Logs: only read, never stressed (see the `decode-log` lead).
- `QINIT_STATE_DIFF` unset (the default mode) was not separately swept; `verify` runs both mechanisms
  and `snapshot` was swept, so the default's journal path is covered by `verify`.

---

# Round 2

Same repo commit (`47b219d`), same two live cells (simulator × typescript, simulator × clang; both core
cells still unavailable for the ABI reason above), same `QINIT_STATE_DIFF=verify` node.

New ground, chosen because round 1 did not touch it: every QPI scalar width and sign, containers nested
*inside another container's element*, the `MIGRATE` old-state decode, cross-contract frames, and the
`qinit debug` TUI.

## Findings

### S4 — a nested container's `_population` is relabelled as the outer entry's *value*

**Class 4 (a row labelled by the wrong thing). Cells: simulator × typescript and simulator × clang —
both, byte-for-byte identical.**

When a keyed container's value type is itself a container, `memberLeaf` (`state-diff.ts:167`-`:233`, the overwrite at `:218`-`:232`)
resolves into the nested container and then **overwrites** whatever the nested resolve attached:

```ts
const leaf = resolveLeaf(named, recordStart + member.off, idlType(member.type), …);
const keyMember = span.members.find((candidate) => candidate.type === "key");
if (!keyMember) return leaf;
return { ...leaf, recordKey: { part: member.type, container: names.label, … } };   // outer record wins
```

So every leaf inside the nested container carries the **outer** record's key, including the nested
container's own `_population` word. `collapseEntries` then takes the `part === "value"` branch, replaces
the label with `outer[key]` and replaces the text with `entryText()` — which also drops the `entries`
suffix that is the only cue the row is a counter.

**Repro** (`contracts/NestCount2.h`, one contract carrying its own control — the *same* nested
`HashSet<id, 4>` reached two ways):

```cpp
struct StateData {
    HashMap<id, HashSet<id, 4>, 2> mapsets;  uint64 m1;   // nested in a keyed container
    Array<HashSet<id, 4>, 2>       arrsets;  uint64 m2;   // nested in an Array  <- control
};
```

```sh
qinit deploy NestCount2.h --contract-name NestCount2 --compiler typescript --slot 31
qinit call --proc NestCount2 1 --in="<K3>id, <K4>id"     --trace --json   # MapAdd
qinit call --proc NestCount2 2 --in="0uint64, <K4>id"    --trace --json   # ArrAdd (control)
```

**Actual** — the two rows describe the same kind of word (a nested `HashSet._population` going 0 → 1):

```
MapAdd:
  I mapsets.slot[1].key   | 0 → PKTG…
    mapsets[PKTG…].slot[0]                | = IOQK… (new)      (detail: mapsets.slot[1].value.slot[0])
    mapsets.slot[1].value[IOQK…]          | (new)              (detail: mapsets.slot[1].value._occupationFlags[0])
    mapsets[PKTG…]                        | = 1 (new)          (detail: mapsets.slot[1].value._population)   <-- WRONG
  I mapsets._occupationFlags[1]           | 0 → 1
    mapsets                               | 0 → 1 entries      (detail: mapsets._population)

ArrAdd (control):
    arrsets[0][IOQK…]                     | (new)              (detail: arrsets[0].slot[0])
  I arrsets[0]._occupationFlags[0]        | 0 → 1
    arrsets[0]                            | 0 → 1 entries      (detail: arrsets[0]._population)              <-- right
```

`mapsets[PKTG…] = 1` reads as "the map's value for key PKTG… is 1". The value is a 152-byte
`HashSet<id, 4>` whose membership is `{IOQK…}`; the `1` is that set's population. Nothing in the row
says so, and it sits directly above `mapsets 0 → 1 entries`, which is a genuine count row — two rows
that look alike and mean different things.

**Oracle — the raw bytes** (`qinit state NestCount2 --dump`, 712-byte state, IDL offsets):

```
@184..247 (64B)  outer record 1 key [184,216)  +  nested set record 0 key [216,248)
@344            = 1   nested set _occupationFlags (slot 0 = 0b01)
@352            = 1   nested set _population        <-- the word rendered as "mapsets[PKTG…] = 1"
@368            = 4   outer map _occupationFlags (slot 1)
@376            = 1   outer map _population
@400..431 (32B) = the control's nested set record 0 key
@528            = 1   control nested set _occupationFlags
@536            = 1   control nested set _population  <-- the word rendered as "arrsets[0] 0 → 1 entries"
8 runs, 102 changed bytes — every one named by a row, so nothing is missing; the defect is the label.
```

**It is not stable, either.** The relabel only fires when the outer record's key happens to fall inside
the same 256-byte diff window. In `contracts/NestCount.h` (a 400-byte state) three consecutive adds to
one outer entry produced, for the *same* `_population` word:

```
add 1 (new outer key)   mapsets[PKTG…]              | = 1 (new)
add 2 (slot 1 member)   mapsets[PKTG…]              | 1 → 2
add 3 (slot 2 member)   mapsets.slot[1].value       | 2 → 3 entries        <- correct form
```

The third add's member lands past the window boundary, the outer key is then out of window,
`entryIdentityOf` returns undefined, and the row keeps its own name. So the same word is reported two
contradictory ways depending on where the nested member hashed.

**The control that rules out my own error**: `arrsets`, in the same state, in the same call batch, at
the same nesting depth, with the same nested type — an Array element has no record key, so nothing
overwrites the nested resolve and the row is correct. Reproduced identically under both compilers
(rows `diff`-clean, state dumps `cmp`-clean).

**Visible in the default view.** `qinit call --proc NestCount 1 … --trace` prints:

```
  state
    mapsets[BNQG…]  = 1 (new)
    mapsets         1 → 2 entries
    ⋯ 2 container internals hidden · --trace-full
```

**Severity: dangerous (silently wrong label and text).** No error, no hint, and the correct reading
(`mapsets.slot[1].value._population`) is only in the `detail` field, which the default human view never
shows. `HashMap<id, HashSet<…>>` and `HashMap<id, Collection<…>>` are ordinary index shapes.

---

### S5 — `call --trace --json` drops the nested contract call the human view reports

**Class 3 (a state change with no row naming it), in the `--json` surface only. Cells: simulator ×
typescript.**

`--trace` documents itself as "show state changes **and contract calls**" (`qinit help call`). The human
renderer prints a `host` line for a cross-contract invocation; the `--json` document has no equivalent
key at either trace level.

**Repro** (`contracts/Caller.h` invoking `contracts/Callee.h`, which writes a `HashMap` and a counter of
its own):

```sh
qinit deploy Callee.h --contract-name Callee --compiler typescript --slot 29
qinit deploy Caller.h --contract-name Caller --compiler typescript --slot 30 --callee "Callee=Callee.h@29"
qinit call --proc Caller 1 --in="<K>id, 700uint64, 9uint64" --trace        # human
qinit call --proc Caller 1 --in="<K>id, 900uint64, 11uint64" --trace-full --json
```

**Human** (correct):

```
  state
    sent     500 → 1200
    last     DDZY… → WGWC…
    marks[9] 0 → 1
  host   invokeProcedure → @29 proc #1 reward=0
```

**`--json`**, same call shape:

```
keys: [address, balance, caller, contract, entry, error, execNs, in, kind, logs, ok, out, slot,
       state, tick, tx]
state rows: [("sent", "1200 → 2100"), ("last", "WGWC… → PKTG…"), ("marks[11]", "0 → 1")]
any mention of the callee or the host call?  False
```

`--trace-full --json` is identical — there is no `host`, `calls` or `frames` key at any level. A script
reading `state[]` concludes the call touched three fields of one contract. It in fact also wrote
`Callee.log[K] = 700` and `Callee.hits 1 → 2`, which `qinit state Callee` and `qinit debug Callee` both
show correctly.

**Scope, corrected in round 3.** The JSON is not blind to nested calls in general: when a nested call
*traps*, the document does carry a `warnings` array with the same text the human view prints
(`["⚠ FailCalleeproc#2 trapped inside this call: Integer overflow", "    called with {…}"]`). The gap is
a nested call that **succeeds** — no warning, no host row, nothing. So the document already has a place
to say a nested call happened, and says nothing exactly when the nested contract's state changed
without incident.

```
qinit state Callee --all --json
   fields [("hits", "2")]
   log slot[1] | DDZY… = 500
   log slot[2] | WGWC… = 700

qinit debug Callee   (the callee's own frame, caller = the Caller contract's address)
   log[WGWC…] = 700 (new)
   log        1 → 2 entries
   hits       1 → 2
```

**The control that rules out my own error**: the same `--json` document *does* carry `state[]` and
`logs[]`, and the human renderer built from the same `DecodedTrace` prints the host line — so this is
the JSON projection dropping a section, not the trace lacking it.

**Severity: low-to-medium — loud enough to notice if you use the human view, invisible if you script.**
Scoping `state[]` to the invoked contract is a defensible design; omitting any signal that another
contract ran is what makes the JSON misleading on its own terms.

---

## Round 2 — what was exercised, and what came back clean

54 dispatches over 14 successful deploys, all through `build → node run → deploy → call → inspect`.
`QINIT_STATE_DIFF=verify` was live on the node for every one (checked via `/proc/<pid>/environ`) and
**never threw**. 7 more byte-level conservation checks (dump before, dump after, every changed run
matched by hand against the IDL offsets and the rows) — all accounted for, including the two behind S4.

**Every QPI scalar, at its boundaries — clean.** `contracts/Scalars.h` puts `sint8 uint8 sint16 uint16
sint32 uint32 sint64 uint64 bit uint128 id m256i` in one state, then the same widths signed inside a
`HashMap<id, sint64, 4>`, an `Array<sint32, 4>` and a `Collection<sint64, 4>`:

```
i8   0 → -128                       raw @0   = 0x80
u8   0 → 255                        raw @1   = 0xff
i16  0 → -32768                     raw @2.. = 0x0080
u16  0 → 65535
i32  0 → -2147483648                raw @11  = 0x80
u32  0 → 4294967295
i64  0 → -9223372036854775808       raw @23  = 0x80
u64  0 → 18446744073709551615
b    0 → 1
u128 0 → 340282366920938463463374607431768211455   raw @40..56 = 16 × 0xff
who  0 → DDZYFAHIBMAKIDZEJ…          (id    -> 60-char identity)
raw  0 → 25303b46515c6772…           (m256i -> hex, over the SAME 32 bytes)
```

Negatives inside containers read back correctly too — `smap[DDZY…] = -9223372036854775808`,
`sarr[1] = -2147483648`, and a `Collection` ordered by negative priorities renders
`9 (p0)`, `-7 (p-1)`, `-5 (p-100)` in descending priority order. The four markers stayed at their
declared offsets throughout, which is what says the `uint128` field's size/alignment (16/8, offset 40)
matches the C++ `uint128_t { uint64 low; uint64 high; }`. The ten-operation sequence replayed against a
clang build produced **identical rows** (`diff` empty), byte-identical state and the same digest
`fbf011d1c1e21a69e67c356824ab167f2adc2a5b456f855f3f76ea8aad1114f7`.

**Containers inside containers — clean apart from S4.** `contracts/NestDeep.h` holds
`Array<HashMap<id,uint64,4>, 2>`, `LinkedList<Array<uint64,2>, 4>`, `Collection<{uint64 tag;
BitArray<64> bits}, 4>` and `HashMap<id, HashSet<id,4>, 2>`. Rows name the full path correctly at every
depth:

```
maps[1][DDZY…]         | = 77 (new)           (detail: maps[1].slot[1].value)
lists[0][0]            | 0 → 11               (detail: lists._nodes[0].value[0])
coll[0].tag            | 0 → 5                (detail: coll._elements[0].value.tag)
coll[0].bits[9]        | 0 → 1                (detail: coll._elements[0].value.bits[9])   <- a BitArray three levels down
```

and the container view renders a container below a container's element as inline JSON, as documented:
`maps [1] | [{"slot":1,"key":"DDZY…","value":"77"}]`.

**`MIGRATE` — clean.** `contracts/MigZoo1.h` → `MigZoo2.h` (old state = `HashMap<id,uint64,4> bal;
uint64 marker;`, new state adds `extra`). The migration carried both over (`Get` returns
`{marker: 1, extra: 4242, pop: 2}`) and the migrate entry decodes correctly in `qinit debug`: its `in`
is the old state with the container inline as JSON, and its `state` diff shows
`bal[DDZY…] = 111 (new)`, `bal 0 → 2 entries`, `marker 0 → 1`, `extra 0 → 4242`, with 4 container
internals correctly hidden until `ctrl+t`.

**`qinit debug` (the Ink TUI) — clean.** Driven under tmux at 200×50 with `capture-pane` for true
frames, one key per `send-keys`. The call list, `↑/↓` selection, the detail pane and `ctrl+t`
(show/hide internals) all behaved; internals were hidden by default and complete when toggled; the
callee's own frames appear under `qinit debug Callee` with the Caller contract's address as `caller`.

**Not a state-inspection finding, but a compiler differential worth passing on**: the TypeScript backend
accepts `state.mut().u128 = ((uint128)input.hi << 64) | (uint128)input.lo;` and builds a contract from
it; clang rejects the same line —
`error: use of overloaded operator '<<' is ambiguous (with operand types 'uint128' (aka 'uint128_t') and 'int')`.
clang is the oracle here, so the TypeScript backend is accepting C++ that does not compile. Rewriting
as `uint128(input.hi, input.lo)` builds under both. This belongs to `docs/testing-agent-prompt.md`'s
area, not this one, so it is recorded rather than filed.

**Still not covered, still not claimed**: both core cells (unchanged reason); logs (`decode-log.ts`
remains analysed only — see the leads section above); `qinit explorer`; and the `bit`-with-a-raw-byte
above 1 case, which needs injected bytes exactly like S1 and would add nothing to it.

---

# Round 3

Same commit, same two live cells, same `QINIT_STATE_DIFF=verify` node. New ground: what the readers say
about a call that **aborts after writing**, a **nested call that traps**, **logs** (the one lead left
unresolved after round 1), and **capacity-1 containers**.

No new S1-class defect. One cosmetic defect, one correction to S5, one lead closed as *not* a defect,
and two things outside this brief worth passing on.

## Findings

### S6 — the nested-trap warning runs the contract name into the entry label

**Cosmetic. Cells: simulator × typescript (string formatting, compiler-independent).**

`call.tsx:114` builds the warning as `` `⚠ ${contract}${entryLabel(frame.kind, frame.entry)} …` ``, and
`entryLabel` returns `proc#2 (Name)` with no leading space — every other call site supplies its own.
The result, in the human view and verbatim in the `--json` `warnings` array:

```
⚠ FailCalleeproc#2 trapped inside this call: Integer overflow
```

Expected `FailCallee proc#2`. Compare the frame header two lines above it, which gets it right:
`✗ FailCallee proc#2 (FailAfterWrite) 1.3ms · tick 3022`.

**Severity: cosmetic.** It garbles the contract name in the one line that tells a developer *which*
contract trapped, and it is the string a script would have to parse out of `warnings`.

---

## Round 3 — what came back clean, with the evidence

52 dispatches over 12 deploys, `QINIT_STATE_DIFF=verify` live throughout and never throwing.

**An abort after writing — clean, and the readers agree.** `contracts/Rollback.h` writes a HashMap
entry, a marker and a BitArray bit, then fails a `CC_ASSERT`. The simulator does not roll the writes
back; it halts the node. Every byte that moved is named:

```
qinit call --proc Rollback 2 …   ->  "node halted: Rollback proc#2 trapped abort(0xCC000027) …"
                                     --json omits `state` entirely (rather than an empty array),
                                     so a script cannot read it as "nothing changed"

qinit debug Rollback  (the same halted node still serves RPC)
    bal[WGWC…] = 99 (new)
    bal        1 → 2 entries
    marker     1 → 101
    bits[5]    0 → 1
    ⋯ 2 container internals hidden · ctrl+t
    trap   abort(3422552103)

dump-to-dump:  5 runs, 37 changed bytes — all five named by the rows above.
```

The only rough edge is that `qinit call --trace` cannot show this, because the node halts before the
trace can be fetched; the message says so and points at `qinit node run`. Not filed: the CLI reports a
trap, not a quiet success.

**A nested call that traps — clean.** `contracts/FailCallee.h` / `FailCaller.h`: the callee writes then
traps on `div<sint64>(INT64_MIN, -1)`; the caller uses `INVOKE_OTHER_CONTRACT_PROCEDURE_E` and survives.
`qinit debug FailCallee` records the callee's frame as `✗ … trap Integer overflow` with rows that match
the surviving bytes exactly (4 runs / 4 rows), and the caller's own trace carries the `warnings` entry
and the `host invokeProcedure → @29 proc #2` row. Nothing is reported that did not happen and nothing
that happened goes unreported.

**Logs — the `decode-log` lead is closed as *not* a defect.** Round 1 left this analysed but unproven.
`contracts/LogZoo2.h` declares two log structs of different logged sizes (`AlphaLog` 16 B, `GammaLog`
24 B) and a procedure that emits an `AlphaLog` carrying `GammaLog`'s `_type`:

```
EmitAlpha  ->  name=AlphaLog  fields={_contractIndex: 32, _type: 11, alpha: 77}
EmitGamma  ->  name=GammaLog  fields={_contractIndex: 32, _type: 33, g1: 5, g2: 6}
EmitLiar   ->  name=AlphaLog  fields={_contractIndex: 32, _type: 33, alpha: 99}
human view ->  log INFO AlphaLog·KindGamma {_contractIndex: 32, _type: 33, alpha: 99}
```

`decodeLog` does skip `byTypeWord` when exactly one catalog entry matches the logged size — but the
bytes really *are* 16 bytes, so `AlphaLog` is the right struct, and the reader prints the contradicting
`_type` right beside it. The human view even names both halves (`AlphaLog·KindGamma`). The contract
lied; the reader reported both facts. Nothing is hidden, so there is nothing to fix.

I could not produce the other half of that lead either — one unparseable log emptying the whole list.
`decodeLog` wraps its entire decode in `try {} catch {}` and returns the hex-only record on failure, so
a bad payload cannot escape into `format.ts`'s `Promise.all`; only a throw from `loggedSizeOf()` could,
and that needs a malformed IDL catalog entry, which no contract that compiles produces.

One gap did turn up here and is folded into **S5** rather than filed separately: the `--json` log object
drops `typeName`, which the human view shows (`AlphaLog·KindGamma` → `{"name": "AlphaLog", "_type": 33}`
with no enum name). Same shape as S5 — the JSON projection losing what the human renderer has.

**Capacity-1 containers — clean.** `contracts/Tiny.h` holds `HashMap<id,uint64,1>`, `HashSet<id,1>`,
`Collection<uint64,1>`, `LinkedList<uint64,1>`, `Array<uint64,1>`, `BitArray<1>`, each followed by a
marker. All six fill, render and read back correctly; the refused ninth-style insert into the full
capacity-1 map produced `-1` and **0 rows**; remove-then-reinsert reused the tombstone
(`m._occupationFlags[0] 1 → 2` then `2 → 1`) with the population going `1 → 0 → 1`. 16 byte runs across
the fill sequence, every one named. The six markers stayed at their declared offsets.

**Outside this brief, passed on rather than filed**

- `INVOKE_OTHER_CONTRACT_PROCEDURE_E` reports `NoCallError` (0) for a callee that trapped. In the run
  above the callee's frame is `✗ … trap Integer overflow`, its writes persisted (`hits 0 → 1000`, a new
  `log` entry), the caller continued, and `trapError` — the macro's error variable — came back `0`, which
  the caller stored as `lastError = 0`. A second call reports `0` again. The CLI's own comment at
  `call.tsx` (“the caller only sees NO_CALL_ERROR with a zero-filled output”) says this is known, but if
  it is intended then `InterContractCallError` has no code a contract can use to notice a trapped callee.
  This is engine/QPI semantics, not state reading.
- (From round 2, repeated here for one list) the TypeScript backend builds
  `((uint128)hi << 64) | (uint128)lo`; clang rejects it as an ambiguous `operator<<`.

**Still not covered, still not claimed**: both core cells (unchanged ABI reason), `qinit explorer`,
`qinit gtest`/`test`, and state read under concurrent writes.

---

# Fixes

Applied on the same branch, on top of the findings above. Each is the smallest change that removes the
defect. Verification is four-part: every filed repro replayed against a live node with its control, a
148-checkpoint regression corpus diffed before and after, the test suite run both ways over every file
that can reach the changed modules, and a check that an inconsistent state stays usable everywhere the
new error could surface.

## What changed

| # | File | Change |
| --- | --- | --- |
| S1 | `packages/proto/src/qpi-container-view/{hash-map,hash-set,linked-list,collection}-view.ts` | read the occupation flags and run the consistency check **before** the empty-container shortcut |
| S2 | `packages/cli/src/trace/state-diff.ts`, `packages/proto/src/index.ts` | decode a record key with `decodeAbiValue`, which keeps a one-field struct positional |
| S3 | `packages/cli/src/trace/state-diff.ts` | report bytes past the last field only when they moved, on the same terms as a gap between two fields |
| S4 | `packages/cli/src/trace/state-diff.ts` | attach the record's key only to a **payload** leaf, never to a nested container's own bookkeeping |
| S5 | `packages/cli/src/commands/deploy-interact/call.tsx` | emit the host rows as `calls`, and a log's `typeName`; both only when present |
| S6 | `packages/cli/src/commands/deploy-interact/call.tsx` | one space between the contract name and the entry label in the nested-trap warning |

The three `state-diff.ts` fixes are one-line conditions. S1 is a reordering. S5 adds two optional keys.

### S1 — the trade, stated plainly

The early return was **not** an oversight: `packages/proto/tests/codec/qpi-container-view.test.ts` had a
test named *"HashMap view reads only population when empty"* pinning it, and two more in
`packages/cli/tests/format/trace-format.test.ts` pinned the same thing at the `readState` level. The fix
gives that optimisation up, so those three tests were updated to state the new contract and why.

The cost is one extra read of `capacity / 4` bytes, and only for a container the reader was about to
answer "empty" for. Measured end to end on the largest container I can build — an empty
`HashMap<id, uint64, 262144>`, 10 551 312 bytes, 65 536 bytes of flags — against the same live node, five
runs each, with only the four view files stashed between them:

```
before the fix:  3511  3451  3419  3470  3580 ms   (median 3470)
after  the fix:  3745  3572  3576  3596  3593 ms   (median 3593)
```

about **120 ms**, against a ~3.4 s floor that is almost entirely CLI start-up. For the small containers
in everyday use the flags are a handful of bytes.

Note the Collection needed different treatment: its `_population` counts *elements* while its flags index
*PoVs*, so the two cannot be compared directly. There the check is that an empty collection has no active
PoV, and the existing `povSlots.length > population` check stays for the non-empty case.

### S3 — also previously pinned, also deliberate

`state-diff-scale.test.ts` carried *"a region running past the last field still says so"* with a comment
defending the unconditional row: "alignment slack and a region longer than the whole state are
indistinguishable". They are distinguishable by the one thing that matters — whether those bytes moved —
which is exactly the test the branch above it already applies to a gap *between* two fields. The test was
split in two so both directions are pinned:

```
an untouched region past the last field costs no row                  -> ["tail 0 → 99"]
a region running past the last field still says so when those bytes move
                                                      -> ["tail 0 → 99", "@24 (outside any known field)"]
```

So the diagnostic survives for every byte that actually moved; what goes away is the row that fired on
every call touching the last field of any state with trailing slack.

### S4 — why `role !== "payload"` is the right cut

`memberLeaf` overwrote the nested resolve's `recordKey` unconditionally. Restricting it to payload leaves
is precise rather than approximate: in `qpi-layout`'s member tables a record's `key` and `value` members
are `payload`, a container's `_population` is `count`, and its flags, `_markRemovalCounter`, link indices
and BST indices are `internal`. So a value the contract wrote is still named by the key, and only a
nested container's own bookkeeping stops being labelled as the entry's value. A *top-level* Collection
or LinkedList is untouched either way — its records declare no `key` member, so the function returns
before this point.

There are two shapes of nested container and they take different paths, so both were run. A nested
**keyed** container (`HashMap<id, HashSet<id,4>, 2>`) carries its own `flagRecords` geometry, which the
bit-row builder prefers over the outer key, so only its `_population` was mislabelled. A nested
**unkeyed** one (`HashMap<id, LinkedList<uint64,4>, 2>`) has no such geometry, so *every* internal word
took the outer key. A fresh probe for that second shape, same deploy hash either side:

```
before:  maplists[WGWC…] = 1 (new)                      <- the list's population, as the entry's value
         maplists[WGWC…]._occupiedFlags[0] = 1 (new)
         maplists[WGWC…]._freeHeadIndex = -1 (new)
         maplists[WGWC…]._nextUnusedIndex = 1 (new)
         maplists[WGWC…][0] = 222 (new)

after:   maplists.slot[0].value 0 → 1 entries
         maplists.slot[0].value._occupiedFlags[0] 0 → 1
         maplists.slot[0].value._freeHeadIndex 0 → -1
         maplists.slot[0].value._nextUnusedIndex 0 → 1
         maplists[WGWC…][0] = 222 (new)                 <- unchanged: the element value is payload
```

Ten rows before, ten after, in both directions of the sequence: no byte that moved lost its row, the
element the contract actually wrote keeps the outer key, and `state --all` reads `complete True` /
`maplists status loaded` either side.

## Verification

**1. Every filed repro, replayed against a live node** (`QINIT_STATE_DIFF=verify` set, checked through
`/proc/<pid>/environ`), each with the control that would catch an over-reach:

```
=== S1: population 0 with occupied flags ===
  PASS  S1 hashmap reports the inconsistency          PASS  S1 hashset reports it
  PASS  S1 hashmap marks the state incomplete         PASS  S1 collection reports it
  PASS  S1 hashmap no longer answers 'loaded'         PASS  S1 linkedlist reports it
  PASS  S1 markers still read
=== control: a healthy empty container still reads as empty ===
  PASS  healthy empty state stays complete            PASS  healthy empty containers do not error
=== S2: one-field struct key ===
  PASS  S2 hashmap key renders its field              PASS  S2 hashset key renders its field
  PASS  S2 hashmap key is not undefined               PASS  S2 removal path too
  PASS  S2 control: two-field key unchanged
=== S3: trailing alignment slack ===
  PASS  S3 no phantom row on SetLast                  PASS  S3 no phantom row on SetTail
  PASS  S3 the real row survives (×2)                 PASS  S3 earlier-window write unaffected
=== S4: nested container count ===
  PASS  S4 nested population keeps its own name       PASS  S4 outer population still correct
  PASS  S4 nested population says entries             PASS  S4 nested key row still named by the outer key
  PASS  S4 no longer reported as the entry value      PASS  S4 control: array-nested unchanged
=== S5: nested call in --json ===
  PASS  S5 json carries the nested call               PASS  S5 json names the callee slot
  (a call with no nested invocation keeps the old key set — `calls` is absent, not empty)
=== S6: the nested-trap warning spacing ===
  PASS  S6 name and entry are separated               PASS  S6 no run-together name

VERIFY SUMMARY: 29 passed, 0 failed
```

The three rows that were wrong now read:

```
S2   m1[{w: 1000}] = 7 (new)                 (was m1[{w: undefined}])
S3   last 0 → 7                              (was followed by "@281 (outside any known field)")
S4   mapsets.slot[1].value 0 → 1 entries     (was mapsets[PKTG…] = 1 (new))
S5   "calls": [{"name": "invokeProcedure", "detail": "→ @29 proc #1 reward=0"}]
```

**2. The regression corpus.** A 148-checkpoint corpus replays every hand-written sequence from all three
rounds — 19 deploys, 131 captured row-sets, 15 state views and digests — against a live node, and was
captured before and after the change. Diffing the two (tick numbers normalised, since they are
wall-clock dependent):

- **All 15 state digests identical.** All 19 deploys identical (same `codeHash` per contract).
- **53 changed lines**, every one of them in exactly six categories and nothing else:

```
  3  S3  "@281 (outside any known field)" rows removed (SetLast, SetTail, SetKey on Straddle)
  8  S2  {w: undefined} -> {w: 1000}          (insert, hashset add, and both removal rows)
 10  S4  mapsets[PKTG…] = 1 (new)  ->  mapsets.slot[1].value 0 → 1 entries
  8  S1  the four carried-over containers now report their inconsistency instead of "loaded",
         and those two probes' `complete` goes True -> False
  4  S5  the "calls" key appears, carrying {"name": "invokeProcedure", "detail": "→ @29 proc #1 reward=0"}
  3  S5  "typeName": "KindAlpha" / "KindGamma" added to the log objects
```

Every other row, label, value, container view and count across all 148 checkpoints is byte-identical.

**3. Tests.** `bun run typecheck` clean. The suites covering every file touched —
`packages/proto/tests/codec`, `packages/cli/tests/{format,trace,commands}`, 66 files — went from
**662 pass / 6 skip / 0 fail** to **663 pass / 6 skip / 0 fail** (the extra test is S3's new one). Four
tests were edited, all of them pinning behaviour a fix deliberately changes; no test was deleted and no
assertion was weakened.

Beyond those 66 files, the whole of `packages/{proto,cli,engine,core,build}` plus
`packages/compiler/tests/differential/container-view-native.test.ts` — 195 files, the complete set that
can reach the changed modules — was run twice against the same node and the same `QINIT_CORE`, once with
the change stashed and once with it applied:

```
before:  1458 pass  35 skip  8 fail   (1501 tests, 195 files, 258 s)
after:   1459 pass  35 skip  8 fail   (1502 tests, 195 files, 263 s)
```

The 8 failures are the *same 8*, by name, in both runs — 6 are the core-tree layout tests, which read
files the patched header tree in this sandbox does not carry, and 2 are the core gtest corpus tests,
which need a real core-lite checkout. `diff` of the two sorted failure lists is empty. The one extra
test is S3's new one.

`packages/compiler`'s other 151 files were not run to completion: each spawns clang and the full 357-file
suite does not finish inside an hour here. Of that package only `container-view-native.test.ts` reaches
any changed module (it is the only file outside `packages/{proto,cli}` that imports
`createQpiContainerView`), and it is in the 195 above; the rest import neither the container views nor
the diff module.

**4. The inconsistent state stays usable.** S1 widens which byte patterns raise
`QpiContainerConsistencyError`, so the question is where that throw can now surface. It is caught in
exactly one place — `state-read.ts` retries once and then reports `status: "error"` — and every other
`decodeAbi` call site routes containers away from the throwing branch before reaching it
(`field.container` / `holdsContainer`), with the one remaining path already inside a
`(read failed: …)` catch. Run against the carried-over inconsistent `Carry` state:

```
state --digest      ok, 03441e78…                      (unchanged)
state --all         ✗ incomplete, "[1] bal · read failed · use --container 1 to retry
                       HashMap has 1 occupied slots but population 0"
call --proc Bump    ok, 1 row:  marker 777 → 778
call --proc Put     ok, 4 rows: bal.slot[1].key, bal[LBBU…] = 55 (new),
                                bal._occupationFlags[1] 0 → 1, bal 0 → 1 entries
call --fn Look      ok, {v: 55, pop: 1}
```

So calls, traces, diffs and the digest are untouched; only the container *view* changes its answer, from
a wrong "empty" to a named failure. `state --all` now exits 1 on such a state, which is the exit code it
already used for every other incomplete read.

## What these fixes do *not* do

- They do not touch the engine, the compilers, qpi.h, or any wire format. Only the read-back path.
- They do not change any row that names a value a contract wrote. Every label and text change is either
  a nested container's own bookkeeping (S4), a key that previously rendered `undefined` (S2), or a row
  about bytes that did not move (S3).
- S5 adds keys to the `--json` document; it removes none and renames none. `calls` and `typeName` are
  absent rather than empty when there is nothing to say, which is the convention the file already states
  ("Trace keys are absent without --trace rather than empty").
- **Not fixed, deliberately**: the two items in the "passed on" lists — the TypeScript backend accepting
  a `uint128` shift clang rejects, and `INVOKE_OTHER_CONTRACT_PROCEDURE_E` reporting `NoCallError` for a
  callee that trapped. Both are compiler/engine semantics, outside this brief, and both need a decision
  about intended behaviour rather than a reader change.
- **Still unverified on core**: both core cells remain unstartable at this commit (ABI v6 vs v7), so every
  claim above is from the two simulator cells. S3 in particular is about window shapes, and core reports
  aligned dirty pages rather than the simulator's 256-byte windows — the fix is strictly more
  conservative there (it can only remove rows about unmoved bytes), but it has not been run against core.


---

# Round 4

Same two cells as every round before it: **simulator × typescript** and **simulator × clang**. Both core
cells are still unstartable for the unchanged reason in the Cells section (repo ABI v7, the only
published core-lite release ABI v6), so nothing below is claimed for core.

`QINIT_STATE_DIFF=verify` was live on the node throughout, confirmed by reading
`/proc/23147/environ` rather than assumed, and it never threw.

This round went after the four things the earlier rounds listed as *not covered*, plus one thing the
earlier rounds created: the fixes themselves.

## Findings

### S7 — a HashMap value **update** loses the entry's key label when the key falls outside the value's 256-byte diff window

**Class**: 4 — a row labelled by the bucket instead of the key the contract wrote. **Cells**: both
simulator cells. The same three updates were replayed against a **clang** build of the identical source
(different `codeHash`, `dde39803…`) and produced the same three labels — `m[LBBU…] 100 → 501`,
`m.slot[6].value 100 → 77778`, `m.slot[0].value 100 → 1235` — so this is the reader, not a backend.

`stateDiffLines` names a record's rows by reading the key **out of the changed window**
(`entryIdentityOf`: `if (recordKey.keyOff < changedWindow.off || keyEnd > windowEnd) return undefined`).
An insert or a removal writes the key bytes too, so the key is always inside the changed region and the
row gets its name. An **update** leaves the key alone — so whether the entry has a name depends on
whether the key happens to sit in the same 256-byte window as the bytes that moved.

Minimal repro — `contracts/Windows.h` puts 240 bytes of padding before a `HashMap<id, uint64, 8>`, so the
records land across the window grid at 240 + 40·slot:

```
qinit call --proc Windows 2 --in="<id#5>id, 501uint64"   --trace   (slot 1, value @312)
    m[LBBULBSUZZCHFALHGRLJQAKPVFTCHJQJHFBDIQGYHFRIASXPNAUCEPKAMZSF] 500 → 501     detail=m.slot[1].value

qinit call --proc Windows 2 --in="<id#6>id, 77778uint64" --trace   (slot 6, value @512)
    m.slot[6].value                                                 77777 → 77778  detail=m.slot[6].value

qinit call --proc Windows 2 --in="<id#8>id, 1235uint64"  --trace   (slot 0, value @272)
    m.slot[0].value                                                 1234 → 1235    detail=m.slot[0].value
```

Same contract, same container, same operation. The `detail` is `m.slot[N].value` in all three — only the
**label** differs, and only because of where the bytes sit.

**The rule, stated and then tested.** The label survives exactly when the record's key lies in the same
256-byte window as the bytes that moved. For a value update that means the value must start at least
`sizeof(key)` bytes into its window. Predicting from the geometry alone and then updating all eight
records:

```
slot  value offset  window        offset into window   label
  0       272       [256, 512)         16              slot-only   <- predicted lost
  1       312       [256, 512)         56              KEY
  2       352       [256, 512)         96              KEY
  3       392       [256, 512)        136              KEY
  4       432       [256, 512)        176              KEY
  5       472       [256, 512)        216              KEY
  6       512       [512, 768)          0              slot-only   <- predicted lost
  7       552       [512, 768)         40              KEY
```

Eight for eight against the prediction: `offset into window < 32` ⇔ the key label is dropped.

**It gets worse as the value gets bigger.** `contracts/BigVal.h` is a `HashMap<id, Val, 2>` whose `Val` is
400 bytes, so one record spans two windows and *the same entry* is named or not depending on which field
moved:

```
Put      (insert)          m[WGWC…].head = 11 (new)        m[WGWC…].tail = 22 (new)
SetHead  (value + 0)       m[WGWC…].head 11 → 333
SetTail  (value + 392)     bm.slot[0].value.tail 22 → 444
```

Dump-to-dump for that `SetTail`: exactly one changed run, `[424..426]`, which lies in window
`[256, 512)`; the record's key is at `0..32`, in window `[0, 256)`. One window changed, so there was
nothing for `mergeAdjacentWindows` to merge with, and the key was simply not in the bytes the reader was
handed. For any map whose value is ≥ ~224 bytes, every partial update past the first window is anonymous.

**Why it matters.** The bucket index is not an identity — it is a function of the hash and the capacity.
A reader given `m.slot[6].value 77777 → 77778` cannot say which key changed, while the row above it says
`m[LBBU…] 500 → 501`. A script keying on the label sees two different shapes for one operation. The
container view (`qinit state`) is unaffected — it reads whole containers over RPC and always has the
keys — so this is also a case of two of the three readers disagreeing.

**Controls.**

1. *Same slot, different operation.* Slot 6 **insert** → `m[EZMQ…] = 77777 (new)`; slot 6 **remove** →
   `m[EZMQ…] 70006 → (removed)`; slot 6 **update** → `m.slot[6].value`. So it is not the slot. (Insert and
   remove both rewrite the key, so the changed run spans key *and* value, two adjacent windows merge, and
   the key is in range.)
2. *Same operation, different slot.* Slot 1 update keeps its key; slot 6 update does not.
3. *Not my own fixes.* Reverting `packages/cli/src` and `packages/proto/src` to the pre-fix commit
   `a4303b5` and re-running the same two updates against the same live node reproduces it exactly —
   `m.slot[0].value 81111 → 82222` and `m[DDZY…] 70001 → 83333`. S7 is pre-existing; the first attempt at
   this control was a no-op `git stash` on an already-clean tree and is discarded.
4. *Byte level.* Conservation checks on the straddling writes account for every changed run:
   insert into slot 0 → `[240..274]` (key + value, crossing 256), `[560..561]` (flags), `[568..569]`
   (population) — four rows, three runs, nothing unnamed.

**Severity**: medium-low. Nothing false is printed and no byte goes unreported; the entry is just
anonymous. But it is silent, it is invisible to the user (the 256-byte grid is not a thing a contract
author can see), and it is common: ~12.5% of records in a small-valued map, and nearly every partial
update in a large-valued one.

### S8 — a container read that spans a concurrent write can report a phantom entry keyed by the all-zero identity, with every signal green

**Class**: 1 and 4 — a record rendering as zeros where a decoded value belongs, and a record the bytes do
not support presented as real. **Cells**: both simulator cells.

`QpiHashMapView.entries()` reads **population**, then the **occupation flags**, then **one range per run
of occupied slots** — three or more separate RPC round trips. `state-read.ts` says as much in its own
comment ("Separate range reads can span a state update, so one inconsistent view is retried before
failing") and retries once on `QpiContainerConsistencyError`.

The check that retry depends on is `occupiedSlots(flags).length !== population` — **both of which are read
before the records**. A write that lands *after* the flags read and *before* the record reads is therefore
invisible to it.

**The precondition, proven against the node.** Driving the node's own read API in the order the reader
uses it:

```
tick 11578   population word  0900000000000000        = 9
tick 11578   flag word        0004000000000000        -> slot 208933 flag = 1 (occupied)
tick 11593   qinit call --proc RaceMap 2 (Del)        ok, the entry is removed
tick 11595   record @8357320 len 40                   00000000…00000000  (all zero)
```

Population and flags agree (9 = 9), so the consistency check passes — and the record the flags said was
occupied has been zeroed underneath. The node serves every read from the state as of the moment it
arrives; there is no snapshot across a container read.

**What the reader then shows.** That byte pattern — population 1, flags say slot 3 occupied, record 3 all
zero — reproduced deterministically through the documented `--allow-state-carryover` flow
(`contracts/Carry1.h` writes the header words as a raw `Array<uint64,64>`, `Carry2.h` redeploys the same
bytes as a `HashMap<id,uint64,8>` + marker):

```
qinit state Carry --all
  marker 777
  [1] bal · 1 entry · 7/8 slots unoccupied
    slot[3]  AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFXIB = 0

qinit state Carry --all --json
  ok: True   complete: True   status: loaded   occupiedSlots: 1   totalEntries: 1   error: None
  exit code 0
```

A record that does not exist, presented as "1 entry", keyed by the all-zero identity, with `complete:
true`, no error and a zero exit code. The `marker 777` is the control: it reads at its declared offset,
so the container geometry is right and this is not a misparse of the probe.

Note that the all-zero identity is the one the brief says to avoid using as a container key. This is why:
it is exactly what zeroed bytes decode to, so a phantom entry is indistinguishable from a real entry
whose key is zero.

**What I did *not* manage to do, stated plainly.** I did not catch this live. Nine hand-aligned attempts
(a removal backgrounded and a container read launched at offsets of 0.0–0.9 s, against a 262144-slot map
with 8–10 scattered entries) all produced self-consistent views. The reason is measurable: a raw
`state-read` round trip is ~10 ms and the whole RPC phase of a container read is on the order of 100 ms,
against a ~3.5 s `qinit state` cycle that is almost entirely CLI start-up — so the exposed window is a few
percent of each attempt. What is demonstrated is the precondition (reads are not snapshot-consistent
across a tick), the code path (the check cannot see a write that lands after the flags read), and the
output (what the reader prints for that byte pattern). The three together are the finding; the live
interleaving is not.

The window grows with the container: more occupied runs mean more round trips. The diff reader is *not*
exposed — its bytes come from windows the engine captures during execution, not from separate reads.

**Severity**: medium. Silent and undetectable by the user when it happens; narrow in the simulator at
these container sizes; wider for large containers and slower links.

## Round 4 — what came back clean, with the evidence

**≈80 dispatches over 7 successful deploys** — 6 in the typescript cell and 1 in the clang cell (plus 4
refused: one `Array` capacity that was not a power of two, three on a slot already held by another
contract), all through `build → node run → deploy → call → inspect`. No `stateDiffLines` was called
directly and no `DebugStateRegion` was hand-built. 6 byte-level
conservation checks (`--dump` before, `--dump` after, every changed run matched by hand against the
declared offsets and the rows).

**The S1 fix does not false-positive on an emptied container — all four keyed kinds.** This was the first
thing tested, because the fix now reads occupation flags for every container including empty ones, and a
container emptied by removal is a legitimate state whose flags are *not* zero. Each kind filled with two
entries and then emptied by removal, with no `cleanup()`:

```
HashMap    _occupationFlags[2] 1 → 2, [5] 1 → 2   population 2 → 0   _markRemovalCounter 0 → 2
HashSet    _occupationFlags[1] 1 → 2, [4] 1 → 2   population 2 → 0   _markRemovalCounter 0 → 2
Collection _povOccupationFlags[7] 1 → 2           population 1 → 0   _markRemovalCounter 0 → 1
LinkedList _occupiedFlags[0] 1 → 0, [1] 1 → 0     population 1 → 0   free list head 0 → 1

qinit state SixPack --all --json  ->  complete True; all six containers `loaded`, occ 0, entries 0, no error
```

`occupiedSlots` counts only `0b01`, so a tombstone never inflates the count; and QPI marks a Collection's
PoV `0b10` when its last element leaves, so the "population 0 with an active PoV" check I added never
fires on a real state. The raw dump confirms the flags really were non-zero (this is not a vacuous test):
`@320 = 0x820` is slots 2 and 5 both at `0b10`, `@608 = 0x208` is slots 1 and 4.

**Every non-zero byte of that emptied state reconciles against `qpi.h`.** All 17 non-zero words named,
using the member order declared in `core-v7/src/qpi/qpi_containers.h` rather than a guess — including
`@1088`, which is PoV 7's `id` retained after marking (only the flag changes on removal), and the
LinkedList's free-list chain (`_freeHeadIndex = 1`, node 1's `nextIndex = 0` pointing at the previous free
head). Container sizes 344 + 8 + 280 + 8 + 920 + 8 + 240 + 8 + 8 + 8 + 32 + 8 = 1872 = the dumped size.

**`cleanup()` on an all-tombstone container — clean.** `SetClean` on a set that is entirely tombstones
cleared both flags and the counter (`3 rows`); `CollClean` on a collection whose only PoV was marked
cleared the flag, the counter **and the retained PoV id** (`queue.pov[7] PKTG… → 0`), which is what
confirms that `@1088` residue was live data by design. Tombstone reuse from a population-0 map also works
(`bal._occupationFlags[5] 2 → 1`, population `0 → 1`).

**Diff windows inside containers — clean apart from S7.** A record whose 32-byte key crosses 256
(`[240..274]`), a record whose key ends exactly on 512 and whose value starts on it (`[480..515]`), two
array elements on opposite sides of a window edge (`big[85]`/`big[86]`), and two writes 1392 bytes apart in
one call (`p1[0] 0 → 4242`, `big[100] 0 → 9999` — two rows, nothing in between). Adjacent changed windows
merge and the straddling values render whole; non-adjacent ones produce exactly their own rows and no
phantom row between them, which is also S3's fix holding on a second, unrelated probe.

**`qinit explorer` — driven for the first time, and it corroborates.** Under tmux at 200×50 with
`capture-pane`, one key per `send-keys`. It is not a fourth container reader — it decodes no container —
but three of its numbers are independent checks and all three agree:

```
contracts view      SixPack  state 1872 B   calls 19
                    ^ matches --dump exactly    ^ matches my hand ledger of 19 dispatches, exactly
contract detail     all 19 calls listed, in tick order, each with the right entry name
                    (1 MapSet ×3, 2 MapDel ×2, 4 SetAdd ×2, 5 SetDel ×2, 6 SetClean,
                     7 CollAdd ×2, 8 CollDel ×2, 9 CollClean, 10 ListAddTail ×2, 11 ListDel ×2)
transaction detail  k "DDZYFAHIBMAKIDZEJ…"  v 333   input size 40 bytes
                    raw: 25303b46515c6772…  4d01000000000000   (0x14d = 333)
```

The decoded input and the raw hex are printed side by side, so that view checks itself; the id's hex
matches the same identity's `m256i` rendering from round 2. The `in` column in the call list shows
`1 MapSet` rather than argument values — that is `inputTypeLabel`, the input *type*, by design, not a
dropped decode.

**`--container <n>` is a load selector, not a filter.** `qinit state SixPack --container 1` prints all six
containers. That is correct: the flag forces a *collapsed* (too-large) container to load, and small ones
load anyway. Worth stating because it is the exact advice the reader gives when a container read fails
(`read failed · use --container 1 to retry`), and it reads like a filter.

**A tick rate below the transaction offset breaks call submission, as it should.**
`qinit tick rate 10` makes the chain outrun `TX_TICK_OFFSET = 3`:
`transaction tick 8432 is outside 8446..8999`. Reported here only so the next person does not read it as
a state bug; at `rate 250` and above, submission is fine.

**Still not covered, still not claimed**: both core cells (unchanged ABI reason); `qinit gtest`/`test`; the
live interleaving behind S8 (see the finding — the precondition and the output are shown, the race is not);
and `qinit explorer`'s wallet view, which is about identities and balances rather than contract state.


---

# Round 5

Same two cells, same unchanged core situation. `QINIT_STATE_DIFF=verify` live on the node throughout
(confirmed via `/proc/831/environ`) and it never threw.

**No new findings this round.** Both areas came back clean, so what follows is the evidence and the
numbers rather than a verdict. One reader disagreement is recorded as a lead.

Round 5 deliberately left my own probe contracts behind for the first half: every previous round read
state I had written myself, so a layout the reader and I both misunderstood would have agreed with
itself. The node loads 28 of Qubic core's real system contracts, whose `StateData` was written by other
people.

## What was exercised, and what came back clean

**All 28 system contracts, read with every reader.** `qinit ls` lists them; each was read with
`qinit state <name> --json`, and QX additionally with the human view, `--all`, `--container 1` and
`--digest`. They fall into exactly three groups, and each group's answer is right:

```
25 contracts   layout derived, ok=false complete=false, every field carrying
               "(read failed: short state read at N: expected X bytes, got 0)", exit 1
               — because this simulator materialises no bytes for system slots:
                 GET /live/v1/dev/state-read?slot=1&off=0&len=8  ->  {"stateSize":0,"hex":""}

 2 contracts   MLM, SWATCH — ok=true complete=true, "no scalar fields", exit 0
               — and neither MyLastMatch.h nor SupplyWatcher.h declares a StateData at all. Correct.

 1 contract    QUTIL — ok=false, error carrying the diagnostics, fields 0, containers 0, exit 1
               — qinit re-derives a system contract's IDL by parsing core's own header through its
                 QPI verifier, and QUtil.h does not pass it:
                   line 39:   `div(…)` is unqualified — write `QPI::div(…)`
                   line 1695: `mod(…)` is unqualified — write `QPI::mod(…)`
                   line 1815: Preprocessor directives (`#`) are forbidden in QPI
```

The QUTIL case is the one I initially misread as a missing layout, because my sweep printed field counts
without the `error` key. It is not: `--json` reports `ok:false` with the full diagnostic, and the human
view prints the offending lines. The distinction that matters — "no state" versus "could not read the
state" — is carried correctly in both: MLM gives `ok:true / complete:true / exit 0`, QUTIL and the other
25 give `ok:false / exit 1`.

**A real third-party layout, hand-checked against its C++ header.** `RANDOM` (`Random.h`,
`RANDOM_MAX_PROVIDERS = 4096`, `bit_4096` = `BitArray<4096>` = 512 B) — every member, in order:

```
  earnedAmount, distributedAmount, burnedAmount   uint64 ×3   -> 3 scalar fields      ✓
  bitFee                                          uint32      -> 1 scalar field       ✓
  Array<uint32, 4>        populations             ->     16 B  cap 4                  ✓
  Array<id, 4096>         providers               -> 131072 B  cap 4096               ✓
  Array<uint64, 4096>     collateralTiers         ->  32768 B  cap 4096               ✓
  Array<id, 4096>         commits                 -> 131072 B  cap 4096               ✓
  Array<bit_4096, 4096>   reveals                 -> 2097152 B cap 4096               ✓
  bit_4096                revealOrCommitFlags     ->    512 B  cap 4096               ✓
  Array<bit_4096, 32>     entropy                 ->  16384 B  cap 32                 ✓
  Array<uint64, 4096>     lockedCollateralAmounts ->  32768 B  cap 4096               ✓
  bit_4096                revealedThisTickFlags   ->    512 B  cap 4096               ✓
  bit_4096                contributedToEntropy…   ->    512 B  cap 4096               ✓
  Array<uint32, 4096>     lastUpdateTick          ->  16384 B  cap 4096               ✓
```

11 containers, 11 exact matches, including the two nested `Array<BitArray<4096>, N>` cases and the mixed
element widths in between. `GQMPROP` was checked the same way and is also right: its `StateData` really
does hold exactly two members (`proposals`, `revenueDonation`), which is what the reader shows. Across
all 27 contracts whose source parses, no container came back with a zero capacity or a zero size.

**Collection priority ordering over a deep BST — the contract itself as the oracle.**
`contracts/BstZoo.h` holds a `Collection<uint64, 64>` and a `Walk` function that traverses a PoV with
QPI's *own* `headIndex` / `nextElementIndex` / `element` / `priority`. So for every state below there are
two independent orderings: the contract's, computed inside the VM, and the CLI's, reconstructed from the
raw bytes. 25 dispatches, 5 walks, 4 comparisons — **every element matched, in order, every time**:

```
PoV A, 12 elements added with ASCENDING priorities 1..12 (a degenerate, 12-deep BST)
  oracle  1200(p12) 1100(p11) 1000(p10) 900(p9) 800(p8) 700(p7) 600(p6) 500(p5) 400(p4) 300(p3) 200(p2) 100(p1)
  cli     1200(p12) 1100(p11) 1000(p10) 900(p9) 800(p8) 700(p7) 600(p6) 500(p5) 400(p4) 300(p3) 200(p2) 100(p1)

PoV B, 9 elements: duplicate priorities and both signed extremes
  oracle  60(p9223372036854775807) 10(p50) 40(p50) 70(p7) 30(p0) 90(p0) 80(p-7) 20(p-50) 50(p-9223372036854775808)
  cli     60(p9223372036854775807) 10(p50) 40(p50) 70(p7) 30(p0) 90(p0) 80(p-7) 20(p-50) 50(p-9223372036854775808)
```

`INT64_MAX` and `INT64_MIN` as priorities both render exactly, and the two duplicate-priority pairs
(`p50`, `p0`) keep the same relative order in both readers. After an interior removal (15 rows), and
after a removal whose replacement element is dragged across from the *other* PoV (18 rows), both PoVs
still agree element for element.

**The hardest diff in the system, reconciled byte for byte.** A Collection removal relocates the last
element into the freed slot and rewires the tree, which is the most rows any single operation produces.
Dump before, dump after, every changed run matched by hand against the declared geometry
(PoVs `0..4096`, PoV flags `4096..4112`, elements `4112..7184` at stride 48, then `_population`):

```
15 changed byte runs   <->   16 diff rows
  [3040..3041] pov[47].population      q.pov[47].population 10 → 9
  [4240..4241] elem[2].bstLeft         q[2].bstLeftIndex 3 → 4
  [4256..4258] elem[3].value           q[3] 400 → 70              <- the moved element
  [4264..4265] elem[3].priority        q[3].priority 4 → 7
  [4272..4273] elem[3].povIndex        q[3].povIndex 47 → 13      <- and it changes PoV
  [4280..4281] elem[3].bstParent       q[3].bstParentIndex 2 → 15
  [4288..4296] elem[3].bstLeft         q[3].bstLeftIndex 4 → -1
  [4328..4329] elem[4].bstParent       q[4].bstParentIndex 3 → 2
  [4872..4873] elem[15].bstRight       q[15].bstRightIndex 18 → 3
  [4976..5024] elem[18].*              q[18] 70 → 0 · .priority · .povIndex · .bstParentIndex
                                       · .bstLeftIndex · .bstRightIndex   (6 rows)
  [7184..7185] _population             q 19 → 18 entries
```

16 rows against 15 runs because the last run is two adjacent 8-byte fields in one contiguous stretch.
Every changed byte is named by a row and every row corresponds to changed bytes — including the
`povIndex 47 → 13` that records the cross-PoV move. `_markRemovalCounter` neither moved nor was claimed,
which is right: removing an *element* marks no PoV.

**A `cleanup()` that had nothing to do produced 0 changed bytes and 0 rows** — the "missing diffs" class
in reverse: a no-op call invents no rows.

## A lead, recorded rather than filed

**Two readers describe the same contract differently.** For a system contract with no materialised bytes:

```
qinit state QX            ->  renders the full layout: 20 fields each "(read failed: …)",
                              "[1] _assetOrders · 302,514,192 bytes · use --container 1 to load"
qinit state QX --digest   ->  {"ok":false,"error":"no deployed contract 'QX'"}
```

One says the contract exists with a 621 MB layout it could not read; the other says it is not deployed.
Both exit 1 and neither prints a wrong *value*, so this is not one of the four classes — but the first
also offers `use --container 1 to load`, which reads like "there is data here, go get it", and following
it yields `read failed · use --container 1 to retry`. I checked the exit codes for a divergence and
there is none: `state QX`, `--container 1`, `--all`, `--json` and `--digest` all exit 1.

## Two of my own errors, caught and corrected

Recorded because the brief asks for the control that rules out my own mistakes, and twice this round the
first answer was mine rather than the tool's.

- I read an exit code as `0` after a `… | sed | grep | tail` pipeline — which returns `tail`'s status,
  the exact trap the brief warns about. Re-measured without a pipeline: every `qinit state QX` variant
  exits 1, and there is no finding there.
- I summarised the 28-contract sweep printing field and container counts but not the `error` key, and
  briefly read QUTIL's `fields=0 containers=0` as a whole state going missing. It is a reported parse
  refusal, not a silent one.

## Numbers

≈60 dispatches and state reads over 1 new deploy: 28 system-contract reads plus 7 extra reads of QX,
QUTIL and MLM across the human, `--json`, `--all`, `--container` and `--digest` readers; 21 Collection
adds, 3 removals, 1 `cleanup()`, 5 `Walk` oracle calls, 4 oracle-vs-CLI order comparisons, 4 state dumps
and 2 byte-level conservation checks. All through `build → node run → deploy → call → inspect`; no
`stateDiffLines` called directly, no `DebugStateRegion` hand-built.

**Still not covered, still not claimed**: both core cells (unchanged ABI reason); `qinit gtest`/`test`;
system-contract state with actual bytes in it, which this simulator does not produce — every system
contract here has `stateSize: 0`, so what was checked is their *layout derivation*, not their decoding.


---

# Round 6

Same two cells, same unchanged core situation. `QINIT_STATE_DIFF=verify` live on the node throughout and
it never threw.

**No new findings.** This round closed the gap round 5 named: 27 real system-contract *layouts* had been
verified, but every system slot held `stateSize: 0`, so nothing real had ever been **decoded**. Core's own
contracts turn out to be deployable into dynamic slots, which gives a third-party layout with real bytes
in it — the first time the readers face a complex state that neither I nor they authored.

## Getting core's contracts onto a dynamic slot

A straight copy is refused twice over, and both refusals are correct:

```
deploy Random.h --contract-name RANDOM   ->  contract name 'RANDOM' is reserved by system contract RANDOM at slot 3
rename the struct only                   ->  Qubic protocol violations:
                                             • Names declared in global scope have to start with the
                                               state struct name (RNDX). Found invalid name: RANDOM_BITFEE
```

So the whole `RANDOM` prefix moves, not just the struct: `s/RANDOM/RNDX/` over `Random.h` deploys clean.
That constraint is worth knowing — it is why core's contracts cannot simply be copied under a new name.

## What was exercised, and what came back clean

**A real 2.46 MB third-party state, read by all three readers.** `Random.h` as `RNDX` at slot 29:

```
ok true   complete true   exit 0
4 scalar fields, 11 containers, every one `loaded`, none in error
bitFee = 100        <- written by the contract's own INITIALIZE, not by me
state --digest      -> stateSize 2459184
```

2,459,184 is exactly what the declared layout comes to by hand (`24 + 4 + pad 4` of scalars, then
`16 + 131072 + 32768 + 131072 + 2097152 + 512 + 16384 + 32768 + 512 + 512 + 16384`), so the reader and the
C++ header agree on the total to the byte.

**Injected bytes decode to exactly the right field, index and width.** Using the documented
`--allow-state-carryover` flow — a raw `Array<uint64, 524288>` contract deployed under the same name,
poked at chosen words (each poke verified by reading the bytes straight back from the node), then the real
contract redeployed over those bytes:

```
word      byte        injected                what the real layout says lives there   what the reader said
0         0           111                     earnedAmount                            earnedAmount = 111
16390     131120      987654321               collateralTiers[0]                       collateralTiers[0] = 987654321
305351    2442808     (444 << 32) | 333       lastUpdateTick[2] and [3]                lastUpdateTick[2] = 333
                                               (two uint32s packed in one word)         lastUpdateTick[3] = 444
```

The last row is the one worth dwelling on: 2.44 MB into the state, the reader splits a single injected
64-bit word into the correct *pair* of `uint32` array elements at the correct indices.

**A stable target, and a real `HashSet` decoded.** `QReservePool.h` as `QRPX` has no per-tick hook, so an
injected state stays put. Its declared state is `id teamAddress; id ownerAddress; HashSet<id, 128>` —
`32 + 32 + 4144 = 4208`, matching the reported `stateSize` exactly (the HashSet's own 4144 being
`128 × 32` records + 32 bytes of flags + 8 population + 8 markRemovalCounter). Injecting the *same four
words* into `teamAddress` and into HashSet record slot 3, plus that slot's occupation flag and a matching
population:

```
teamAddress                        = TMNLNPDAAAAAAAMZAXAFHAAAAAAAFMOIOUKAAAAAAAYYBUBKOAAAAAAAIMEJ
allowedSmartContracts  slot[3]     = TMNLNPDAAAAAAAMZAXAFHAAAAAAAFMOIOUKAAAAAAAYYBUBKOAAAAAAAIMEJ
ownerAddress                       = RLPFPZRAAAAAAAKYCRCPVAAAAAAADLQCQEZAAAAAAAWXDODUCBAAAAAAIICF
                                     occ 1 · entries 1 · loaded · no error
```

The same 32 bytes render as the identical 60-character identity through two different code paths — a
scalar field decode and a container record decode — and the record appears at exactly the slot whose flag
was set. The identity also matches what a different contract's `providers[0]` rendered from the same four
values earlier in the round, so the encoding is stable across contracts and runs.

**The S1 fix fires on third-party code.** Same injection with `population = 2` while only one flag is set:

```
ok false   complete false   exit 1
allowedSmartContracts  status=error  occ=0  entries=0
                       error: "HashSet has 1 occupied slots but population 2"
```

That is the fix from the Fixes section working on a container declared by someone else.

## Three apparent disagreements, all of them the state moving under me

Worth writing down because they looked like findings for a while, and the method that resolved them is the
point.

Injecting bytes into `RNDX` and reading back gave, at various times, `populations[0] = 2` where I had put
7, `lastUpdateTick[1]` where I had put index 2, a missing `444`, a state that went all-zero, and finally
`burnedAmount = 654` — a value I never wrote anywhere.

Each time, reading the node's raw bytes **at the same moment** showed the reader agreeing with the bytes
exactly. Five paired samples, raw read before and after each CLI read:

```
sample 1..5:  raw @131120 before = 987654321   after = 987654321   cli collateralTiers[0] = 987654321
```

The cause is in the contract, not the reader: `Random.h` has an `END_TICK` that runs every tick and
rewrites the state — it clears an entropy stream, clears `contributedToEntropyFlags`, evicts providers
that did not reveal and burns their locked collateral. `654` is `99 + 555`, the two values I had injected
into `lockedCollateralAmounts`, summed into `burnedAmount` by that eviction path. The injected garbage was
a *valid* state for the contract to act on, and it acted on it.

The methodological lesson: a contract with a per-tick hook is not a stable substrate for testing a reader —
it eats the state between the write and the read. `QReservePool`, with only an `END_EPOCH`, is stable, which
is why the `HashSet` work above used it.

**One observation I could not reproduce, recorded rather than filed.** On the first pass, the state went
to all-zero except its first words after a carryover redeploy. Re-running the same sequence twice more —
fresh deploy, undeploy, poker, poke, carryover redeploy, read immediately and again 20 seconds later — the
bytes stayed carried over both times. I cannot reproduce it and have no evidence it is a reader problem
(the raw bytes and the reader agreed at every sampling), so it is written down and not filed.

## Two more of my own errors, caught and corrected

- A `while read … done <<'POKES'` loop where the body ran `bun`, which consumed the remaining heredoc
  lines from stdin. The loop *looked* like it poked 11 words; it did not. Every poke in the rerun is
  followed by a raw read-back of that exact byte offset, and the batch runs with `< /dev/null`. The
  `burnedAmount = 555` that first sent me looking for a decoder bug came from this, not from Qinit.
- I had been discarding deploy output to `/dev/null` and assuming success. The reruns check `ok` on every
  deploy before proceeding.

## Numbers

10 deploys (2 real core contracts, 2 poker contracts, several redeploys under carryover) and ≈55
dispatches: 32 pokes, each verified by a direct byte read-back, plus 23 state reads across the human,
`--json`, `--all`, `--digest` and raw-node readers. All through
`build → node run → deploy → call → inspect`; no `stateDiffLines` called directly, no `DebugStateRegion`
hand-built.

**Still not covered, still not claimed**: both core cells (unchanged ABI reason); `qinit gtest`/`test`; and
a real core contract driven through its *own* procedures rather than by byte injection — `RevealAndCommit`
needs a 512-byte `bit_4096` input and collateral, and `registerVault` a 16-element owner array, so both
were left for a later round.

---

# Fixes — S7 and S8

Applied on the same branch, on top of round 4. Both defects were reproduced and root-caused in round 4
and left open because each needed a decision rather than a patch. One mechanism answers both: a per-slot
**state version**, produced by both runtimes and consumed by both fixes. S8 compares it across the reads
that compose one container view; S7 uses it only to decide whether a key fetched *now* may be trusted for
a trace captured *then*.

Verification is the treatment S1–S6 received — every repro replayed against a live node with its
control, the 148-checkpoint regression corpus diffed, the suite run over every file that can reach the
changed modules, a typecheck — plus three things the earlier rounds could not do: a run against an
**unpatched** node, to show the client degrades to exactly today's behaviour rather than to a worse one;
a measurement of what the new error costs on a busy contract; and a core cell that finally builds and
starts, though it still cannot be driven (see below).

## What changed

| # | File | Change |
| --- | --- | --- |
| S7.1 | `packages/cli/src/trace/state-diff.ts` | decode the merged windows once, and look a record's key up across **all** of them instead of only the window whose bytes moved |
| S7.2 | `packages/cli/src/trace/state-diff.ts`, `format.ts`, `commands/deploy-interact/call.tsx` | when the key is in no window at all, read it back from the node — guarded by the state version, and never for a removal |
| S7.3 | `packages/cli/src/trace/state-diff.ts`, `views.tsx` | mark a row whose key stayed unresolved, so the fallback is visible instead of silent |
| S8 | `packages/cli/src/trace/state-read.ts` | hold the first response's version in the byte source and fail the container if a later response reports a different one |
| — | `packages/engine/src/contract/{registry,runtime}.ts`, `qubic-simulator.ts`, `transport.ts`, `logging/trace.ts` | the simulator produces the version: a per-slot counter bumped on every non-function dispatch, returned by `stateRead` and recorded on the trace entry |
| — | `packages/core/src/net/{transport,rpc/client,rpc/types}.ts` | carry the optional field over the wire |

Sixteen files, +378 −56, eleven new tests. The version is **optional at every hop**: a node that does not
send it leaves both new paths inert, so the client, the engine and core-lite ship independently and in
any order.

### S7 step 1 needs nothing from the node, and is the only thing that can fix a removal

The key insight that made this small: if a record's key bytes *changed* during the dispatch, they are
already in the diff by construction — just in a different, non-adjacent window, which
`mergeAdjacentWindows` never joined and both bounds checks never looked at. Recovering them is local.

That matters beyond code size, because it is the **only** correct fix for the removal case. A removal
zeroes the record, so a key read back after the fact returns zeros and would label the row `m[AAAA…]` —
a confident lie, strictly worse than the honest bucket fallback. Step 1 recovers the real key from the
*before* image; the fetch in step 2 is therefore wired to `entryIdentityOf` only, never to `namedFlags`,
and `keyForLabel` refuses the fetched key whenever the flag says the entry left.

### S8 lives in the one RPC-backed byte source

`stateByteSource` is the only `QpiByteSource` that talks to a node — every other one is in-memory and
inherently consistent — and a fresh one is built per retry attempt. Putting the check there means **no
change to `packages/proto` and none to any of the six container views**, and it covers every kind at any
size, including `array-view` and `bit-array-view`, which have no invariant of their own and until now
accepted a torn read in silence.

The retry loop is untouched: a version mismatch is just another `QpiContainerConsistencyError`, so one
inconsistent view is still retried before the container fails. A container that cannot settle reports
`status: "error"` with `complete: false` and exit 1 — the existing failure shape, with a message naming
the field and the version transition. No new status was added.

## Verification

**1. S7 replayed against a live node** (`QINIT_STATE_DIFF=verify` throughout, confirmed by reading
`/proc/15251/environ`, not assumed). `contracts/Windows.h`, all eight records updated — the same
experiment round 4 used to state the rule:

```
                        before (round 4)            after
slot 0  value @272      m.slot[0].value             m[UQNKTPSXQUDRKDQSXCPLDAPVOJZFWXJTNZRTZHKACBSFXSFYVLRBJKUBBJYC]
slot 1  value @312      m[LBBU…]                    m[LBBU…]
slot 2..5, 7            m[…]                        m[…]
slot 6  value @512      m.slot[6].value             m[EZMQOEPYEZQOGBELDVMBMADACHVDANNNIXWCBBNZJGKUNMUNXVLNIQMBJGJI]
```

Eight for eight. The two keys the reader fetched are exactly the ones the container view — an independent
reader over the same bytes, which never lost them — reports for those buckets.

Repeated on the **clang cell** (same source, `qinit deploy --compiler clang`, same node), the two records
that were anonymous before come back named there too — `m[UQNK…] 1008 → 3008` and `m[EZMQ…] 1006 → 3006`.
The diff reader is compiler-independent, as round 4 found when filing this, and the fix is too.

`contracts/BigVal.h`, the amplifier where one record spans two windows:

```
SetTail (value + 392)   before:  bm.slot[0].value.tail  22 → 444
                        after:   bm[WGWCHSCIUWGLKESIGVCONKSXRDZGYHZXDDODDKNUBCQRCGNCNMOWZVXAJQJF].tail  22 → 444
```

**2. The controls that would catch an over-reach.**

```
remove id#8 (slot 0)    m[UQNK…] 2008 → (removed)     — the real key, from the before image
remove id#6 (slot 6)    m[EZMQ…] 2006 → (removed)     — never m[AAAA…]
re-insert id#8          m[UQNK…] = 4242 (new)         — inserts still named
```

The all-zero identity never appears. This is the anti-regression the design was shaped around.

**3. Safe degradation, measured rather than argued.** The same eight updates, same new client, against a
node running the **pre-fix** engine (started before the commit, so it serves no version):

```
slot 1..5, 7    m[…]                                     — named, exactly as today
slot 0, 6       m.slot[0].value / m.slot[6].value        — anonymous, exactly as today
                keyUnresolved: true                      — the one difference: the fallback now says so
```

No fetch is attempted, nothing throws, no row changed. The client is strictly additive against an old
node.

**4. S8, end to end, with both controls.** `contracts/RaceTick.h` is a `HashMap<id, uint64, 131072>`
fragmented by 24 scattered keys — 24 occupied runs, so one container view costs 26 sequential reads —
next to an `END_TICK` that writes state on every tick. The race is then a property of the contract rather
than of timing luck.

```
                                                              reads  reported error
post-fix client, writer every 20 ms                             12        12
post-fix client, writer every 5000 ms  (quiet control)          12         0
pre-fix  client, writer every 20 ms    (same node, same map)    12         0
```

The middle row is the false-positive control: on a quiet node every read still comes back `loaded`,
`complete: true`, 24 occupied slots. The bottom row is the one that matters — the **pre-fix client saw
the same twelve interleavings and called every one of them complete**. The new message names both the
field and the transition:

```
big changed while it was being read (state version 268 → 269)
```

At the byte level, three raw reads of the same offset through the node's own API: version 7, version 7,
then a procedure call, then version 8. Stable while nothing writes; moves exactly when something does.

**5. The churn this costs, measured.** The policy chosen for a container that cannot settle is the
existing error shape. On this probe — which writes on *every* tick, the worst case by construction — the
error rate against the tick period is:

```
tick 50 ms (the engine default)   20/20 reads error
tick 100 ms                        3/20
tick 200 ms                        0/20
tick 400 ms                        0/20
```

Read honestly: a contract that writes state every tick, whose container is large enough to need more than
a tick's worth of round trips, is **unreadable** at the default tick rate — every attempt reports the
race rather than a view. That is correct behaviour (the writes are real and the old answer was a stitched
view reported as complete), but it is a real cost, and it is the strongest argument for the follow-up the
plan already named: narrow the comparison to writes that overlap the ranges actually read, using the
write journal both engines already keep. A per-slot version cannot tell a write to `ticks` from a write
to `big`; this probe's `END_TICK` only ever touches `ticks`, and the read still fails.

Contracts that write only when called are unaffected — that is what the quiet control measures.

**6. The corpus.** The 148-checkpoint regression corpus — every hand-written sequence from rounds 1–3,
19 deploys, 15 state digests, replayed end to end — captured before and after:

```
1290 lines captured, 1 changed
< mapsets.slot[1].value.slot[1]              | 0 → LBBU…
> mapsets[PKTGIKYHNHNMMFZJDPYUKFZTKDPAVBWBFVJDWUTVDDFRWEIWPCBAUODAFZAK].slot[1] | 0 → LBBU…
```

All 15 digests byte-identical, all 19 deploys identical, and the single changed line is the intended
category: a nested container's row that was named by its bucket is now named by the outer record's key.
The checkpoint is a `SetAdd` whose own input is `PKTG…id, LBBU…id` — the key the new label prints is
literally the argument the call was given.

**7. Tests.** `bun run typecheck` clean. The 195-file scope — all of
`packages/{proto,cli,engine,core,build}` plus `packages/compiler/tests/differential/container-view-native.test.ts`,
the complete set that can reach the changed modules:

```
before (round 6 tip):  1459 pass  35 skip  8 fail   (1502 tests)
after:                 1470 pass  35 skip  8 fail   (1513 tests)
```

The 8 failures are the *same 8 by name* in both runs — `diff` of the sorted lists is empty — and all 8
are environmental, not behavioural: they read a core checkout this sandbox's header tree does not carry.
The 11 extra tests are the 11 new ones.

## The core cells, at last — and how far they got

Six rounds reported both core cells unstartable because the only published core-lite release was ABI v6
against the repo's v7. With a checkout of `develop` in hand that is no longer true, so this round built
one: `cmake -DLITE_WASM_SC=ON -DTESTNET=ON -DTESTNET_LITE_RAM=ON`, clang 18, WAMR pinned at
`0e47872`, libffi — **`[100%] Built target Qubic`, with the patch applied**. That is real compile
verification of all four changed headers, not the extracted-snippet check that preceded it. The node
then started and ticked (epoch 230, 1.0 s/tick, `QINIT_STATE_DIFF=verify` confirmed through
`/proc/6820/environ`).

It could not be **driven**, and the reason is worth stating exactly rather than rounding off to
"unavailable":

```
node.log:53   Error opening file in load spectrum.230!
/live/v1/dev/funded-seeds  ->  8 seeds, every one of them balance 0
deploy                     ->  ok:false, "signer … has no balance on this node —
                               it accepts the transaction and then drops it at tick assembly"
/live/v1/dev/state-read    ->  {"error":"bad slot"} for every index tried (1..6, 9, 10, 29, 30)
```

The node starts with an empty spectrum, so nothing can pay for a deployment; with no contract loaded
there is no slot for the patched reader to answer for. **So the core runtime behaviour of this patch is
unverified**: what is verified there is that it compiles into a real build and that the node runs with
it. Everything behavioural above is from the two simulator cells. The seqlock's own logic is covered
separately, below, by a test that compiles the shipped source text.

## The core-lite side

Four existing files under `src/extensions/`, +98 −5, **no new file**. No upstream file is touched, so it
does not conflict with merges from `qubic/core` and does not disturb the `contract_def.h` markers
`qinit integrate` parses. The commit is local in the core-lite clone; the patch is at
`/home/user/core-lite-state-seq.patch` and applies cleanly to `develop` at `f8c2990`.

| File | Change |
| --- | --- |
| `wasm/runtime/state_backend.h` | the counter and its RAII scope, beside the existing `g_wasmOwnedSlot[contractCount]` |
| `wasm/runtime/dispatch.h` | raise the scope around a writing dispatch and a migration; record the post-dispatch version on the trace entry |
| `wasm/runtime/trace.h` | the trace entry carries `stateVersion` |
| `http/controller/rpc_live_controller.h` | the seqlock read loop, `json["version"]`, and `stateVersion` in the debug-trace JSON |

**Why a seqlock and not `contractStateLock`.** That lock is writer-priority; holding it across a
multi-megabyte hex encode on an HTTP worker would stall the contract processor for the whole encode. The
seqlock never blocks the writer at all — it only lets the reader find out, afterwards, whether its copy
was clean.

**What it cannot disturb.** The counter lives outside the state bytes, so `K12(StateData)`, the contract
digest, the state files and consensus are byte-identical with or without it. A counter kept *inside* the
state buffer would change every digest and break consensus — which is why it is not there.

**The seqlock's own test.** The concurrency argument is not something a reading can settle, so it was
measured. A test extracts the declaration and scope from the shipped `state_backend.h` (not a copy of
them), compiles them, and runs the controller's exact read loop against a writer thread that tears the
bytes on purpose — the writer only ever leaves a buffer where every byte is equal, so any snapshot the
reader calls trustworthy must be self-consistent.

```
patched reader          20000 reads   19626 carried a version   374 withheld it    0 torn reads reported
negative control        20000 reads   20000 carried a version     0 withheld it  551 torn reads reported
(same writer, same reader, sequence check disabled = the pre-patch behaviour)
```

The control is the point: the test can see tearing (551 of it), and with the check in place it reports
none, while still serving a version on 98% of reads. The same run also asserts the two invariants that
are easy to get wrong — a nested scope must not close the write window, and the version
`finishDispatchTrace` records must equal the value the sequence settles on once the outermost scope is
gone.

## Two of my own errors, caught and corrected

**A new header file, which qinit validates against.** The patch first declared the counter in a new
`src/extensions/wasm/runtime/state_seq.h`. That is a file in a directory qinit checks: running the
repo's own suite against the patched checkout turned `packages/core/tests/wasm/headers.test.ts` red —
*"declares every shared, SDK, and runtime source exactly once"* — because `CORE_WASM_HEADERS` is a
canonical manifest of that tree and the new file was not in it. Adding the manifest entry would have
been worse, not better: it would then fail the other way for anyone on an unpatched core-lite, coupling
two repositories that ship separately. The counter moved into `state_backend.h` beside
`g_wasmOwnedSlot[contractCount]`, which the plan had named in the first place and which already carries
that dependency. `23 pass / 0 fail` against the patched checkout afterwards. The lesson is the one the
brief keeps making: run the tool against the thing you changed, rather than reasoning about it.

**A reader that could return no bytes.** The first read loop `continue`d when it found the sequence odd,
and with a budget of two attempts a slot written twice in a row would fall out of the loop with `hex`
still empty — a response claiming `len: N` and carrying nothing. The loop now copies on every attempt and
withholds only the *version*, never the payload. Caught by reading the loop back before committing, not
by a test, which is worth admitting.

## What these fixes do *not* do

- They do not widen `DIFF_WINDOW`. It would reduce S7's rate without closing it — the window a record
  needs scales with its value size, which is unbounded — and it would enlarge every trace payload on
  every call.
- They add no logic to `packages/proto` and change no container view.
- They give S8 no new status. A container that cannot settle uses the existing error shape.
- **The churn is real and is the open question.** A per-slot version cannot tell a write to one field
  from a write to another: `RaceTick`'s `END_TICK` only ever touches `ticks`, yet a read of `big` still
  fails, because the slot's version moved. On a contract that writes every tick, at the engine's default
  50 ms, that is every read. The narrowing fix — compare only against writes that overlap the ranges
  actually read, using the write journal both engines already keep — is a larger change than this one and
  was deliberately left out; these measurements are the argument for doing it next.
- **Unverified on core**, per the section above: compiled and running there, never driven.

---

# Round 7

S1–S8 merged, and `main` then moved 22 commits — including `17b93ef`, a rewrite of the very module four
of those fixes live in. Round 7 turns the eight findings around: they stop being results and become the
oracle a stranger's rewrite has to satisfy.

## The rewrite, and why it needed a regression sweep

`17b93ef walk the state diff by type and render each row once` replaced `state-diff.ts` (476 added, 467
removed) and, in its own words, made "the leaf, cursor and annotation types go away". The two-pass design
S2/S3/S4/S7 were fixed inside — physical rows first, annotation afterwards — is gone, replaced by a single
pass that builds each row with its entry already known. Every one of those four fixes lived in the part
that was torn out. `8ccbc42 pin a window ending inside an alignment gap` and `5ec5d3d test population 0
over occupied slots in every container` land on S3's and S1's ground as well.

Nothing about that is careless — reading it, the rewrite carries the old reasoning forward, comments
included. But reading is not testing, so every filed repro was replayed through the real flow:
`build → node run → deploy → call --proc → inspect`.

## The sweep came back clean

| Repro set | Result |
| --- | --- |
| S1–S6, every filed repro plus its controls | **29 passed, 0 failed** |
| S7 — value updates still named by their key | **8 / 8**, none fell back to the bucket |
| S7 control — a removal must not be named by a key read back after the record was zeroed | passed; never produced `m[AAAA…]`, still named the real key from the before-image |
| S8 — a view stitched across a write is reported | **12 / 12** on a write-every-tick contract at the 50 ms default |
| S8 control — a quiet contract must not report a race | **0 / 12** false positives |

The controls are the point: a sweep that only checks the fixed behaviour cannot tell a surviving fix from
a reader that has stopped reporting anything at all.

Two independent signals agree the tree is healthy: `bun run typecheck` exits 0, and the full suite gives
**2224 pass / 834 skip / 2 fail across 362 files** — the 2 failures environmental, needing a core checkout
via `QINIT_CORE`, and passing **7 / 7 / 0** when it is set.

## E1 — the past-capacity warning guards the harmless case and misses the corrupting one

`9640a60` and `1c0c57a` added a warning for a `BitArray` bit set beyond its declared capacity. It fires
on the case that cannot hurt anyone and stays silent on the case that silently overwrites live state.

QPI forces a power-of-two capacity (`static_assert(L && !(L & (L - 1)))`), so the two regimes are exact:

| Capacity | Storage | `set(i)` past capacity | qinit today |
| --- | --- | --- | --- |
| `< 64`, e.g. 32 | one whole word, a dead tail | lands in the tail, nothing reads it | **⚠ warned**, `(past capacity 32)` |
| `>= 64`, e.g. 128 | whole words, **no tail at all** | word index **wraps** onto a live word | **silent** |

`get`/`set` mask the word index — `_values[(index >> 6) & (_elements - 1)]` — so on a `BitArray<128>`,
`set(200)` resolves to word `(200 >> 6) & 1 = 1`, bit `200 & 63 = 8`: **absolute bit 72**, an ordinary
in-capacity bit. The write corrupts real data and is indistinguishable from a deliberate `set(72)`.

Probe `BitCap.h` (appendix), both cells:

```
set(small, 40)  ->  small[40] | 0 → 1 (past capacity 32)     ⚠ warning on the container
set(large, 200) ->  large[72] | 0 → 1                         warnings = None
set(large, 72)  ->  large[72] | 0 → 1                         byte-identical row
```

The oracle is the raw bytes, read with `--dump`, not qinit's own row:

```
large (8..24) : 00000000000000000001000000000000
large bits set: [72]        small bits set: [5, 40]
```

**Cells:** simulator × typescript and simulator × clang, identical output on both.

**The controls that rule out tester error.** The dump shows independently which bit moved, so the aliased
index was not inferred from the output being accused. `set(72)` produces a byte-identical row, which is
what makes the two indistinguishable rather than merely similar. And the `small` warning firing on the
same contract, in the same call sequence, proves the warning machinery works — silence on `large` is the
finding, not a broken harness.

**What cannot be fixed, and where the fixable part is.** The mask happens inside the wasm, so by the time
state bytes exist the request for 200 is gone: **qinit's reader cannot detect this at all**, and no
reader-side warning is possible. The compiler validates only that the bit count is a power of two
(`validatePowerOfTwoDimension`) and has no index check — and could not catch a runtime index regardless.
So the actionable defect is narrower than "add a warning". `docs/cli-guide.md:1192` presents mechanism and
consequence as one: *"core's `set(i)` masks only the word index, so an out-of-range `set` lands past the
declared length"*. That consequence holds **only below 64**; above it the same mask lands *inside* the
declared length. The container warning's own text generalises the same way — *"core doesn't reject"* —
while only ever firing for the small case.

**Severity: moderate.** No one is lied to about bytes; qinit reports both cases faithfully. But a
developer reading the documentation, or trusting the ⚠, would conclude out-of-range sets are surfaced. On
the arrays where such a set corrupts live state, they are not.

## A lead, recorded rather than filed

`changedWindowsOf` sets `end = off + Math.min(before.length, after.length)`, deliberately conservative
against a window whose two images differ in length. `imageAt` then bounds a key lookup against the
individual side's `image.length` instead of that `end`, so on a lopsided window it could read past the
agreed end on the longer side.

Not filed, because it is unreachable from this engine: `diffRegions` slices both images from the same
range, and `journalRegions` sizes `after` from `before.length`. Equal by construction. Reaching it would
mean hand-building a `DebugStateRegion`, which is not an oracle this engagement accepts — a defect that
only exists when the inputs are fabricated is not a defect yet. Worth a second look if a producer ever
emits an unequal pair.

## One of my own errors, caught and corrected

The env control in the new S7/S8 driver reported that it could not confirm `QINIT_STATE_DIFF=verify`, and
I reported that failure before diagnosing it. It was my harness, not the environment: `qinit node run`
daemonises, and the surviving process is `index.tsx __serve`, which the pattern `dev node run --runtime
simulator` was never going to match. Reading `/proc/<pid>/environ` of the real daemon shows
`QINIT_STATE_DIFF=verify` present. The corrected S7/S8 score is **6 passed, 0 failed**, and the pattern is
fixed in the driver.

A second, smaller one: `qinit state --dump` writes to `state/<Name>_dump.bin` **inside the repository**.
It takes `--out`, and every dump in this round now goes to the scratchpad.

## Numbers

- 22 commits landed on `main` between the S1–S8 merge and this round; `state-diff.ts` rewritten, 476 added
  and 467 removed.
- 8 fixed defects replayed, **35 checks, 0 failures** (29 in the S1–S6 sweep, 6 in the S7/S8 driver).
- Suite **2224 / 834 / 2** across 362 files; typecheck exit 0.
- 1 finding filed, 1 lead recorded, 2 tester errors caught and corrected.
- An empty 10 551 312-byte HashMap still reads in **2144 ms**.

## Not covered by this round

`state-format.ts` and the failed-field flagging of `af1d96f`, and the new edges the single-pass walk
creates — a type straddling a window boundary, a key resolvable only from a sibling window. `main` moved
again during the round (`d6b7f86`, `7f8336f`) and touched `state-format.ts` and `state-read.ts` further,
so that surface is best hunted against the newer tree rather than the one this round measured.

# Round 8

Round 8 found nothing. Two surfaces were hunted and both held, so what follows is the evidence that they
held rather than a finding — a round that comes back empty still has to show its work, otherwise "no
findings" is indistinguishable from "did not look".

## The failed-field flagging

`af1d96f flag failed state fields instead of matching their text` fixed a defect of exactly the class this
engagement hunts: completeness searched each field's *rendered text* for the failure markers, so a struct
member named `undecodable` made a healthy read report incomplete and exit 1. The question for this round
was whether the fix is complete, and in particular whether the dangerous direction — a genuinely failed
read reported as fine — was opened in the process.

It was not.

- The two sites that produce a failure message (`field.bad`, and the `catch` around the decode) are the
  only two that set `failed`, and they set it adjacently. No other path writes a failure message.
- `stateIsComplete` now reads `!fields.some(f => f.failed) && containers.every(c => c.status !== "error")`.
  No text matching survives anywhere in completeness; the two remaining string occurrences in the CLI are
  a renderer and a UI label, neither of which decides anything.
- Probe `FailWords.h`: a struct that renders `{undecodable: 5, readFailed: 7}` — real data reading exactly
  like an error message — gives `complete: True`, `failed=None`, **exit 0**.

One lead inside this area was chased and closed. `qinit state --json` does **not** use the new flag; it
still infers failure from a proxy:

```ts
value: field.data ?? null,
error: field.data === undefined ? field.value : null
```

That is the same shape of mistake the commit had just removed from completeness, so every path that sets a
slot value was traced. They cannot disagree: the only two sites that set `failed` are exactly the two that
leave `data` unset, and the successful path assigns `data` last, so a throw anywhere in it leaves `data`
undefined. The remaining way to break the proxy would be a *successful* decode that yields `undefined`.
Probe `JsonShapes.h` exercised the shapes most likely to produce one — a one-field struct, a two-field
struct, a one-field struct nested in another, a one-field struct of `id`, an `Array` — because a one-field
struct is unwrapped by `decodedAbiToJson` and was the source of S2. All five decode cleanly, every field
reports `error=null`, and the human view agrees with the JSON character for character, including
`nestOne {only: 12}`.

## The single-pass walk, under byte-level conservation

`17b93ef` rewrote the walk to visit only the parts of each type that share a byte with a window. That is a
sharper rule than the walk it replaced, so the edges it creates were checked against an oracle that knows
nothing about qinit's opinion of them: dump the state before and after a call, compute the changed byte
ranges directly, and require that rows and moved bytes agree in both directions.

```
BigPair adjacent (proc5)     bytes moved:    2 in 2 run(s)   rows: 2
Far non-adjacent (proc6)     bytes moved:    2 in 2 run(s)   rows: 2
Pad p1 earliest window       bytes moved:    1 in 1 run(s)   rows: 1
MapDel record 0              bytes moved:   37 in 4 run(s)   rows: 5
MapDel again (no-op)         bytes moved:    0 in 0 run(s)   rows: 0
CONSERVATION: OK
```

The last line is the one that matters. A call that changes nothing produces no row, which is precisely
S3's failure mode — a phantom row on every call touching the last window. The `Far` case covers two
non-adjacent windows, which only exactly-adjacent merging joins, and `MapDel` covers a removal, where the
record is zeroed and four separate runs move at once.

## Two closed leads

- `imageAt` bounds a key lookup against the individual side's `image.length` while `changedWindowsOf`
  computes `end` from `Math.min(before.length, after.length)`. On a lopsided window those disagree.
  Unreachable: `diffRegions` slices both images from the same range and `journalRegions` sizes `after` from
  `before.length`, so the two are equal by construction. Reaching it would mean fabricating a
  `DebugStateRegion`, which is not an oracle this engagement accepts.
- `stateIsComplete` rejects only `status === "error"`, so a `collapsed` container leaves a read
  `complete: true` despite its bytes never being read. Documented, deliberate: *"a collapsed block is
  neither an error nor an incomplete read"* (`docs/cli-guide.md:1300`). Not a defect.

## Three of my own errors, caught and corrected

- The conservation run first reported two mismatches. Both were mine: `BigPair` takes three inputs and
  `Far` takes two, and I had the procedure numbers swapped. Corrected, the battery is clean.
- The environment control matched its own shell. `pgrep -f "index.tsx __serve"` and then
  `pgrep -f "bun.*index.tsx __serve"` both match the bash process running the check. `nodepid.sh` now
  selects on `argv[0]` being the bun binary, which cannot match the checking shell, and confirms one node
  with `QINIT_STATE_DIFF=verify`.
- Reported "could not confirm verify" as a result before diagnosing it as a harness fault. The environment
  was correct throughout.

## Numbers

- 2 surfaces hunted, **0 findings**, 2 leads closed with the reason each was closed.
- 12 conservation cases across window boundaries, non-adjacent windows, removals and a no-op: all agree.
- 5 decode shapes probed for a `data === undefined` false positive: none produced one.
- 3 tester errors caught and corrected.

# Round 9

Two findings, and the first arrived by way of a hypothesis that turned out to be wrong.

## The lead that was wrong, and what testing it exposed

`pastCapacityWarnings` keys each row on `line.label.match(/^(.*)\[(\d+)\]$/)` and `continue`s when the
label does not end in `[digits]` — a warning dropped with no trace. The obvious suspects were BitArrays in
positions whose label might not take that shape, so `BitNest.h` put one at four depths: top level, inside
a struct, inside an `Array` element, and inside a `HashMap` record.

The hypothesis was wrong. All four produce a matching label, including the deepest:

```
plain[40]
inStruct.flags[40]
inArray[0].flags[40]
inMap[DDZYFAHIBMAKIDZEJRBWRKZMLCXFFKVHAKGEKZGTZABSIHSIKWBTFDSBEXLO].flags[40]
```

Every one of those diff rows carries `(past capacity 32)`. The regex is fine. But the same four positions
read back through `qinit state` do not agree with each other, which is E1.

## E1 — a nested BitArray renders as all-zero while its bytes carry a set past-capacity bit

Where a BitArray gets its own container block it is listed and warned. Where it is rendered inline as part
of an enclosing element's value, only the declared range is rendered and the set bit vanishes:

```
plain            [0..31] = =0 ×32 (skipped)
                 [40]    = =1 (past capacity 32)          ⚠ warned

inStruct.flags   [0..31] = =0 ×32 (skipped)
                 [40]    = =1 (past capacity 32)          ⚠ warned

inArray[0]       {lead: 0, flags: [0..31]=0 ×32 (skipped), trail: 0}    warnings = None
inMap slot[5]    {lead: …}                                              warnings = None
```

This is not merely a missing warning. `qinit state` **displays the array as clean** while its storage
carries a set bit, so a reader auditing the state concludes the opposite of the truth.

The oracle is the raw dump, which knows nothing of how qinit chose to render anything:

```
typescript  plain @0   set=[40] past32=[40]      clang  plain @0   set=[40] past32=[40]
            inStruct.flags @16 set=[40]                 inStruct.flags @16 set=[40]
            inArray[0].flags @40 set=[40]               inArray[0].flags @40 set=[40]   <- rendered clean
            inArray[1].flags @64 set=[]                 inArray[1].flags @64 set=[]
```

**Cells:** simulator × typescript and simulator × clang, identical on both.

**The controls that rule out tester error.** `plain` and `inStruct.flags` warn in the *same* command on the
*same* contract, so the warning machinery is working and the silence is the finding rather than a broken
harness. The dump shows independently that the byte is set. `inArray[1].flags` is empty exactly as
expected, which validates the offset arithmetic used to read the other three. And the diff row at write
time *did* warn for `inArray`, so qinit saw the write and lost it only on read-back.

**Severity: moderate, and unlike round 7's E1 this one is fixable.** There the request was destroyed inside
the wasm before any byte existed. Here the reader already holds the bytes it rendered the element from; it
simply does not descend into array elements or record values to inspect a BitArray's tail.

## E2 — the typescript compiler permits a mutation through `const T& get()`, and the write persists

Found while building E1's second cell. The first `BitNest.h` wrote through an array element directly:

```cpp
state.mut().inArray.get(input.slot).flags.set(input.idx, true);
```

The typescript cell compiled it, deployed it, and the write **persisted** — the dump above shows
`inArray[0].flags` bit 40 set by exactly that call. The clang cell refuses the identical source:

```
error: 'this' argument to member function 'set' has type 'const BitArray<32>', but function is not marked const
note: 'set' declared here   (core-v7/src/qpi/qpi_containers.h:35)
```

QPI is unambiguous — `inline const T& get(uint64 index) const`. Clang is right; the typescript backend is
wrong, and wrong in the direction that lets state change through a path QPI forbids.

**The controls.** The two sources are byte-identical apart from the struct rename (`diff` of the two
procedure bodies is empty). The QPI header states the signature. Clang's diagnostic names precisely that
const-ness. And the typescript deploy returned `ok=True` with the mutation visible in the raw bytes, so
this is not a compile-only divergence — the write took effect.

**Severity: notable.** A contract developed against the typescript cell can compile, run, and appear correct
while being unbuildable for the real core. The parity suite (`container-parity.test.ts`) is the natural
home for a case covering mutation through a const accessor.

## Numbers

- 4 nesting depths probed; 4/4 diff rows warn, **2/4 container views warn**.
- Both findings reproduce on **2 of 2** buildable cells.
- 1 hypothesis falsified before it could become a false finding.
- Raw-dump oracle on both cells; `inArray[1]` empty as the arithmetic self-check.

# Round 10

Round 9's E2 was found sideways — a probe that would not build on the clang cell. This round asks whether
it was one accessor or a class of them, with clang as the oracle for what QPI actually permits.

## The battery

`qpi_containers.h` declares exactly four public accessors returning a const reference:

| Container | Accessor | Line |
| --- | --- | --- |
| `Array` | `const T& get(uint64) const` | 133 |
| `SlowAnySizeArray` | `const T& get(uint64) const` | 268 |
| `HashMap` | `const KeyT& key(sint64) const`, `const ValueT& value(sint64) const` | 371, 374 |
| `LinkedList` | `const T& element(sint64) const` | 723 |

One minimal contract per accessor, each mutating a `BitArray<64>` reached *through* it, compiled on both
cells:

```
case            typescript  clang       verdict
ArrGet          OK          REJECT      ** DIVERGENCE **
MapValue        OK          REJECT      ** DIVERGENCE **
MapKey          REJECT      REJECT      agree
ListElem        OK          REJECT      ** DIVERGENCE **
```

Clang's diagnostic is the same in every rejection, and it names the contract precisely:

```
error: 'this' argument to member function 'set' has type 'const BitArray<64>', but function is not marked const
```

## E1 — three QPI accessors declared `const T&` accept mutation on the typescript cell, and the write lands

Compiling is only half of it. Both divergent cases were deployed on the typescript cell, the state dumped
before and after one call, and the changed bytes compared:

```
MapValue: 416 bytes, changed at [45, 408, 409]   marker bytes moved: 2   OTHER bytes moved: 1 -> [45]
ListElem: 312 bytes, changed at [13, 304, 305]   marker bytes moved: 2   OTHER bytes moved: 1 -> [13]

MapValue: byte 45  0x00 -> 0x01   bit set = 0
ListElem: byte 13  0x00 -> 0x01   bit set = 0
```

The two marker bytes are the procedure's one legal write. The single remaining byte in each case is
`0x00 -> 0x01` at a byte-5 offset into the `BitArray<64>` — absolute bit 40, exactly what the const
accessor was told to set. The write is not optimised away and does not land in a temporary: it reaches
contract state through a path QPI forbids and the real core cannot compile.

Round 9 established the same for `Array::get`, where the mutation persisted into `inArray[0].flags`.

**Cells:** simulator × typescript accepts and executes; clang rejects at compile time. The divergence is
the finding, so it exists only across the pair.

**Severity: notable.** A contract can be written, compiled, deployed and observed behaving "correctly" on
the typescript cell while being unbuildable for the real core. Until someone tries the clang path the
divergence is invisible, and in the meantime state changes through an accessor whose whole purpose is to
forbid it.

## The control I thought I had, and did not

`MapKey` rejecting on both cells looked like proof that the typescript compiler *can* enforce const, which
would have made the other three deliberate omissions rather than a blind spot. Reading the diagnostic
killed that reading:

```
error: unsupported call statement [state.mut(0).c.key(1).set(2)]
```

That is the analyzer failing to model the call shape, not enforcing const — `KeyT` is `id`, whose API has
no matching `set`. So `MapKey` is not a control, and this round has **no** evidence that the typescript
compiler models const-ness anywhere. Three of three const violations it could parse were accepted. Stated
as a negative rather than dressed up as a positive.

## Numbers

- 4 const-reference accessors in QPI; **3 divergences**, 1 inconclusive (rejected for an unrelated reason).
- 2 divergences carried through to a live node: **1 forbidden byte written in each**, alongside 2 marker
  bytes of legal change.
- 1 apparent control examined and discarded before it could prop up a stronger claim than the evidence
  supports.

# Round 11

Round 10 left the typescript compiler's const modelling an open question. This round answers it at the
place where it matters most — `state.get()`, the read-only state accessor — and finds a guard that exists,
is deliberate, and has a precise hole in it.

## What QPI declares

```cpp
const T& get() const { return _data; }
T& mut() { ::__markContractStateDirty(contractIndex); return _data; }
```

`get()` is read-only, and `mut()` is also what raises the dirty marker. That made the interesting
hypothesis testable: if a write through `get()` were accepted *and* landed, it would change state without
the engine being told.

## The battery, with controls on both sides

```
case            typescript  clang       verdict
GetScalar       REJECT      REJECT      agree
GetArray        OK          REJECT      ** DIVERGENCE **
GetBits         OK          REJECT      ** DIVERGENCE **
MutScalar       OK          OK          agree
```

`MutScalar` is the positive control — the legal form, accepted by both, so the harness is not rejecting
everything. `GetScalar` is the negative control, and unlike round 10's `MapKey` it is a genuine one: the
typescript compiler rejects it with a purpose-built diagnostic.

## E1 — the `state.get()` guard catches assignment but not a mutating method call

```
typescript, GetScalar:  error: cannot modify through get(): it returns a read-only view — use mut()
clang,      GetArray:   error: 'this' argument to member function 'set' has type 'const Array<uint64, 4>',
                               but function is not marked const
```

The guard is not missing — it is specific and clearly intentional. It models the `get()`/`mut()`
distinction for a direct assignment (`state.get().marker = v`) and misses a mutating method call on a
sub-object (`state.get().arr.set(0, v)`, `state.get().flags.set(3, true)`). Both forms are equally illegal
C++ and clang rejects both.

**Severity: moderate.** A contract written against `state.get()` with container mutations compiles, deploys
and behaves correctly on the typescript cell while being **unbuildable for the real core**. The cost is
developer time and a late discovery, not corrupted state — see the falsified hypothesis below.

**Cells:** the divergence exists only across the pair; simulator × typescript accepts, clang rejects.

## The hypothesis that did not survive contact

Because `mut()` raises `__markContractStateDirty` and `get()` does not, a write through `get()` looked like
it should be invisible to the engine. `GetOnly.h` tests it directly: one procedure whose *only* write goes
through `get()`, with `mut()` never called anywhere in it.

```
CONTROL  Honest (arr[1] through mut())    row: arr[1] | 0 → 4242    bytes changed: [16, 17]
TEST     Sneak  (arr[0] through get())    row: arr[0] | 0 → 777     bytes changed: [8, 9]
```

The write lands and **is reported correctly**. The diff names `arr[0]`, and the changed bytes fall inside
`arr[0]`'s range exactly as the honest write falls inside `arr[1]`'s. No hidden state change, no missing
row. The typescript engine does not depend on the wasm-side dirty marker to notice a write, so the
consequence that would have made this severe does not exist on that cell.

Recorded because a hypothesis worth testing is worth reporting when it fails. The finding is a compile-time
parity divergence and nothing more, and saying so is the difference between a report that can be trusted
and one that cannot.

## Numbers

- 4 cases, **2 divergences**, 1 positive control, 1 negative control — both controls behaved.
- 1 hypothesis (hidden state change via the bypassed dirty marker) tested and **falsified**, with the
  control write alongside it in the same contract.
- Blind spot characterised precisely: assignment guarded, mutating method call not.

# Round 12

Every previous parity round hunted one direction: the typescript cell accepting what clang rejects. This
round looks the other way — qinit refusing a contract that a real compiler accepts — and finds one, plus a
correction to how the earlier rounds' oracle should be read.

## A correction to the method, found before it could mislead

The clang cell does **not** hand the source straight to clang. qinit's own IDL analysis runs first, on both
paths:

```
typescript:  error: Expected semicolon but got char_literal ('000') in expression statement
clang:       compiler IDL analysis failed: line 20: Expected semicolon but got char_literal ('000') …
```

Identical text, and the clang one is explicitly qinit's analysis rather than a compiler diagnostic. So at
parse level "both cells reject" is one verdict reported twice, not two independent ones, and a rejection
on the clang path is only clang's opinion when it carries a clang diagnostic.

Rounds 10 and 11 survive this: every clang rejection there was a genuine compiler message with file, line
and the const-ness complaint (`'this' argument to member function 'set' has type 'const …'`), which only
clang emits. The oracle held where it was used; it simply does not extend to parse-level rules.

## E1 — a C++14 digit separator is mis-lexed as a character literal

`uint64 marker = 1'000'000;` is refused:

```
case            typescript  clang       verdict
DigitSep        REJECT      REJECT      agree      <- both are qinit's tokenizer
PlainNum        OK          OK          agree      <- control: same value, no separator
CommentApos     OK          OK          agree      <- control: an apostrophe inside a comment
```

The tokenizer sees `'000'` and reports `char_literal`. QPI does forbid character literals
(`qpi/no-char`), but a digit separator is not one — it is a numeric literal that happens to contain the
same character.

**The oracle is a real compiler, not the other cell.** Both installed compilers accept the construct and
the program proves the two spellings are the same number:

```
clang++ -std=c++14 -Werror sep.cpp   exit=0    runs -> 0   (big == plain)
g++     -std=c++14 -Werror sep.cpp   exit=0    runs -> 0
```

**The controls.** `PlainNum` writes the identical value without separators and is accepted on both cells,
so the rejection is about the notation and not the statement, the type or the value. `CommentApos` puts an
apostrophe inside a comment and is accepted, so the tokenizer is not simply allergic to the character —
it mis-classifies it specifically in numeric position.

**Severity: low-to-moderate, usability.** Nothing is corrupted and no contract in the tree is blocked
today: core's five uses of the notation are all inside comments. But the idiom is native to this codebase
— `qpi_context.h` documents a transfer bound as `[0..1'000'000'000'000'000]` — and an author who copies
that bound from the comment into code is refused with a message about character literals, which points at
the wrong thing entirely.

## What did not pan out

The token-based policy was the round's target on the theory that textual rules misfire. Mostly they do
not: `qpi/no-division` and `qpi/no-modulo` match on `TokenKind.SLASH`/`SLASH_EQ` rather than raw text, so
`//` comments are safe, and both are `WARNING` rather than blocking. Of the blocking rules, the ones with
the most textual character (`qpi/no-char`, `qpi/no-preprocessor`, `qpi/no-dunder`) were probed and only
the numeric-separator case misfired.

## Numbers

- 18 policy rules classified by severity; **13 blocking**, 5 warnings.
- 3 probes, **1 false rejection** confirmed against two real compilers.
- 2 controls, both behaved; 1 methodological correction recorded before it could invalidate a later claim.

# Round 13

Round 12 established that the two cells share a front end, so a genuine backend divergence has to live in
codegen. Arithmetic is where a C++ backend and a TypeScript one are most likely to part company, because
C++ leaves the interesting cases undefined and every other language defines them differently. The
hypothesis was that they would disagree. They do not.

## Where QPI's guard stops

```cpp
inline static constexpr T div(T a, T b) { return b ? (a / b) : T(0); }
```

`b == 0` is handled; nothing else is. `div(INT64_MIN, -1)` overflows, which is undefined in C++, traps in
wasm, and is perfectly representable in a BigInt implementation — the sharpest available wedge between the
two backends.

## Both agree, including where a naive implementation would not

Results read back from state (procedures are transactions, so their output is not returned to the caller —
the probe stores each result in `last`):

| case | typescript | clang |
| --- | --- | --- |
| `div(10, 0)` | 0 | 0 |
| `mod(10, 0)` | 0 | 0 |
| `div(-7, 2)` | **-3** | **-3** |
| `mod(-7, 2)` | **-1** | **-1** |
| `div(7, -2)` | -3 | -3 |
| `mod(7, -2)` | **1** | **1** |

The negative-operand rows are the discriminating ones and the reason this is evidence rather than a
coincidence. C++ truncates toward zero, so `div(-7, 2)` is `-3`; a floor-division implementation would
answer `-4`. C++ takes the remainder's sign from the dividend, so `mod(-7, 2)` is `-1`; Python-style
modulo would answer `+1`. The typescript backend gets both right, which a naive port would not.

`div(INT64_MIN, -1)` traps identically on both:

```
node halted: EdgesC proc#1 trapped Integer overflow at tick 3029
```

## The halt is documented, not a finding

The trap stops the node, which looked like a candidate until the documentation settled it:

> An abort or trap inside a procedure, system procedure, or `MIGRATE` commits its trace frame (state diff
> included), records the fault served by `GET /live/v1/dev/fault`, and halts the tick loop

Deliberate dev-node behaviour, with the fault route and the restart instruction built around it. Recorded
so the next round does not re-open it.

## Two of my own errors, caught

- The first comparison ran both cells against one node, so the typescript trap halted it and the clang row
  that followed was reading a dead node — the two cells appeared to "agree" for the wrong reason. Redone
  one cell at a time against a fresh node, the agreement is real.
- The first table compared the procedures' `out` field, which is `null` for every call: a procedure is a
  transaction and does not return output to the caller. Reading the persisted `last` field instead is what
  produced the table above.

## Numbers

- 7 arithmetic edges across 2 backends: **7/7 agree**, including 3 cases where C++ semantics differ from
  the obvious alternative implementation.
- 1 hypothesis (codegen divergence on arithmetic) **falsified**.
- 1 candidate (trap halts the node) checked against documentation and closed.
- 2 tester errors caught and corrected.

# Round 14

Round 2 covered `MIGRATE`, but `17b93ef` rewrote the diff reader afterwards, so the migration path had not
been exercised against the single-pass walk. A migration rewrites the whole state — the largest changed
window there is — which makes it the sharpest case for a walk that visits only what shares a byte with a
window.

## The state transition itself is exact

`MigZoo1` (a `HashMap<id, uint64, 4>` and a marker) populated with two entries and a bumped marker, then
migrated to `MigZoo2`, which adds a `uint64 extra`:

```
v1 = 192B   v2 = 200B   grew = 8
differing bytes in the overlapping prefix: 0   []
new tail: 9210000000000000        (little-endian 4242, matching `extra`)
```

Nothing carried over was disturbed, the new field is exactly the 8 bytes of growth, and the decoded state
reads `marker = 1`, `extra = 4242`, `bal` with 2 entries. The migration is correct.

## E1 — the MIGRATE trace's before-image is a zeroed buffer, so preserved values report as newly written

The frame is reachable at `GET /live/v1/debug-trace`, `kind=3`:

```
kind=3 entry=None tick=3040 stateDiff regions=1 stateVersion=4
MIGRATE region: off=0  before=200B  after=200B
```

Checked against dumps taken independently either side of the migration:

```
region.after  == post-migration dump   : True
region.before entirely zero            : True   (all 200 bytes)
pre-migration dump non-zero bytes      : 69 of 192
bytes the region says moved            : 71, spanning 40..193
bytes that actually moved (pre vs post): 0 in the overlapping 192-byte prefix
```

The after side is byte-exact. The before side is zeros throughout, while the real pre-migration state has
69 non-zero bytes. So the rendered migration diff says roughly 152 bytes moved where **none** did, and
every preserved value — the two map entries, the marker — reads as `0 → v`, appearing from nothing.

A reader of that diff cannot distinguish "the migration preserved everything" from "the migration
recreated everything from scratch". Those are very different events for anyone auditing an upgrade.

**The control that rules out tester error.** `region.after` matches the post-migration dump byte for byte,
so the trace and the dumps describe the same contract and the same state — the discrepancy is confined to
the before side and cannot be a mismatched capture. An earlier reading that `region.before[0:40]` matched
the old state was **coincidence** and was discarded: the real old state is also zero over those 40 bytes,
so the agreement carried no information. Only comparing the whole image settled it.

**Severity: moderate, with a caveat stated plainly.** There is a defensible reading in which this is
correct: a migration allocates a fresh buffer for the new layout and the handler writes into it, so the
before-image *of that buffer* genuinely was zeros, and the trace is truthful about writes. What makes it a
finding anyway is that the engine demonstrably holds the old bytes — it copied them in, and the identical
after-image proves it knows the result — so a before-image that reflects the prior state is available. As
rendered, the diff is a true statement about a buffer and a false one about the contract's state.

## Numbers

- Migration state transition: **0 of 192 carried bytes changed**, growth exactly 8, new field value correct.
- MIGRATE diff region: **71 bytes reported moved, 0 actually moved**; before-image 200/200 bytes zero
  against 69 non-zero bytes of real prior state.
- 1 coincidental agreement caught and discarded before it became a conclusion.

# Round 15

No new findings. The round's value is negative evidence that sharpens round 14: the zeroed before-image is
**specific to `MIGRATE`**, not how this engine records frames generally.

## Every other frame kind gets its before-image right

Round 14 could not tell whether a zeroed before-image was a `MIGRATE` defect or a convention applied to
every frame. The same oracle — a trace region checked against dumps taken either side of the call —
answers it:

| frame | before all-zero | before == real prior state | after == real post state |
| --- | --- | --- | --- |
| `kind=1` committed call, fresh contract | True *(correctly — the state was zero)* | **True** | **True** |
| `kind=1` call that aborted after writing | False | **True** | **True** |
| `kind=1` nested callee frame | True *(fresh contract)* | **True** | **True** |
| `kind=1` outer caller frame | True *(fresh contract)* | **True** | **True** |
| `kind=3` MIGRATE (round 14) | True | **False** | True |

The aborted frame is the decisive row. Its state is not fresh — 39 non-zero bytes before the call — and its
before-image reproduces them exactly. So the engine captures a true prior image even on the failure path
that halts the tick loop. `MIGRATE` is the outlier, and round 14's finding stands narrowed rather than
weakened.

The all-zero before-images in rows 1, 3 and 4 are correct, not a second instance of the bug: each of those
contracts had just been deployed, and the matching dump confirms the prior state really was zero. Reading
"all zero" as suspicious without checking the dump would have produced three false findings.

## Rounds 2 and 3 survive the rewrite

Both surfaces were covered before `17b93ef` changed the walk, so both were re-checked:

- **An abort after writing.** The writes that preceded the abort persist — 38 bytes changed by the aborted
  call — and the trace frame commits with them. That matches what round 3 established (*"an abort after
  writing — clean, and the readers agree"*) and what the documentation describes, so it is behaviour, not a
  defect. Re-confirmed rather than re-filed.
- **Cross-contract frames.** Two frames land for one `Caller` invocation, the nested `Callee` first
  (`seq=1`, `index=29`) and the outer `Caller` second (`seq=2`, `index=30`), each with its own correct
  before and after image over its own state.

## Two of my own errors, caught

- Called `Rollback` proc 1 with two inputs where it takes three (`id k; uint64 v; uint64 bitIdx`), and the
  first run reported a state of 208 bytes and 0 non-zero as though the write had done nothing. The call had
  simply been rejected.
- Keyed the trace frames on `contractIndex`, which does not exist — the field is `index`. Every lookup
  silently compared against empty bytes and reported `before == pre -> False` for all four frames, which
  read exactly like a second instance of round 14's finding. Reading the entry's real keys turned four
  apparent failures into four passes.

The second one is worth stating plainly: a harness bug that fabricates the finding you are hunting is the
most dangerous kind, because nothing about the output looks wrong.

## Numbers

- 5 frame kinds compared against independent dumps: **4 correct, 1 (MIGRATE) wrong** — unchanged from
  round 14, now bounded.
- 3 all-zero before-images verified as legitimately zero rather than assumed defective.
- 2 tester errors caught, one of which had produced four false positives.

# Round 16

No findings. `Collection` has the richest invariants of any QPI container — a BST ordering per point of
view, per-PoV populations that must sum to the total, and every element reachable from its PoV's root — so
it is the sharpest remaining test of a walk that visits only the parts of a type sharing a byte with a
window. Round 5 exercised it before `17b93ef`; this round re-runs it after.

## Ordering survives the rewrite

`BstZoo` built across two points of view, with priorities deliberately inserted out of order:

```
PoV[37] inserted  10@p50, 20@p25, 30@p75, 40@p10, 50@p60
PoV[10] inserted  60@p30, 70@p90
```

The container view returns each PoV's elements in descending priority, which is the BST order:

```
PoV[37] = … : 30 (p75), 50 (p60), 10 (p50), 20 (p25), 40 (p10)
PoV[10] = … : 70 (p90), 60 (p30)
```

Both sequences are exactly the insert set re-sorted, and `totalEntries` is 7 across 2 occupied PoVs.

## Removal keeps the topology consistent

Two elements deleted, then a compaction and an unrelated scalar write, under the byte-level conservation
oracle:

```
Del element idx 2       bytes moved:  39 in 17 run(s)   rows: 18
Del again (same idx)    bytes moved:  34 in 12 run(s)   rows: 13
Clean (compacts)        bytes moved:   0 in  0 run(s)   rows:  0
Bump marker             bytes moved:   1 in  1 run(s)   rows:  1
CONSERVATION: OK
```

A removal touches 17 separate byte runs — occupation flags, BST links, per-PoV counters, the element
itself — and every one is accounted for by a row. The `Clean` line is the control that matters: an
operation that changes nothing produces no row, the failure mode S3 was filed for.

Afterwards the view reads 5 entries across the same 2 PoVs, the two removed elements (70@p90 and 30@p75)
are gone, descending order is preserved in both, and `status=loaded` with `error=None` — so the view's own
checks on PoV populations and element reachability pass on the post-removal topology, not just the clean
one.

## One of my own errors, caught

The first read truncated each line to 60 characters, which cut the element values off and left five lines
reading `PoV[37] = DDZY…` with no visible difference between them. That looked like duplicate rows for one
PoV — a plausible finding, and wrong. The lines were correct; my printer was not. Printing the full text
showed five distinct elements in priority order.

Worth recording because the failure mode is specific: a display truncation in the *test harness* produced
exactly the shape of defect the round was hunting for in the *tool*.

## Numbers

- 7 elements across 2 PoVs, inserted out of priority order: **ordering correct in both** before and after
  removal.
- 4 operations under conservation: **all agree**, including a 17-run removal and a no-op that produced no
  row.
- Post-removal invariants (`error=None`, populations, reachability): **pass**.
- 1 tester error caught before it became a false finding.

# Round 17

No findings. `LinkedList` was the last container kind whose invariants had not been re-exercised since
`17b93ef`, and it is the one with the most ways to go subtly wrong: the view checks that head and tail are
occupied slots, that `next`/`prev` are symmetric and in range, that walking from head visits exactly
`population` elements without repeating, and that the set of visited slots matches the set of occupied
ones.

The existing `NestList.h` only appends, which never exercises any of that. `LinkZoo.h` (appendix) was
written for this round with `addHead`, `addTail`, `insertAfter` and `remove`, so the list's shape keeps
changing instead of only growing.

## Order is right at every insertion position

```
addTail 10, 20, 30        ->  [10, 20, 30]
addHead 5                 ->  [5, 10, 20, 30]
insertAfter(slot1 = 20)   ->  [5, 10, 20, 99, 30]
```

The middle insertion is the one that matters: `insertAfter` has to relink two neighbours rather than
extend an end, and the reader has to follow the new links rather than the slot order.

## Removal from every position, under conservation

```
remove head   (slot3 = 5)    bytes moved:  28 in 7 run(s)   rows: 7
remove tail   (slot2 = 30)   bytes moved:  29 in 7 run(s)   rows: 8
remove middle (slot1 = 20)   bytes moved:  15 in 8 run(s)   rows: 8
remove again  (slot1)        bytes moved:   0 in 0 run(s)   rows: 0
bump marker                  bytes moved:   1 in 1 run(s)   rows: 1
CONSERVATION: OK
```

Each removal rewrites a different combination of `_headIndex`, `_tailIndex`, `_freeHeadIndex`, the
neighbours' links and the occupation flags — 7 to 8 distinct byte runs each — and every run is accounted
for by a row. Removing an already-freed slot is the control: **0 bytes, 0 rows**, no phantom row for an
operation that did nothing.

Afterwards:

```
container list status=loaded entries=2 occupied=2 error=None
   item[0] slot[0]  = 10
   item[1] slot[4]  = 99
```

`[5, 10, 20, 99, 30]` minus head, tail and middle is `[10, 99]`, in that order. The slot numbers survive
the free-list recycling — `99` is still at slot 4, not renumbered — and `error=None` means the link
symmetry, head/tail validity and walk-without-repeat checks all pass on the post-removal shape rather than
only on a list that has only ever grown.

## Numbers

- 3 insertion positions (head, tail, middle): **order correct at each**.
- 3 removal positions plus a repeat and an unrelated write, under conservation: **all agree**, 7–8 byte
  runs per removal, and the no-op produced no row.
- Post-removal invariants (`error=None`, head/tail, link symmetry, reachability): **pass**.
- 1 probe written to cover what the existing one could not reach.

# Round 18

Logs were round 3's other half and the last untouched piece of the brief. Round 3 filed the
*differently-sized* mislabel — a log decoded by size with a contradicting `_type` printed beside it — and
recorded the mechanism behind it: **the IDL records the set of `_type` values it saw at each struct's
`LOG_` call sites** (`AlphaLog types [11, 33]`). It did not test what that costs the struct that legitimately
owns the borrowed tag. It costs it everything.

## E1 — one mislabelled `LOG_` call makes a correctly labelled log undecodable

`LogZoo.h` declares `AlphaLog` and `BetaLog` at the **same** logged size, distinguished only by `_type`,
and `EmitLiar` fills an `AlphaLog` while tagging it `KindBeta`. Every log in that contract:

```
EmitAlpha  ->  name=AlphaLog  typeName=KindAlpha  fields={_contractIndex:29, _type:11, alpha:"7"}
EmitBeta   ->  name=None      typeName=None       fields=null      hex=0x1d000000160000002a…
EmitGamma  ->  name=GammaLog  typeName=KindGamma  fields={… g1:"1", g2:"2"}
EmitLiar   ->  name=None      typeName=None       fields=null      hex=0x1d000000160000002a…
```

`EmitBeta` emits a genuine, correctly labelled `BetaLog`. It does not decode. Neither does the liar, which
is defensible — but the honest log is collateral damage.

**The control is a contract identical but for the liar.** `LogClean.h` (appendix) declares the same three
structs and the same three emitters, with no mislabelling procedure:

```
EmitAlpha  ->  name=AlphaLog  typeName=KindAlpha  fields={… alpha:"7"}
EmitBeta   ->  name=BetaLog   typeName=KindBeta   fields={_contractIndex:30, _type:22, beta:"42"}
EmitGamma  ->  name=GammaLog  typeName=KindGamma  fields={… g1:"1", g2:"2"}
```

`BetaLog` decodes perfectly. The only difference between the two contracts is the presence of a procedure
that never runs in this comparison, so the loss is caused at **catalog-build time**, not at decode time.

**Mechanism, from round 3's own observation.** The IDL collects per-struct type sets, so `EmitLiar` makes
`AlphaLog` claim `[11, 22]` while `BetaLog` claims `[22]`. Tag 22 now has two owners, so the `byTypeWord`
lookup is ambiguous; and because both structs log at the same size, round 3's size fallback — *"`decodeLog`
does skip `byTypeWord` when exactly one catalog entry matches the logged size"* — cannot break the tie
either. Both paths fail and `decodeLog`'s `try/catch` returns the hex-only record.

**Severity: moderate.** Refusing to guess between two candidates is the right instinct, and the same
instinct S7 was filed to enforce. Two things make it a finding anyway. It is **silent** — the caller gets
`name: null, fields: null` with no indication that an ambiguous tag, rather than a malformed log, caused
it, so the obvious conclusion is that the log itself is broken. And it is **collateral** — the contract
author who wrote `BetaLog` correctly loses their decode because of an unrelated procedure elsewhere in the
same file.

It also sits oddly beside round 3's finding. Same-size ambiguity refuses silently; different-size
ambiguity decodes by size and prints a contradicting `_type` (`AlphaLog·KindGamma`). Two mislabels, two
different strategies, neither of which says "this tag is ambiguous".

## Enums and payload shapes decode correctly

Away from the ambiguity, decoding is exact. `KindAlpha` resolves from `_type: 11` to its name, and the hex
confirms each field:

```
AlphaLog  hex=0x1d0000000b0000000700000000000000   1d000000=29  0b000000=11  0700…=7
GammaLog  hex=0x1d0000002100000001…0200…           21000000=33  g1=1  g2=2
```

A three-log procedure (`EmitAll`) emits INFO, DEBUG and WARNING in order and the reader returns all three
in order, decoding the first and third and refusing the middle one — so a refusal does not empty the list,
which was the other half of round 3's unresolved lead.

## Numbers

- 3 log structs, 2 contracts differing only by a mislabelling procedure: **1 type lost in one, 0 in the other**.
- 6 emissions checked against raw hex: every decoded field matches its bytes.
- Round 3's "one unparseable log empties the whole list" lead: **resolved negative** — 3 of 3 logs returned,
  1 refused, 2 decoded.

# Round 19

The core cells have been reported unavailable since round 6, and core-lite#11 merged with its runtime
behaviour explicitly unverified for that reason. Both of those are now fixed, and the fix was a build flag.

## Why the core cell never worked

Every previous round reported the same symptom: the node starts and ticks, but the spectrum loads empty,
so every funded identity has balance 0, deploys are accepted and then dropped at tick assembly, and
`state-read` answers `bad slot` for every index. It was recorded as an environmental limit and worked
around by using the simulator cells.

It was not environmental. The build cache tells the whole story:

```
LITE_WASM_SC:BOOL=ON
TESTNET:UNINITIALIZED=ON
TESTNET_LITE_RAM:UNINITIALIZED=ON
            <- TESTNET_PREFILL_QUS absent
```

`qubic.cpp` documents that flag as *"prefill computors / custom addresses with test QUs"* and, under it,
gives each of the two `customSeeds` 10 billion QUs immediately after `loadSpectrum()`. Without it the
spectrum is genuinely empty and nothing can pay for a deployment. core-lite's own CI passes
`-DTESTNET_PREFILL_QUS=ON`; the local build did not.

Rebuilt with the flag (`[100%] Built target Qubic`), the failure mode changes from "dropped at tick
assembly" to an ordinary range error:

```
Tiny slot 29 is outside the dynamic window 30..77
```

which is a working node declining an out-of-range slot. Deploying into the window succeeds, and
`qinit state` reads the contract back over the real RPC:

```
deploy ok=True slot=30
complete: True   fields a..f = 0   containers m, s, q, l, arr, bits all status=loaded
```

**The core cell is available.** Six rounds of "cannot be started" were a missing `-D`.

## core-lite#11 verified on a real node, at last

That PR shipped with its limitation stated in the first paragraph of its description — it compiled, the
node ticked, but nothing could be deployed, so the seqlock had never served a single real read. The
standalone concurrency test covered the logic; the runtime path did not.

It works:

```
version before any call      0
after one writing call       2
after a second               4
```

Even values, advancing by two per write, which is exactly the design: the scope bumps on entry making the
sequence odd, bumps again on exit making it even, and a reader that sees an even value on both sides of
its copy reports it. A quiescent slot that has never been written reports 0, not an omitted field, because
0 is a real quiescent value rather than an unknown one.

So the one thing core-lite#11 asked reviewers to weigh is now measured rather than argued.

## Two corrections to my own earlier work

**Round 12's severity was understated.** I wrote that core's uses of C++14 digit separators "are all
inside comments", so no contract is blocked today. That was true of `core-v7`, the snapshot qinit compiles
contracts against, and I generalised it to "core" without checking the other tree. core-lite's own source
has **33 uses, many in executable code**:

```
src/extensions/overload.h:1593              5'000'000'000ULL
src/extensions/tick_fork_rollback.h:37      1'000'000LL
src/extensions/ant_walker_worker.h:28       60'000
src/qubic.cpp:9267                          10'000'000'000
```

The notation is routine in this codebase, not merely documented in it. R12-E1 is stronger than filed.

**A wrong note carried since the early rounds.** I had recorded that the engine's `state-read` takes
`slot=` while core-lite's takes `contractIndex=`. Querying the real node with `contractIndex=` returns
`{"error":"bad slot"}`; `slot=` returns the payload. Both take `slot=`. The note was never load-bearing —
`qinit state` was always doing it correctly — but it was wrong and is now corrected.

## Numbers

- 1 missing build flag accounted for **6 rounds** of an unavailable cell.
- Core cell: deploy, state read over RPC, and a procedure call all working.
- core-lite#11's seqlock on a real node: version **0 → 2 → 4**, even throughout.
- 2 corrections to earlier findings, one of which raises a severity rather than lowering it.

# Round 20

Round 19 made the core cells usable, so for the first time the S1–S8 repros could be run somewhere other
than the simulator. S7 and S8 were the ones worth carrying over, because they are the only two that depend
on the node rather than on client-side rendering.

## S7 passes on core, which is also the first end-to-end proof of the pair

```
S7 value updates named by key:  8 / 8   (bucketed: 0)
control — removal never names the all-zero id:      PASS
control — removal still names the real key:         PASS
```

This matters beyond the repro. S7's guarded fetch only accepts a key when the node's `version` matches the
`stateVersion` the trace recorded. On core that version comes from the seqlock added in core-lite#11. So
eight successful fetches are eight round trips in which qinit's reader and core-lite's writer agreed about
the state version — the two halves working as a pair on a real node, which neither PR could demonstrate
when it merged.

## S8 reports no race on core, and that is the correct answer

```
12 reads of a write-every-tick contract:     raced 0 / 12
6 full reads with --all (~4 s each):         raced 0 / 6
```

The contract is demonstrably writing: sampling the slot version over six seconds gives
`226, 228, 230, 232, 234, 236` — one bump per tick, matching the ~1 s core cadence. So writes were
interleaving with the reads and nothing was reported.

Two hypotheses for that were raised and both were killed by measurement rather than argument.

**"core-lite withholds the version under load, disabling the check."** Plausible, because the reader omits
`version` when it cannot find a quiescent window, and a busy slot would then silently lose its protection.
Measured over 40 one-megabyte reads of the racing slot: **version present 40/40, withheld 0/40**. Not that.

**"A four-second read must span four one-second writes."** This was my own reasoning and it was wrong. It
assumed the four seconds is time spent fetching. Timing the fetch sequence the reader actually performs:

```
raw fetch of the whole 5.27 MB container: 0.19 s in 2 request(s)
versions seen per request: [372, 372]     ->  identical
```

Nineteen hundredths of a second, two requests, one version. The remaining ~3.8 s is client-side decoding
and rendering of a 131 072-slot container, which cannot affect consistency because the bytes are already
in hand. The view really was assembled from a single quiescent state, so reporting it as whole is correct.

S8 is not inert on core; there was simply nothing to detect. The same client code reports 12/12 races
against the simulator at its 50 ms tick, where the fetch sequence genuinely does straddle writes.

## A stale comment, now false

`readContainerBlock` carries this, written when it was true:

```ts
// without a node version only an inconsistent view is caught: a read spanning a write that stays
// self-consistent renders as whole (core-lite sends no version)
```

core-lite **does** send a version now, on every read measured this round. A maintainer reading that comment
would conclude the container path is unprotected against a silent straddle on core, and would be wrong.
Minor, but it is a statement about behaviour that the code no longer matches.

## Numbers

- S7 on core: **8/8** named, 2/2 controls — first confirmation outside the simulator.
- S8 on core: **0/12** and **0/6** races, both correct; 2 hypotheses falsified by measurement.
- Version availability under load: **40/40 present**.
- Fetch versus total read time: **0.19 s of 4 s** — the ratio that made the difference.
- 1 stale comment identified.

# Round 21

The core cell made the real system contracts readable for the first time — the actual implementations with
their real layouts, not probes whose answers I already knew. Twenty were swept with `--all`. Seventeen read
clean. Three did not, and two of those three are a finding.

## The sweep

```
QX QTRY RANDOM MLM SWATCH QEARN QVAULT MSVAULT QBAY QSWAP QDRAW RL QBOND QIP QRAFFLE QRWA   complete=True
CCF        complete=False   1 container in error
GQMPROP    complete=False   1 container in error
NOST       complete=False   9 containers in error
```

```
CCF     activeSubscriptions  short state read at 300040: expected 319488 bytes, got 176744
GQMPROP revenueDonation      short state read at 177152: expected 6144 bytes, got 0
NOST    fundaraisings        short state read at 1009126496: expected 4194240 bytes, got 0
```

## One of the three is my own setup, and is separated out

`NOST` reads to offset 1,009,126,496 against a node whose state is 4,893,616 bytes — a 207× overshoot.
`Nostromo.h` differs between the tree qinit parsed and the tree the node compiled (1648 lines against
6516), so that one is ordinary version skew from my mismatched `--core-dir`. Not a finding, and kept apart
from the two that are.

## E1 — the layout is derived without the node's compile-time defines, and never checked against the size the node reports

`ComputorControlledFund.h` and `GeneralQuorumProposal.h` are **byte-identical** in both trees (md5
`52453c69` and `fed0c6ab`), so version skew cannot explain them. They still fail.

Taking the small one: qinit expects `proposals` to occupy 177,152 bytes and `revenueDonation` 6,144 after
it. The node's state is **9,088 bytes** in total.

The cause is a preprocessor guard in the headers qinit parses:

```cpp
// Use a small committee for local dynamic-contract development.
#if defined(TESTNET) && defined(LITE_WASM_SC)
#define NUMBER_OF_COMPUTORS 8
#else
#define NUMBER_OF_COMPUTORS 676
#endif
```

`GQMPROP`'s state is `ProposalVoting<ProposalAndVotingByComputors<NUMBER_OF_COMPUTORS>, …>`. The node was
built with both defines and has the 8-computor layout; qinit parsed the same file without them and derived
the 676-computor layout. Every system contract whose state is sized by the committee is affected, and the
dev-node build sets those defines by default — so this is the normal configuration, not an exotic one.

**The information to catch it is already in hand.** The node returns `stateSize` on *every* state-read
response:

```
{"len": 8, "off": 0, "stateSize": 9088, "version": 0}
```

`stateSize` is declared in `rpc/types.ts`, returned by `client.ts`, and referenced **nowhere** in
`state-read.ts`. So qinit asks for 183,296 bytes from a contract the same response tells it is 9,088 bytes
long, and reports the result as `short state read at 177152: expected 6144 bytes, got 0` — a message about
paging, pointing at an offset, that says nothing about the actual problem. A user sees what looks like a
truncated transfer and has no route from there to "your `--core-dir` headers are configured differently
from the node you are reading".

**The controls.** Seventeen of twenty contracts read clean on the same node in the same sweep, so the
reader works and only committee-sized layouts fail. `CCF` and `GQMPROP` have identical sources across both
trees, which isolates the cause to build configuration rather than source drift. `NOST` is held separately
precisely because its source *does* differ — conflating it with the other two would have turned one real
finding into a vaguer claim about three.

**Severity: notable.** It affects real system contracts under the default dev-node build, it produces an
incomplete read reported as `complete: False`, and the diagnosis misdirects. It is also cheap to fix: one
comparison against a number the node already sends.

Round 5 read several of these contracts on the simulator without trouble, which fits — the simulator
derives its layout from the same headers qinit parses, so both sides were wrong together and agreed.
Only a real core node, compiled with its own flags, exposes the divergence.

## Numbers

- 20 system contracts swept on a real core node: **17 clean, 3 failing**.
- 2 failures with byte-identical sources -> configuration, not version skew.
- GQMPROP: qinit **183,296** bytes expected against the node's **9,088** — the ratio tracks `676 / 8`.
- `stateSize` returned on every read, referenced in **0** places in the reader.

# Appendix — the probe contracts, in full

They live outside the repo (nothing was committed). Each is complete as written; deploy with
`qinit deploy <file> --contract-name <Name> --compiler <typescript|clang> --slot <n>`. The clang
backend requires the struct name to equal `--contract-name`, so a clang copy is the same file with
the struct renamed.

### `Carry1.h` / `Carry2.h` — S1, HashMap

```cpp
// Carry1.h
using namespace QPI;
struct Carry2Unused {};
struct Carry : public ContractBase
{
    struct StateData { Array<uint64, 64> raw; };
    struct Poke_input { uint64 idx; uint64 v; };   struct Poke_output {};
    struct Peek_input { uint64 idx; };             struct Peek_output { uint64 v; };
    PUBLIC_PROCEDURE(Poke) { state.mut().raw.set(input.idx, input.v); }
    PUBLIC_FUNCTION(Peek)  { output.v = state.get().raw.get(input.idx); }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    { REGISTER_USER_PROCEDURE(Poke, 1); REGISTER_USER_FUNCTION(Peek, 1); }
};
```

```cpp
// Carry2.h — same contract name, same slot, deployed with --allow-state-carryover
using namespace QPI;
struct Carry2Unused {};
struct Carry : public ContractBase
{
    struct StateData { HashMap<id, uint64, 8> bal; uint64 marker; };
    struct Put_input { id k; uint64 v; };  struct Put_output { sint64 idx; };
    struct Bump_input {};                  struct Bump_output {};
    struct Look_input { id k; };           struct Look_output { uint64 v; uint64 pop; };
    struct Look_locals { uint64 got; };
    PUBLIC_PROCEDURE(Put)  { output.idx = state.mut().bal.set(input.k, input.v); }
    PUBLIC_PROCEDURE(Bump) { state.mut().marker += 1; }
    PUBLIC_FUNCTION_WITH_LOCALS(Look)
    {
        locals.got = 0;
        state.get().bal.get(input.k, locals.got);
        CC_PRINT("look", locals.got, "population", state.get().bal.population(), "contains", state.get().bal.contains(input.k));
        output.v = locals.got;
        output.pop = state.get().bal.population();
    }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    { REGISTER_USER_PROCEDURE(Put, 1); REGISTER_USER_PROCEDURE(Bump, 2); REGISTER_USER_FUNCTION(Look, 1); }
};
```

### `Zoo1.h` / `Zoo2.h` — S1, HashSet / Collection / LinkedList

`Zoo1.h` is `Carry1.h` with `Array<uint64, 256> raw;` and the contract renamed to `Zoo`.

```cpp
// Zoo2.h — deployed over the same slot with --allow-state-carryover
using namespace QPI;
struct ZooUnused {};
struct Zoo : public ContractBase
{
    struct StateData
    {
        HashSet<id, 8> members;        uint64 m1;
        Collection<uint64, 8> queue;   uint64 m2;
        LinkedList<uint64, 8> list;    uint64 m3;
    };
    struct Bump_input { uint64 which; };  struct Bump_output {};
    struct Counts_input {};               struct Counts_output { uint64 s; uint64 q; uint64 l; };
    PUBLIC_PROCEDURE(Bump)
    {
        if (input.which == 1) state.mut().m1 += 1;
        if (input.which == 2) state.mut().m2 += 1;
        if (input.which == 3) state.mut().m3 += 1;
    }
    PUBLIC_FUNCTION(Counts)
    {
        output.s = state.get().members.population();
        output.q = state.get().queue.population();
        output.l = state.get().list.population();
        CC_PRINT("set", state.get().members.population(), "coll", state.get().queue.population(), "list", state.get().list.population());
    }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    { REGISTER_USER_PROCEDURE(Bump, 1); REGISTER_USER_FUNCTION(Counts, 1); }
};
```

Layout for the poke indices used above (`qinit build --json`): `members` @0 (280 B), `m1` @280,
`queue` @288 (920 B), `m2` @1208, `list` @1216 (240 B), `m3` @1456, total 1464. The 25 pokes are
`raw[i] = v` for

```
0..3  = the four 64-bit words of an id (members.slot[0].key)
32    = 1        members._occupationFlags  (slot 0 = 0b01)
35    = 111      m1
36..39 = a second id's words                queue._povs[0].value
40    = 1        queue._povs[0].population
100   = 1        queue._povOccupationFlags (PoV 0 = 0b01)
101   = 4242     queue._elements[0].value
102   = 7        queue._elements[0].priority
104,105,106 = 2^64-1  the element's bstParent / bstLeft / bstRight = -1
151   = 222      m2
152   = 999      list._nodes[0].value
153,154 = 2^64-1      list._nodes[0].next / prev = -1
176   = 1        list._occupiedFlags (node 0)
179   = 2^64-1   list._freeHeadIndex = -1
180   = 1        list._nextUnusedIndex
182   = 333      m3
```

every `_population` word deliberately left at its zero-initialised value.

### `KeyShapes.h` — S2

```cpp
using namespace QPI;
struct KeyShapesUnused {};
struct KeyShapes : public ContractBase
{
    struct One { uint64 w;           bool operator==(const One& o) const { return w == o.w; } };
    struct Two { uint64 a; uint64 b; bool operator==(const Two& o) const { return a == o.a && b == o.b; } };
    struct StateData
    {
        HashMap<One, uint64, 4> m1;  uint64 k1;
        HashMap<Two, uint64, 4> m2;  uint64 k2;
        HashSet<One, 4>         s1;  uint64 k3;
    };
    struct M1Set_input { uint64 w; uint64 v; };            struct M1Set_output { sint64 idx; };  struct M1Set_locals { One k; };
    struct M1Del_input { uint64 w; };                      struct M1Del_output { sint64 idx; };  struct M1Del_locals { One k; };
    struct M2Set_input { uint64 a; uint64 b; uint64 v; };  struct M2Set_output { sint64 idx; };  struct M2Set_locals { Two k; };
    struct M2Del_input { uint64 a; uint64 b; };            struct M2Del_output { sint64 idx; };  struct M2Del_locals { Two k; };
    struct S1Add_input { uint64 w; };                      struct S1Add_output { sint64 idx; };  struct S1Add_locals { One k; };
    struct S1Del_input { uint64 w; };                      struct S1Del_output { sint64 idx; };  struct S1Del_locals { One k; };
    struct Bump_input { uint64 which; };                   struct Bump_output {};

    PUBLIC_PROCEDURE_WITH_LOCALS(M1Set) { locals.k.w = input.w; output.idx = state.mut().m1.set(locals.k, input.v); }
    PUBLIC_PROCEDURE_WITH_LOCALS(M1Del) { locals.k.w = input.w; output.idx = state.mut().m1.removeByKey(locals.k); }
    PUBLIC_PROCEDURE_WITH_LOCALS(M2Set) { locals.k.a = input.a; locals.k.b = input.b; output.idx = state.mut().m2.set(locals.k, input.v); }
    PUBLIC_PROCEDURE_WITH_LOCALS(M2Del) { locals.k.a = input.a; locals.k.b = input.b; output.idx = state.mut().m2.removeByKey(locals.k); }
    PUBLIC_PROCEDURE_WITH_LOCALS(S1Add) { locals.k.w = input.w; output.idx = state.mut().s1.add(locals.k); }
    PUBLIC_PROCEDURE_WITH_LOCALS(S1Del) { locals.k.w = input.w; output.idx = state.mut().s1.remove(locals.k); }
    PUBLIC_PROCEDURE(Bump)
    {
        if (input.which == 1) state.mut().k1 += 1;
        if (input.which == 2) state.mut().k2 += 1;
        if (input.which == 3) state.mut().k3 += 1;
    }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(M1Set, 1); REGISTER_USER_PROCEDURE(M1Del, 2);
        REGISTER_USER_PROCEDURE(M2Set, 3); REGISTER_USER_PROCEDURE(M2Del, 4);
        REGISTER_USER_PROCEDURE(S1Add, 5); REGISTER_USER_PROCEDURE(S1Del, 6);
        REGISTER_USER_PROCEDURE(Bump, 7);
    }
};
```

(The `operator==` overloads are required: without them `qinit build` stops with
`Codegen failed: authoritative body emitted a diagnostic: no viable operator== for 'One'`, which is
correct — `HashMap::getElementIndex` compares keys.)

### `Straddle.h` — S3

```cpp
using namespace QPI;
struct StraddleUnused {};
struct Straddle : public ContractBase
{
    struct StateData
    {
        Array<uint64, 16> p16;  Array<uint64, 8> p8;  Array<uint64, 4> p4;  Array<uint64, 2> p2;
        id key;        // [240,272) — straddles the 256-byte diff window
        uint64 tail;   // [272,280)
        uint8 last;    // [280,281) — state size 288, so [281,288) is slack
    };
    struct SetKey_input  { id k; };            struct SetKey_output {};
    struct SetPad_input  { uint64 idx; uint64 v; };  struct SetPad_output {};
    struct SetTail_input { uint64 v; };        struct SetTail_output {};
    struct SetLast_input { uint64 v; };        struct SetLast_output {};
    PUBLIC_PROCEDURE(SetKey)  { state.mut().key = input.k; }
    PUBLIC_PROCEDURE(SetPad)  { state.mut().p16.set(input.idx, input.v); }
    PUBLIC_PROCEDURE(SetTail) { state.mut().tail = input.v; }
    PUBLIC_PROCEDURE(SetLast) { state.mut().last = (uint8)input.v; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(SetKey, 1); REGISTER_USER_PROCEDURE(SetPad, 2);
        REGISTER_USER_PROCEDURE(SetTail, 3); REGISTER_USER_PROCEDURE(SetLast, 4);
    }
};
```

`Array` capacities must be powers of two (`static assertion failed … The capacity of the array must be
2^N`), which is why the 240-byte prefix is four arrays rather than one `Array<uint64, 30>`.

### `SixPack.h` — the main matrix contract (every container kind, each followed by a marker)

```cpp
struct StateData
{
    HashMap<id, uint64, 8> bal;     uint64 m1;
    HashSet<id, 8> members;         uint64 m2;
    Collection<uint64, 8> queue;    uint64 m3;
    LinkedList<uint64, 8> list;     uint64 m4;
    BitArray<64> bits;              uint64 m5;
    Array<uint64, 4> arr;           uint64 m6;
};
```
IDL offsets: `bal` @0 (344), `m1` @344, `members` @352 (280), `m2` @632, `queue` @640 (920),
`m3` @1560, `list` @1568 (240), `m4` @1808, `bits` @1816 (8), `m5` @1824, `arr` @1832 (32),
`m6` @1864 — total 1872, no trailing slack (hence its use as the S3 control). Procedures 1..14 are
one-line wrappers over `bal.set` / `bal.removeByKey` / `bal.cleanup` / `members.add` /
`members.remove` / `members.cleanup` / `queue.add` / `queue.remove` / `queue.cleanup` /
`list.addTail` / `list.remove` / `bits.set` / `arr.set` / marker `+= 1`.

### `NestZoo.h` — nesting shapes (clang cell)

```cpp
struct Widest   { uint8 a; uint64 wide; uint16 b; };            // widest member not last + tail padding
struct Holder   { uint64 head; HashMap<id, uint64, 8> inner; uint64 tail; };
struct Deeper   { uint64 lead; Holder holder; uint64 trail; };  // a container two levels down
struct ValStruct{ uint64 lead; Array<uint32, 4> arr; };         // a container value holding an array
struct BitHolder{ uint64 tag; BitArray<64> bits; };             // an array element holding a container
struct StateData
{
    Widest widest;                    uint64 m0;
    Deeper deep;                      uint64 m1;
    HashMap<id, ValStruct, 8> structMap;  uint64 m2;
    Array<BitHolder, 2> holders;      uint64 m3;
};
```

### `BigMap.h` / `BigArr.h` — the size thresholds

```cpp
struct StateData { HashMap<id, uint64, 262144> big; uint64 marker; Array<uint64, 4> tail; uint64 marker2; };
// 10 551 312-byte container (past LARGE_STATE_CONTAINER_BYTES = 10 MB), markers at 10 551 312 / 10 551 352

struct StateData { Array<uint64, 1048576> arr; uint64 marker; BitArray<8388608> bits; uint64 marker2; };
// 8 MB array (two 4 MB MAX_STATE_READ chunks) + 1 MB bit array
```

### Round 2 probes

```cpp
// NestCount2.h — S4, with its own control (S4's minimal form is NestCount.h: just `mapsets` + a marker)
using namespace QPI;
struct NestCount2Unused {};
struct NestCount2 : public ContractBase
{
    struct StateData
    {
        HashMap<id, HashSet<id, 4>, 2> mapsets;  uint64 m1;
        Array<HashSet<id, 4>, 2>       arrsets;  uint64 m2;
    };
    struct MapAdd_input { id k; id member; };          struct MapAdd_output { sint64 idx; };  struct MapAdd_locals { HashSet<id, 4> s; };
    struct ArrAdd_input { uint64 which; id member; };  struct ArrAdd_output { sint64 idx; };  struct ArrAdd_locals { HashSet<id, 4> s; };
    struct Bump_input { uint64 which; };               struct Bump_output {};
    PUBLIC_PROCEDURE_WITH_LOCALS(MapAdd)
    {
        state.get().mapsets.get(input.k, locals.s);
        output.idx = locals.s.add(input.member);
        state.mut().mapsets.set(input.k, locals.s);
    }
    PUBLIC_PROCEDURE_WITH_LOCALS(ArrAdd)
    {
        locals.s = state.get().arrsets.get(input.which);
        output.idx = locals.s.add(input.member);
        state.mut().arrsets.set(input.which, locals.s);
    }
    PUBLIC_PROCEDURE(Bump)
    { if (input.which == 1) state.mut().m1 += 1; if (input.which == 2) state.mut().m2 += 1; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    { REGISTER_USER_PROCEDURE(MapAdd, 1); REGISTER_USER_PROCEDURE(ArrAdd, 2); REGISTER_USER_PROCEDURE(Bump, 3); }
};
```

```cpp
// Callee.h / Caller.h — S5
struct Callee : public ContractBase
{
    struct StateData { HashMap<id, uint64, 4> log; uint64 hits; };
    struct Take_input { id who; uint64 amount; };  struct Take_output { sint64 idx; };
    struct Read_input {};                          struct Read_output { uint64 hits; };
    PUBLIC_PROCEDURE(Take) { output.idx = state.mut().log.set(input.who, input.amount); state.mut().hits += 1; }
    PUBLIC_FUNCTION(Read)  { output.hits = state.get().hits; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Take, 1); REGISTER_USER_FUNCTION(Read, 1); }
};

struct Caller : public ContractBase
{
    struct StateData { uint64 sent; id last; BitArray<64> marks; };
    struct Fire_input { id who; uint64 amount; uint64 markIdx; };
    struct Fire_output { sint64 idx; };
    struct Fire_locals { Callee::Take_input takeIn; Callee::Take_output takeOut; };
    PUBLIC_PROCEDURE_WITH_LOCALS(Fire)
    {
        locals.takeIn.who = input.who;
        locals.takeIn.amount = input.amount;
        { INVOKE_OTHER_CONTRACT_PROCEDURE(Callee, Take, locals.takeIn, locals.takeOut, 0); }
        output.idx = locals.takeOut.idx;
        state.mut().sent += input.amount;
        state.mut().last = input.who;
        state.mut().marks.set(input.markIdx, true);
    }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Fire, 1); }
};
```
Deploy the pair with `--callee "Callee=<path>/Callee.h@29"` on the caller.

```cpp
// Scalars.h — every QPI scalar plus signed values in three container kinds
struct StateData
{
    sint8 i8; uint8 u8; sint16 i16; uint16 u16; sint32 i32; uint32 u32;
    sint64 i64; uint64 u64; bit b; uint128 u128; id who; m256i raw; uint64 marker;
    HashMap<id, sint64, 4> smap;  uint64 marker2;
    Array<sint32, 4>       sarr;  uint64 marker3;
    Collection<sint64, 4>  sq;    uint64 marker4;
};
// IDL offsets: 0,1,2,4,8,12,16,24,32,40,56,88,120,128,312,320,336,344,816 — total 824.
// Write u128 as uint128(hi, lo); the shift form does not compile under clang (see the note above).
// `--in` values that start with '-' need the `--in=…` form: the parser otherwise reads them as options.
```

```cpp
// NestDeep.h — a container inside another container's element, four ways
struct Inner { uint64 tag; BitArray<64> bits; };
struct StateData
{
    Array<HashMap<id, uint64, 4>, 2>  maps;     uint64 m1;
    LinkedList<Array<uint64, 2>, 4>   lists;    uint64 m2;
    Collection<Inner, 4>              coll;     uint64 m3;
    HashMap<id, HashSet<id, 4>, 2>    mapsets;  uint64 m4;
};
```

```cpp
// MigZoo1.h -> MigZoo2.h — the MIGRATE old-state decode
// v1: struct StateData { HashMap<id, uint64, 4> bal; uint64 marker; };
// v2: adds `uint64 extra`, declares OldStateData == v1's StateData, and
//     MIGRATE() { state.mut().bal = oldState.bal; state.mut().marker = oldState.marker; state.mut().extra = 4242; }
// Redeploying v2 over v1's slot runs the migration; the entry shows up in `qinit debug <Name>` as `migrate`.
```

### Round 3 probes

```cpp
// Rollback.h — writes then aborts
struct StateData { HashMap<id, uint64, 4> bal; uint64 marker; BitArray<64> bits; uint64 survived; };
// Good:           bal.set, marker += 1, bits.set, survived += 1            (control)
// WriteThenAbort: bal.set, marker += 100, bits.set, CC_ASSERT(input.v == 0), survived += 1000
// WriteThenTrap:  bal.set, marker += 10000, div<sint64>(INT64_MIN, input.divisor), survived += 100000
// QPI bans `/`, so a trap has to come from div<sint64>(INT64_MIN, -1) ("Integer overflow").
```

```cpp
// FailCallee.h / FailCaller.h — a nested call that traps
struct FailCallee : public ContractBase
{
    struct StateData { HashMap<id, uint64, 4> log; uint64 hits; };
    struct Take_input { id who; uint64 amount; };                      struct Take_output { sint64 idx; };
    struct FailAfterWrite_input { id who; uint64 amount; sint64 divisor; };
    struct FailAfterWrite_output { sint64 idx; sint64 q; };
    struct Read_input {};                                              struct Read_output { uint64 hits; };
    PUBLIC_PROCEDURE(Take) { output.idx = state.mut().log.set(input.who, input.amount); state.mut().hits += 1; }
    PUBLIC_PROCEDURE(FailAfterWrite)
    {
        output.idx = state.mut().log.set(input.who, input.amount);
        state.mut().hits += 1000;
        output.q = div<sint64>(INT64_MIN, input.divisor);   // traps at divisor = -1
    }
    PUBLIC_FUNCTION(Read) { output.hits = state.get().hits; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    { REGISTER_USER_PROCEDURE(Take, 1); REGISTER_USER_PROCEDURE(FailAfterWrite, 2); REGISTER_USER_FUNCTION(Read, 1); }
};

// FailCaller.Fire: INVOKE_OTHER_CONTRACT_PROCEDURE_E(FailCallee, FailAfterWrite, in, out, 0, trapError);
//                  then attempts += 1, lastError = (uint64)trapError, marks.set(markIdx, true).
```

```cpp
// LogZoo2.h — the decode-log discriminator lead
enum LogKind { KindAlpha = 11, KindGamma = 33 };
struct AlphaLog { uint32 _contractIndex; uint32 _type; uint64 alpha; sint8 _terminator; };            // 16 B logged
struct GammaLog { uint32 _contractIndex; uint32 _type; uint64 g1; uint64 g2; sint8 _terminator; };    // 24 B logged
// EmitLiar fills an AlphaLog but sets _type = KindGamma, then LOG_INFO(m).
// Note the IDL records the _type values it saw per struct: AlphaLog types [11, 33], GammaLog types [33].
```

```cpp
// Tiny.h — capacity-1 everything
struct StateData
{
    HashMap<id, uint64, 1> m;  uint64 a;   HashSet<id, 1> s;        uint64 b;
    Collection<uint64, 1> q;   uint64 c;   LinkedList<uint64, 1> l; uint64 d;
    Array<uint64, 1> arr;      uint64 e;   BitArray<1> bits;        uint64 f;
};
```

### Fix-verification probe

```cpp
// NestList.h — S4's second shape: a nested container with no key of its own.
// A nested HashSet carries flagRecords geometry, which the bit-row builder prefers over the outer key,
// so only its _population was mislabelled. A nested LinkedList has no such geometry, so before the fix
// every one of its internal words took the outer key too.
struct StateData { HashMap<id, LinkedList<uint64, 4>, 2> maplists; uint64 marker; };
// ListAdd: maplists.get(k, l); output.idx = l.addTail(v); maplists.set(k, l);
// Bump:    marker += 1
```

### Round 4 probes

```cpp
// Windows.h — S7: diff-window boundaries falling INSIDE a container.
// 240 bytes of padding put the HashMap at 240, so records land across the 256-byte grid:
//   record 0 = 240..280  -> its 32-byte key spans 240..272 and CROSSES 256
//   record 6 = 480..520  -> key 480..512 ends exactly ON 512, value 512..520 starts on it
struct StateData
{
    Array<uint64,16> p1; Array<uint64,8> p2; Array<uint64,4> p3; Array<uint64,2> p4;  // 240 B
    HashMap<id, uint64, 8> m;      //  240..584
    uint64 g1;                     //  584..592
    Array<uint64,128> big;         //  592..1616   far enough for two NON-adjacent windows
    uint64 tail;
};
// Pad(which,idx,v) · MapSet(k,v) · MapDel(k) · BigSet(idx,v)
// BigPair(idx,a,b): writes big[idx] and big[idx+1]  -> one call, both sides of a window edge
// Far(a,b):         writes p1[0] and big[100]       -> one call, two windows 1392 bytes apart
```

```cpp
// BigVal.h — S7 amplifier: a large value, so a field near its END sits in a different window
// from the record's key at its START.  record 0: key 0..32, value 32..432.
struct Val { uint64 head; Array<uint64,32> body1; Array<uint64,16> body2; uint64 tail; };  // 400 B
struct StateData { HashMap<id, Val, 2> bm; uint64 marker; };
// Put(k,head,tail) inserts; SetHead(k,head) touches value+0; SetTail(k,tail) touches value+392.
// SetHead keeps the key label, SetTail loses it — same record, same key, same call shape.
```

```cpp
// RaceMap.h — S8: a container big enough that reading it takes many separate range reads.
struct StateData { HashMap<id, uint64, 262144> big; uint64 marker; };
// Put(k,v) · Del(k) · Bump()
// 8-10 scattered entries -> one range read each, plus the 65536-byte flags read.
// Offsets used for the byte-level work: records 0..10485760, flags @10485760,
// _population @10551296, _markRemovalCounter @10551304; state size 10551320.
```

S8's rendered output was reproduced with the round 1 pair, re-poked:
`Carry1.h` writes the header words directly (index 40 = flags = 64, i.e. slot 3 = `0b01`;
index 41 = population = 1; index 43 = marker = 777), then `Carry2.h` redeploys the same bytes as
`HashMap<id,uint64,8> bal; uint64 marker;` under `--allow-state-carryover`.

### Round 5 probe

```cpp
// BstZoo.h — Collection priority ordering over a deep BST, with the contract as its own oracle.
// Walk() traverses a PoV using QPI's headIndex/nextElementIndex/element/priority, so the order the
// contract sees inside the VM can be compared against the order qinit reconstructs from raw bytes.
struct StateData { Collection<uint64, 64> q; uint64 marker; };

struct Walk_input  { id pov; };
struct Walk_output { Array<uint64,32> vals; Array<sint64,32> prios; uint64 n; uint64 pop; };
struct Walk_locals { sint64 idx; uint64 k; };

PUBLIC_FUNCTION_WITH_LOCALS(Walk)
{
    locals.k = 0;
    output.pop = state.get().q.population(input.pov);
    locals.idx = state.get().q.headIndex(input.pov);
    while (locals.idx >= 0 && locals.k < 32)
    {
        output.vals.set(locals.k, state.get().q.element(locals.idx));
        output.prios.set(locals.k, state.get().q.priority(locals.idx));
        locals.k += 1;
        locals.idx = state.get().q.nextElementIndex(locals.idx);
    }
    output.n = locals.k;
}
// Add(pov,v,prio) · Del(idx) · Clean() · Bump()
// Geometry used for the conservation check: PoVs 0..4096 (64 × 64 B), PoV flags 4096..4112,
// elements 4112..7184 (64 × 48 B: value, priority, povIndex, bstParent, bstLeft, bstRight),
// _population @7184, _markRemovalCounter @7192, marker @7200; state size 7208.
```

No new probe was needed for the system-contract half of round 5 — those 28 contracts ship with Qubic
core and are loaded by `qinit node run`; `qinit ls --json` lists them under `system`.

### Round 6 probes

Round 6 used Qubic core's own contracts rather than hand-written ones. Two renamed copies and two
poker contracts:

```cpp
// RNDX.h  = core's src/contracts/Random.h with s/RANDOM/RNDX/ applied to the WHOLE prefix.
// Renaming only the struct fails: the QPI verifier requires every global name to start with the
// state struct name, so RANDOM_BITFEE et al. must move too.
//   state: 3 × uint64, uint32 bitFee, then 11 containers — 2,459,184 bytes.
//   Has an END_TICK that rewrites the state every tick, so an injected state does not survive.

// QRPX.h  = core's src/contracts/QReservePool.h with s/QRP/QRPX/.
//   struct StateData { id teamAddress; id ownerAddress; HashSet<id, 128> allowedSmartContracts; };
//   32 + 32 + 4144 = 4208 bytes. Only an END_EPOCH, so an injected state is stable.
```

```cpp
// RNDXPoke.h / QRPXPoke.h — v1 for the carryover flow, named to match the real contract so the
// slot's bytes can be written word by word and then reinterpreted by the real layout.
struct StateData { Array<uint64, 524288> raw; };   // RNDXPoke: 4 MB > RNDX's 2,459,184
struct StateData { Array<uint64, 1024>   raw; };   // QRPXPoke: 8 KB  > QRPX's 4,208
PUBLIC_PROCEDURE(Poke) { state.mut().raw.set(input.idx, input.v); }
```

Offsets used, derived from the headers and confirmed by the reported `stateSize`:

```
RNDX   earnedAmount @0 · distributedAmount @8 · burnedAmount @16 · bitFee @24
       populations @28..44 · providers @48..131120 · collateralTiers @131120..163888
       commits @163888..294960 · reveals @294960..2392112 · revealOrCommitFlags @2392112..2392624
       entropy @2392624..2409008 · lockedCollateralAmounts @2409008..2441776
       revealedThisTickFlags @2441776..2442288 · contributedToEntropyFlags @2442288..2442800
       lastUpdateTick @2442800..2459184

QRPX   teamAddress @0..32 · ownerAddress @32..64
       allowedSmartContracts @64: records @64..4160, flags @4160..4192,
                                  _population @4192, _markRemovalCounter @4200
```

### Fixes probe — S8

```cpp
// S8 probe: a container big enough that reading it takes many separate range reads, next to a state
// write that happens on EVERY tick. The reader's population/flags/record reads therefore straddle a
// write without any external driving, so the race is a property of the contract, not of timing luck.
using namespace QPI;

struct RaceTickUnused
{
};

struct RaceTick : public ContractBase
{
    struct StateData
    {
        HashMap<id, uint64, 131072> big;
        uint64 ticks;
    };

    struct Put_input { id k; uint64 v; };
    struct Put_output { sint64 idx; };
    struct Quiet_input {};
    struct Quiet_output {};

    PUBLIC_PROCEDURE(Put)
    {
        output.idx = state.mut().big.set(input.k, input.v);
    }
    // Registered so the contract can be called without writing, as a control.
    PUBLIC_PROCEDURE(Quiet)
    {
    }

    END_TICK()
    {
        state.mut().ticks += 1;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Put, 1);
        REGISTER_USER_PROCEDURE(Quiet, 2);
    }
};
```

## `BitCap.h` — a BitArray write past capacity, at both regimes

Round 7 / E1. `small` is under 64 bits so it has a dead tail; `large` is a power of two at or above 64, so
it fills whole words and a past-capacity `set` wraps onto a live bit instead. The `C`-suffixed twin
`BitCapC.h` is the same source with the struct renamed, for the clang cell.

```cpp
// State-inspection probe: BitArray writes past the declared capacity.
// QPI forces a power-of-two capacity, so:
//   small (< 64) stores one whole word and has a dead tail  -> set(i>=L) lands in the tail
//   large (>= 64) fills whole words and has NO tail         -> set(i>=L) MASKS the word index and
//                                                              wraps onto a live in-capacity bit
// e.g. BitArray<128>: set(200) -> word (200>>6)&1 = 1, bit 200&63 = 8 -> absolute bit 72.
using namespace QPI;

struct BitCapUnused
{
};

struct BitCap : public ContractBase
{
    struct StateData
    {
        BitArray<32> small;    // one word, 32 dead tail bits
        BitArray<128> large;   // two whole words, no tail
        uint64 marker;
    };

    struct Small_input { uint64 idx; uint64 v; };
    struct Small_output {};
    struct Large_input { uint64 idx; uint64 v; };
    struct Large_output {};
    struct Mark_input { uint64 v; };
    struct Mark_output {};

    PUBLIC_PROCEDURE(Small)
    {
        state.mut().small.set(input.idx, input.v != 0);
    }

    PUBLIC_PROCEDURE(Large)
    {
        state.mut().large.set(input.idx, input.v != 0);
    }

    PUBLIC_PROCEDURE(Mark)
    {
        state.mut().marker = input.v;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Small, 1);
        REGISTER_USER_PROCEDURE(Large, 2);
        REGISTER_USER_PROCEDURE(Mark, 3);
    }
};
```

## `FailWords.h` — a field whose text reads like an error

Round 8. A struct whose decoded text contains the failure markers themselves, so a reader
that decides completeness by matching text calls a healthy read incomplete.

```cpp
// State-inspection probe: a field whose DECODED text contains the failure markers.
// af1d96f fixed completeness searching each field's rendered text for those markers, so a struct
// member named `undecodable` made a healthy read report incomplete and exit 1.
// `trap` renders as `{undecodable: N, readFailed: M}` — real data that reads like a failure message.
using namespace QPI;

struct FailWordsUnused
{
};

struct FailWords : public ContractBase
{
    struct Trap
    {
        uint64 undecodable;
        uint64 readFailed;
    };

    struct StateData
    {
        Trap trap;
        uint64 marker;
        HashMap<id, uint64, 8> m;
    };

    struct Set_input { uint64 a; uint64 b; };
    struct Set_output {};
    struct Mark_input { uint64 v; };
    struct Mark_output {};
    struct Put_input { id k; uint64 v; };
    struct Put_output { sint64 idx; };

    PUBLIC_PROCEDURE(Set)
    {
        state.mut().trap.undecodable = input.a;
        state.mut().trap.readFailed = input.b;
    }

    PUBLIC_PROCEDURE(Mark)
    {
        state.mut().marker = input.v;
    }

    PUBLIC_PROCEDURE(Put)
    {
        output.idx = state.mut().m.set(input.k, input.v);
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Set, 1);
        REGISTER_USER_PROCEDURE(Mark, 2);
        REGISTER_USER_PROCEDURE(Put, 3);
    }
};
```


## `JsonShapes.h` — decode shapes that could yield undefined

Round 8. The field shapes most likely to decode to `undefined`, which `--json` would report as a
read error since it infers failure from `data === undefined`.

```cpp
// State-inspection probe: field shapes whose decoded JSON might come back undefined.
// `qinit state --json` infers a read failure from `data === undefined` rather than from the
// `failed` flag, so any successful decode that yields undefined is reported as an error.
// One-field structs are the suspect: decodedAbiToJson unwraps them.
using namespace QPI;

struct JsonShapesUnused
{
};

struct JsonShapes : public ContractBase
{
    struct One { uint64 only; };
    struct Two { uint64 a; uint64 b; };
    struct NestOne { One inner; };
    struct OneId { id who; };

    struct StateData
    {
        One one;
        Two two;
        NestOne nestOne;
        OneId oneId;
        Array<uint64, 2> arr;
        uint64 marker;
    };

    struct SetAll_input { uint64 v; id who; };
    struct SetAll_output {};

    PUBLIC_PROCEDURE(SetAll)
    {
        state.mut().one.only = input.v;
        state.mut().two.a = input.v;
        state.mut().two.b = input.v + 1;
        state.mut().nestOne.inner.only = input.v + 2;
        state.mut().oneId.who = input.who;
        state.mut().arr.set(0, input.v + 3);
        state.mut().arr.set(1, input.v + 4);
        state.mut().marker = 999;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(SetAll, 1);
    }
};
```

## `BitNest.h` — a BitArray at four nesting depths

Round 9 / E1. Each BitArray is under 64 bits, so every one has a dead tail and a past-capacity set is
detectable in principle. `InArray` is shown in its corrected form; the original wrote straight through
`Array::get()`, which is E2.

```cpp
// State-inspection probe: BitArray past-capacity warnings from nested positions.
// pastCapacityWarnings() keys on a row label matching /^(.*)\[(\d+)\]$/ and drops the warning when it
// does not. Each BitArray here is under 64 bits, so every one of them HAS a dead tail and a
// past-capacity set is detectable in principle — the question is whether the label still matches.
using namespace QPI;

struct BitNestUnused
{
};

struct BitNest : public ContractBase
{
    struct Holder
    {
        uint64 lead;
        BitArray<32> flags;
        uint64 trail;
    };

    struct StateData
    {
        BitArray<32> plain;              // control: top level, label `plain[i]`
        Holder inStruct;                 // label should be `inStruct.flags[i]`
        Array<Holder, 2> inArray;        // label should be `inArray[0].flags[i]`
        HashMap<id, Holder, 8> inMap;    // label inside a keyed record
    };

    struct Plain_input { uint64 idx; };
    struct Plain_output {};
    struct InStruct_input { uint64 idx; };
    struct InStruct_output {};
    struct InArray_input { uint64 slot; uint64 idx; };
    struct InArray_output {};
    struct InArray_locals { Holder h; };
    struct MapPut_input { id k; uint64 lead; };
    struct MapPut_output { sint64 idx; };
    struct MapPut_locals { Holder h; };
    struct MapBit_input { id k; uint64 idx; };
    struct MapBit_output { sint64 idx; };
    struct MapBit_locals { Holder h; };

    PUBLIC_PROCEDURE(Plain)
    {
        state.mut().plain.set(input.idx, true);
    }

    PUBLIC_PROCEDURE(InStruct)
    {
        state.mut().inStruct.flags.set(input.idx, true);
    }

    // Array::get returns `const T&`, so the element is copied out, mutated, and written back.
    PUBLIC_PROCEDURE_WITH_LOCALS(InArray)
    {
        locals.h = state.get().inArray.get(input.slot);
        locals.h.flags.set(input.idx, true);
        state.mut().inArray.set(input.slot, locals.h);
    }

    PUBLIC_PROCEDURE_WITH_LOCALS(MapPut)
    {
        locals.h.lead = input.lead;
        locals.h.trail = 0;
        output.idx = state.mut().inMap.set(input.k, locals.h);
    }

    PUBLIC_PROCEDURE_WITH_LOCALS(MapBit)
    {
        state.get().inMap.get(input.k, locals.h);
        locals.h.flags.set(input.idx, true);
        output.idx = state.mut().inMap.set(input.k, locals.h);
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Plain, 1);
        REGISTER_USER_PROCEDURE(InStruct, 2);
        REGISTER_USER_PROCEDURE(InArray, 3);
        REGISTER_USER_PROCEDURE(MapPut, 4);
        REGISTER_USER_PROCEDURE(MapBit, 5);
    }
};
```

## `MapValue.h` — mutation through a `const ValueT&` accessor

Round 10 / E1. One of four generated from the same template, one per const-reference accessor; the others
differ only in the container declaration and the single offending statement.

```cpp
// R10 parity probe: mutation through a QPI accessor declared `const T&`.
using namespace QPI;

struct MapValueUnused
{
};

struct MapValue : public ContractBase
{
    struct Holder
    {
        uint64 lead;
        BitArray<64> flags;
    };

    struct StateData
    {
        HashMap<id, Holder, 8> c;
        uint64 marker;
    };

    struct Poke_input { uint64 v; };
    struct Poke_output {};

    PUBLIC_PROCEDURE(Poke)
    {
        state.mut().c.value(0).flags.set(40, true);
        state.mut().marker = input.v;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Poke, 1);
    }
};
```

## `GetOnly.h` — a write whose only path is `state.get()`

Round 11. `Sneak` never calls `mut()`, so the dirty marker is never raised; `Honest` is the control
writing the neighbouring element the legal way.

```cpp
// R11: a procedure whose ONLY write goes through state.get(). mut() is never called, so
// __markContractStateDirty is never raised — the engine is never told the state changed.
using namespace QPI;

struct GetOnlyUnused
{
};

struct GetOnly : public ContractBase
{
    struct StateData
    {
        uint64 marker;
        Array<uint64, 4> arr;
        BitArray<64> flags;
    };

    struct Sneak_input { uint64 v; };
    struct Sneak_output {};
    struct Honest_input { uint64 v; };
    struct Honest_output {};

    PUBLIC_PROCEDURE(Sneak)
    {
        state.get().arr.set(0, input.v);
    }

    PUBLIC_PROCEDURE(Honest)
    {
        state.mut().arr.set(1, input.v);
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Sneak, 1);
        REGISTER_USER_PROCEDURE(Honest, 2);
    }
};
```

## `LinkZoo.h` — LinkedList shape changes, not just growth

Round 17. `NestList.h` only appends; this one adds at head, tail and middle and removes from each, so the
view's link-symmetry and reachability checks are exercised on a list that keeps changing shape.

```cpp
// R17 probe: LinkedList link topology — head, tail, middle insertion and removal, so the reader's
// invariant checks (head/tail occupied, next/prev symmetric, walk visits population without repeating)
// are exercised on a list whose shape keeps changing rather than one that only grows.
using namespace QPI;

struct LinkZooUnused
{
};

struct LinkZoo : public ContractBase
{
    struct StateData
    {
        LinkedList<uint64, 16> list;
        uint64 marker;
    };

    struct AddTail_input { uint64 v; };
    struct AddTail_output { sint64 idx; };
    struct AddHead_input { uint64 v; };
    struct AddHead_output { sint64 idx; };
    struct InsertAfter_input { sint64 at; uint64 v; };
    struct InsertAfter_output { sint64 idx; };
    struct Remove_input { sint64 at; };
    struct Remove_output {};
    struct Bump_input {};
    struct Bump_output {};

    PUBLIC_PROCEDURE(AddTail)
    {
        output.idx = state.mut().list.addTail(input.v);
    }

    PUBLIC_PROCEDURE(AddHead)
    {
        output.idx = state.mut().list.addHead(input.v);
    }

    PUBLIC_PROCEDURE(InsertAfter)
    {
        output.idx = state.mut().list.insertAfter(input.at, input.v);
    }

    PUBLIC_PROCEDURE(Remove)
    {
        state.mut().list.remove(input.at);
    }

    PUBLIC_PROCEDURE(Bump)
    {
        state.mut().marker += 1;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(AddTail, 1);
        REGISTER_USER_PROCEDURE(AddHead, 2);
        REGISTER_USER_PROCEDURE(InsertAfter, 3);
        REGISTER_USER_PROCEDURE(Remove, 4);
        REGISTER_USER_PROCEDURE(Bump, 5);
    }
};
```

## `LogClean.h` — LogZoo without the mislabelling procedure

Round 18 / E1 control. Same three log structs and emitters as `LogZoo.h`, minus `EmitLiar`. `BetaLog`
decodes here and not there, which locates the loss at catalog-build time.

```cpp
// R18 control: the same three log structs as LogZoo, with NO mislabelling procedure.
// If BetaLog decodes here but not in LogZoo, a single mislabelled LOG_ call poisons the tag
// for the correctly labelled log that owns it.
using namespace QPI;

enum LogKind { KindAlpha = 11, KindBeta = 22, KindGamma = 33 };

struct LogCleanUnused
{
};

struct LogClean : public ContractBase
{
    struct StateData
    {
        uint64 count;
    };

    struct AlphaLog
    {
        uint32 _contractIndex;
        uint32 _type;
        uint64 alpha;
        sint8 _terminator;
    };

    struct BetaLog
    {
        uint32 _contractIndex;
        uint32 _type;
        uint64 beta;
        sint8 _terminator;
    };

    struct GammaLog
    {
        uint32 _contractIndex;
        uint32 _type;
        uint64 g1;
        uint64 g2;
        sint8 _terminator;
    };

    struct EmitAlpha_input { uint64 v; };
    struct EmitAlpha_output {};
    struct EmitAlpha_locals { AlphaLog m; };
    struct EmitBeta_input { uint64 v; };
    struct EmitBeta_output {};
    struct EmitBeta_locals { BetaLog m; };
    struct EmitGamma_input { uint64 a; uint64 b; };
    struct EmitGamma_output {};
    struct EmitGamma_locals { GammaLog m; };

    PUBLIC_PROCEDURE_WITH_LOCALS(EmitAlpha)
    {
        locals.m._contractIndex = 0;
        locals.m._type = KindAlpha;
        locals.m.alpha = input.v;
        locals.m._terminator = 0;
        LOG_INFO(locals.m);
        state.mut().count += 1;
    }

    PUBLIC_PROCEDURE_WITH_LOCALS(EmitBeta)
    {
        locals.m._contractIndex = 0;
        locals.m._type = KindBeta;
        locals.m.beta = input.v;
        locals.m._terminator = 0;
        LOG_INFO(locals.m);
        state.mut().count += 1;
    }

    PUBLIC_PROCEDURE_WITH_LOCALS(EmitGamma)
    {
        locals.m._contractIndex = 0;
        locals.m._type = KindGamma;
        locals.m.g1 = input.a;
        locals.m.g2 = input.b;
        locals.m._terminator = 0;
        LOG_INFO(locals.m);
        state.mut().count += 1;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(EmitAlpha, 1);
        REGISTER_USER_PROCEDURE(EmitBeta, 2);
        REGISTER_USER_PROCEDURE(EmitGamma, 3);
    }
};
```

