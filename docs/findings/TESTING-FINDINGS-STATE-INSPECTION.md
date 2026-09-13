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
| core × typescript | **could not be started** | see below |
| core × clang | **could not be started** | see below |

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

## Appendix — the probe contracts, in full

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
