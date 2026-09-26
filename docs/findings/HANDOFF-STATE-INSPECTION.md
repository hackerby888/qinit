# Handoff — open state-inspection findings

Written for whoever picks this up next, including an AI session with none of the original context.
Everything needed to reproduce, fix and prove each item is here or named by path. The engagement record
with full evidence is `TESTING-FINDINGS-STATE-INSPECTION.md` in this directory; this file is the
actionable extract.

**Tree at handoff:** branch `claude/intelligent-thompson-hj271f` @ `dbb3ddd`, which is `main` @ `cf6addd`
merged in plus the findings commits. Every `file:line` below was checked against that tree.

---

## Step 0 — re-measure before fixing anything

Only one of the eight findings has been re-checked against current `main`. The other seven were measured
before a 148-commit merge that **rewrote `packages/cli/src/trace/state-diff.ts`** (`17b93ef`, 476+/467−).
The line numbers below are current; the *behaviour* may have moved.

So: reproduce a finding first, confirm it still fails, then fix it. Do not fix from this document alone.
If a repro now passes, say so and mark the finding fixed rather than patching around it.

### Already fixed — do not re-fix

**R21-E1 — layout derived without the node's compile-time defines.** qinit parsed the system-contract
headers without `TESTNET`/`LITE_WASM_SC`, derived the 676-computor layout, and demanded 183,296 bytes from
contracts the node reports as 9,088. `GQMPROP` and `CCF` read back `complete: False`.

Fixed on `main`. Verified empirically, not by trusting the absence of an error — the computed layout now
sums to exactly what the node reports:

```
GQMPROP (slot 6): node stateSize = 9088
  proposals.proposersAndVoters.currentProposalProposers   256
  proposals.proposals                                   2688      <- was demanding 177152
  revenueDonation                                       6144
  summed                                                9088      exact match

CCF (slot 8): node stateSize = 476784
  summed containers 476768 + 16 bytes of scalar fields = 476784    exact match
```

The fix corrected the layout derivation. It did **not** add a guard, which is why F8 below is still open.

---

## The open items, in the order I would fix them

Cheap and certain first, so the expensive ones are attempted against a tree that is already cleaner.
`Score` is the reachability-weighted judgement from the ranking (out of 10, reachability dominant); it is
a judgement, not a formula.

| Order | Item | Was | Score | Difficulty |
| --- | --- | --- | :-: | --- |
| F1 | Digit separator mis-lexed as a character literal | R12-E1 | 5.0 | Easy — one line |
| F2 | Computed layout never checked against the node's `stateSize` | (new, from R21) | — | Easy |
| F3 | One mislabelled `LOG_` makes a correct log undecodable | R18-E1 | 6.5 | Easy to detect, Medium to recover |
| F4 | Past-capacity documentation over-generalises | R7-E1 | 4.5 | Easy (docs) / Impossible (detection) |
| F5 | Nested BitArray renders clean while its bytes carry a set bit | R9-E1 | 6.5 | Medium |
| F6 | `state.get()` guard misses a mutating method call | R11-E1 | 8.0 | Medium |
| F7 | Three `const T&` accessors accept mutation on the typescript cell | R10-E1, R9-E2 | 7.5 | Medium-Hard |
| F8 | MIGRATE before-image is a zeroed buffer | R14-E1 | 7.0 | Hard — entangled |

---

## F1 — a C++14 digit separator is mis-lexed as a character literal

**Score 5.0 · Easy · highest confidence of anything here**

### Symptom

```cpp
state.mut().marker = 1'000'000;
```

is rejected on both cells with a `qpi/no-char` diagnostic about character literals. The tokenizer sees
`'000'` and emits `CHAR_LITERAL`. A digit separator is not a character literal.

### Cause

`packages/compiler/src/frontend/lexer/number-lexer.ts:38-48` — the decimal loop accepts digits and one
`.` and nothing else:

```ts
while (!lexer.eof()) {
    const ch = lexer.peekChar();
    if (ch >= "0" && ch <= "9") {
        text += lexer.advance();
    } else if (ch === "." && lexer.peekChar(1) >= "0" && lexer.peekChar(1) <= "9") {
        isFloat = true;
        text += lexer.advance();
    } else {
        break;
    }
}
```

The hex branch (`:14`) and the binary branch (`:26`) both already accept `'`. Only decimal does not. The
number ends at the first `'`, the lexer then dispatches on `'` into
`packages/compiler/src/frontend/lexer/literal-lexer.ts:5` `lexCharLiteral`, and `qpi/no-char` fires.

Downstream is already correct: `packages/compiler/src/frontend/lexer/integer-literals.ts:6` strips
separators (`.replace(/'/g, "")`) and its own header comment says it handles them. So this is a lexer gap,
not a design decision — one branch of three was missed.

### Repro

Probe (full source in the appendix of this file):

```sh
bun run dev deploy <probe>/DigitSep.h --contract-name DigitSep --compiler typescript --json
bun run dev deploy <probe>/DigitSepC.h --contract-name DigitSepC --compiler clang --json
```

Controls that must keep passing: `PlainNum.h` writes the same value without separators, `CommentApos.h`
puts an apostrophe inside a comment. Both accepted today; both must stay accepted.

### Oracle

Two real compilers, not the other cell — both cells share qinit's tokenizer, so they cannot referee each
other:

```
clang++ -std=c++14 -Werror sep.cpp   exit=0   runs -> 0  (big == plain)
g++     -std=c++14 -Werror sep.cpp   exit=0   runs -> 0
```

### Suggested fix (unverified)

Accept `'` in the decimal loop, the same way hex and binary do. Then `parseIntLiteral` already handles the
text.

### Proof required

- `DigitSep.h` deploys on both cells and `marker == 1000000` in the state read-back — not just "compiles".
- `PlainNum.h` and `CommentApos.h` still accepted; a genuine `char` literal still rejected by `qpi/no-char`.
- Add lexer cases for the shapes a naive fix breaks: `1'000.5`, a trailing `1'`, a doubled `1''000`, and
  `1'000ULL` with a suffix. A trailing separator must not swallow the next `'` in the file and turn a later
  legitimate rejection into silence.

### Why this matters more than "usability"

The original filing said core's uses of the notation "are all inside comments". That was true of `core-v7`
only. core-lite's own source has **33 uses, many in executable code**:

```
src/extensions/overload.h:1593              5'000'000'000ULL
src/extensions/tick_fork_rollback.h:37      1'000'000LL
src/extensions/ant_walker_worker.h:28       60'000
src/qubic.cpp:9267                          10'000'000'000
```

`qpi_context.h` documents a transfer bound as `[0..1'000'000'000'000'000]`. An author who copies that bound
out of the comment into code is refused with a message about character literals, which points at the wrong
thing entirely.

---

## F2 — the computed layout is never checked against the `stateSize` the node reports

**Easy · no measured severity of its own — this is the guard R21-E1 should have left behind**

### Symptom

R21-E1's specific cause is fixed. The *class* is not: if a computed layout ever again disagrees with the
node, the failure surfaces as a paging message pointing at an offset.

```
short state read at 177152: expected 6144 bytes, got 0
```

Nothing in that text leads a user to "your `--core-dir` headers are configured differently from the node".

### Cause

`packages/cli/src/trace/state-read.ts` now threads `stateSize` through, but only tests zero:

```ts
const { hex, version, stateSize } = await rpc.stateRead(contractIndex, absoluteOffset + completedBytes, remainingBytes);
if (stateSize === 0) {
    throw new QpiIncompleteReadError(`slot ${contractIndex} holds no state — the contract is not loaded`);
}
```

The node returns `stateSize` on **every** response. It is declared in `rpc/types.ts` and returned by
`client.ts`. Nothing compares it against the layout the reader derived from the headers.

### Suggested fix (unverified)

Before the first read, compare the derived total against the response's `stateSize` and fail with a message
that names the real cause and both numbers — something a user can act on, e.g. that the header tree and the
node disagree on layout and the headers are likely built with different defines.

### Proof required

Re-create the original divergence rather than trusting the new path: point `--core-dir` at headers without
`TESTNET`/`LITE_WASM_SC`, read `GQMPROP` off a node built with them, and confirm the message names the
layout mismatch and the two sizes. Then confirm a correctly configured read is unaffected — 17 of 20 system
contracts read clean in the original sweep and must still.

### Trap

Do not make this a hard failure for a contract the reader legitimately reads in part. Distinguish "my
layout is bigger than the whole state" (a configuration error) from "I asked for a window past the end"
(paging).

---

## F3 — one mislabelled `LOG_` call makes a correctly labelled log undecodable

**Score 6.5 · Easy to detect, Medium to recover**

### Symptom

`LogZoo.h` declares `AlphaLog` and `BetaLog` at the same logged size, distinguished only by `_type`, and
`EmitLiar` fills an `AlphaLog` while tagging it `KindBeta`. Every log in the contract:

```
EmitAlpha  ->  name=AlphaLog  typeName=KindAlpha  fields={_contractIndex:29, _type:11, alpha:"7"}
EmitBeta   ->  name=None      typeName=None       fields=null      hex=0x1d000000160000002a…
EmitGamma  ->  name=GammaLog  typeName=KindGamma  fields={… g1:"1", g2:"2"}
EmitLiar   ->  name=None      typeName=None       fields=null      hex=0x1d000000160000002a…
```

`EmitBeta` emits a genuine, correctly labelled `BetaLog` and it does not decode. The liar failing is
defensible; the honest log is collateral damage, and the caller gets `name: null, fields: null` with no
indication that an ambiguous tag rather than a malformed log caused it.

### Cause

`packages/proto/src/decode-log.ts:38` and `:68`:

```ts
const hit = sized.length > 1 ? byTypeWord(sized, hex) : sized;
```

The IDL collects per-struct type sets, so `EmitLiar` makes `AlphaLog` claim `[11, 22]` while `BetaLog`
claims `[22]`. Tag 22 now has two owners, so `byTypeWord` is ambiguous; and because both structs log at the
same size, the size fallback cannot break the tie either. Both paths fail and `decodeLog`'s `try/catch`
returns the hex-only record.

The loss happens at **catalog-build time**, not decode time — proven by the control below.

### Repro and control

`LogZoo.h` and `LogClean.h` are both in the findings-doc appendix. `LogClean.h` is `LogZoo.h` minus
`EmitLiar` — same three structs, same three emitters. On it, `BetaLog` decodes perfectly:

```
EmitBeta   ->  name=BetaLog  typeName=KindBeta  fields={_contractIndex:30, _type:22, beta:"42"}
```

The only difference is a procedure that never runs in the comparison. That is the whole proof.

### Suggested fix (unverified)

**Part 1 — the certain one. Say so.** Return a reason on the record: ambiguous tag, with the candidate
names. `decodeLog` at `:64` returns the same bare `base` for "two candidates matched", "zero matched" and
"decode threw", which is why the caller cannot tell an ambiguity from a malformed log. Distinguishing those
three is cheap and turns a silent wrong conclusion into a correct one. Do this even if part 2 is deferred.

**Part 2 — a design question, not a patch.** Stopping the contamination itself is harder than it looks, and
the obvious framing is wrong: QPI has **no per-struct declaration** of `_type`. There is no
`AlphaLog::_type = KindAlpha` anywhere. `collectLogTypeValues` knows only what it observed being *assigned*
(`log-type-values.ts:33-68`), so "attribute the tag to the struct that declares it" is not available — do
not go looking for a declaration to key on.

What is available is weaker, and worth weighing rather than assuming:

- Record whether a tag is **exclusive** to one struct or **shared**, and decode on an exclusive tag only.
  That fixes nothing here (22 is shared) but it makes the ambiguity explicit in the IDL rather than
  implicit in a set union, which part 1 can then report.
- A heuristic that picks a winner among shared owners. I have no principled one to offer: both structs
  genuinely wrote tag 22, and nothing in the source says which meant it. A heuristic here would guess, and
  guessing between two same-size structs is exactly what round 3's finding was filed against.
- Reject the mislabel at compile time instead — warn when a contract assigns a `_type` to one struct that
  another struct of the same logged size also assigns. That catches the real-world cause (a copy-paste
  slip) at the point where the author can fix it, and leaves the decoder honest. This is my preferred
  direction, but it is a new diagnostic rather than a bug fix, so it is the contract owner's call.

Note the inconsistency worth resolving while in here: same-size ambiguity refuses silently, while
different-size ambiguity decodes by size and prints a contradicting `_type` (`AlphaLog·KindGamma`, round 3).
Two strategies, neither of which says "this tag is ambiguous".

And note what makes this reachable rather than exotic: two same-size log structs is what you get from two
events each carrying one `uint64`. The liar procedure never has to run — its presence in the source is
enough, because the set union happens when the catalog is built.

### Proof required

`LogZoo.h` decodes `EmitAlpha`, `EmitBeta` and `EmitGamma`, and whatever it does with `EmitLiar` it says
why. `LogClean.h` unchanged. A three-log procedure still returns all three in order with a refusal in the
middle — round 18 confirmed a refusal does not empty the list, and that must not regress.

---

## F4 — the past-capacity documentation and warning text over-generalise

**Score 4.5 · Easy (docs) / Impossible (detection) — read this before writing any code**

### The finding is narrower than it looks

QPI forces a power-of-two capacity (`static_assert(L && !(L & (L - 1)))`), so there are exactly two regimes:

| Capacity | Storage | `set(i)` past capacity | qinit today |
| --- | --- | --- | --- |
| `< 64`, e.g. 32 | one whole word, a dead tail | lands in the tail, nothing reads it | **⚠ warned**, `(past capacity 32)` |
| `>= 64`, e.g. 128 | whole words, **no tail at all** | word index **wraps** onto a live word | **silent** |

`get`/`set` mask the word index — `_values[(index >> 6) & (_elements - 1)]` — so on a `BitArray<128>`,
`set(200)` resolves to word `(200 >> 6) & 1 = 1`, bit `200 & 63 = 8`: **absolute bit 72**, an ordinary
in-capacity bit. Measured, both cells:

```
set(small, 40)  ->  small[40] | 0 → 1 (past capacity 32)     warning on the container
set(large, 200) ->  large[72] | 0 → 1                         warnings = None
set(large, 72)  ->  large[72] | 0 → 1                         byte-identical row
```

### The reader code is correct — do not "fix" it

`packages/proto/src/qpi-container-view/bit-array-view.ts:82` returns early when `storageBits === capacity`,
and its comment already states why. That is right: at capacity ≥ 64 there is no tail to inspect, the mask
happened inside the wasm, and by the time state bytes exist the request for 200 is gone. **No reader-side
detection is possible.** The compiler validates only that the bit count is a power of two
(`validatePowerOfTwoDimension`) and could not catch a runtime index anyway.

### What is actually wrong

The wording, in two places, presents mechanism and consequence as one:

- `docs/cli-guide.md:1293-1294` — *"core's `set(i)` masks only the word index, so an out-of-range `set`
  lands past the declared length"*. That consequence holds **only below 64**; at and above it the same mask
  lands *inside* the declared length, on live data.
- `packages/cli/src/trace/state-format.ts:152-159`, `pastCapacityWarning` — *"which core doesn't reject and
  get(i) reads back"*, generalised, while the warning only ever fires for the small case.

### Suggested fix (unverified)

Correct both texts to state the two regimes, and say plainly that at capacity ≥ 64 an out-of-range set is
indistinguishable from an in-range one and qinit cannot surface it. A developer reading either text today
would conclude out-of-range sets are surfaced. On the arrays where such a set corrupts live state, they
are not.

### Proof required

The `BitCap.h` output above is unchanged — this is a wording change and must not move a single row. Same
`setBitsPastCapacity` test expectations in `packages/proto/tests/codec/qpi-container-view.test.ts:218-238`.

---

## F5 — a nested BitArray renders clean while its bytes carry a set past-capacity bit

**Score 6.5 · Medium · this one is a wrong answer, not a missing warning**

### Symptom

Where a BitArray gets its own container block it is listed and warned. Where it is rendered inline as part
of an enclosing element's value, only the declared range is rendered and the set bit vanishes:

```
plain            [0..31] = =0 ×32 (skipped)
                 [40]    = =1 (past capacity 32)          warned

inStruct.flags   [0..31] = =0 ×32 (skipped)
                 [40]    = =1 (past capacity 32)          warned

inArray[0]       {lead: 0, flags: [0..31]=0 ×32 (skipped), trail: 0}    warnings = None
inMap slot[5]    {lead: …}                                              warnings = None
```

`qinit state` **displays the array as clean** while its storage carries a set bit. A reader auditing that
state concludes the opposite of the truth. That is the difference between this and F4.

### Cause

Two functions over the same bytes, only one of which knows about the tail:

- `packages/cli/src/trace/state-read.ts:504` `readBitArrayBlock` — the container path. Renders the declared
  range, then iterates `view.setBitsPastCapacity()` and emits a row per run (`:532-545`).
- `packages/cli/src/trace/state-format.ts:102` `formatBits` — the inline path, reached from `abiValueText`
  at `:186`:
  ```ts
  case AbiTypeKind.BIT_ARRAY: {
      const bits = Array.isArray(value) ? value : [];
      return formatBits(type.bitCount, (index) => Number(bits[index] ?? 0), showAll);
  }
  ```
  `formatBits` loops `index < bitCount` and stops. It never sees the storage word, so it cannot render the
  tail, and no `pastCapacityWarning` is raised for the nested path.

### Repro

`BitNest.h` / `BitNestC.h` in the findings-doc appendix — `BitArray<32> plain; Holder inStruct;
Array<Holder,2> inArray; HashMap<id,Holder,8> inMap;` with `Holder { uint64 lead; BitArray<32> flags;
uint64 trail; }`. Set bit 40 at each of the four depths, then `qinit state` and compare against the dump.

Note `InArray` must copy-modify-write-back, because `Array::get` returns `const T&`:

```cpp
// Array::get returns `const T&`, so the element is copied out, mutated, and written back.
PUBLIC_PROCEDURE_WITH_LOCALS(InArray)
{
    locals.h = state.get().inArray.get(input.slot);
    locals.h.flags.set(input.idx, true);
    state.mut().inArray.set(input.slot, locals.h);
}
```

### Oracle

The raw dump, which knows nothing of how qinit chose to render anything:

```
typescript  plain @0            set=[40] past32=[40]      clang  same
            inStruct.flags @16  set=[40]
            inArray[0].flags @40 set=[40]     <- rendered clean
            inArray[1].flags @64 set=[]
```

### Suggested fix (unverified)

The reader already holds the bytes it rendered the element from; it simply does not descend. Give the inline
formatter the storage width alongside the declared capacity so it can render the tail the way
`readBitArrayBlock` does, and raise `pastCapacityWarning` with the nested path (`inArray[0].flags`) as the
`path` argument — the function already takes one and already folds indexes to runs.

### Proof required

- All four depths show bit 40 and warn, on both cells, matching the dump.
- `inArray[1].flags` stays empty. It is the offset-arithmetic control: if it starts reporting bits, the
  descent is reading the wrong bytes.
- The container-path rows for `plain` and `inStruct.flags` are unchanged.
- `--all` / `showAll` truncation still applies; the tail must not escape the `MAX_ITEMS` cap and turn a
  large nested array into a wall of rows.

### Note on the diff side

At write time the diff row **did** warn for `inArray`. qinit saw the write and lost it only on read-back, so
the diff path is not where the bug is.

---

## F6 — the `state.get()` guard catches assignment but not a mutating method call

**Score 8.0 · Medium · the highest-scoring open item**

### Symptom

QPI declares:

```cpp
const T& get() const { return _data; }
T& mut() { ::__markContractStateDirty(contractIndex); return _data; }
```

The guard exists and is deliberate. It has a precise hole:

```
case            typescript  clang       verdict
GetScalar       REJECT      REJECT      agree      state.get().marker = v
GetArray        OK          REJECT      DIVERGENCE state.get().arr.set(0, v)
GetBits         OK          REJECT      DIVERGENCE state.get().flags.set(3, true)
MutScalar       OK          OK          agree      positive control, the legal form
```

```
typescript, GetScalar:  error: cannot modify through get(): it returns a read-only view — use mut()
clang,      GetArray:   error: 'this' argument to member function 'set' has type 'const Array<uint64, 4>',
                               but function is not marked const
```

Both forms are equally illegal C++. A contract written against `state.get()` with container mutations
compiles, deploys and behaves correctly on the typescript cell while being **unbuildable for the real core**.

### Cause

`packages/compiler/src/frontend/validation/expression-validator.ts:203` — the guard models the
`get()`/`mut()` distinction for a direct assignment and does not follow a mutating method call on a
sub-object.

### Suggested fix (unverified)

Extend the same check so a call whose receiver chain passes through `state.get()` is rejected when the
called member is not `const`. The diagnostic at `:203` is already the right message; it needs to reach the
method-call form.

### Proof required

- `GetArray` and `GetBits` rejected by the typescript cell with the `get()` diagnostic, not by accident with
  an unrelated parse error. Read the message — see the trap below.
- `MutScalar` still accepted. It is the positive control; without it a fix that rejects everything looks
  like success.
- `GetScalar` still rejected with the same message.

### Trap, and a hypothesis that was already falsified

Do **not** assume a write through `get()` is invisible to the engine because `mut()` is what raises
`__markContractStateDirty`. That was tested directly with `GetOnly.h` (appendix of the findings doc) — one
procedure whose only write goes through `get()`, `mut()` never called:

```
CONTROL  Honest (arr[1] through mut())    row: arr[1] | 0 → 4242    bytes changed: [16, 17]
TEST     Sneak  (arr[0] through get())    row: arr[0] | 0 → 777     bytes changed: [8, 9]
```

The write lands and **is reported correctly**. The typescript engine does not depend on the wasm-side dirty
marker to notice a write. So this is a compile-time parity divergence and nothing more. Do not write a fix
or a test that claims hidden state corruption — there isn't any on that cell.

Also: `MapKey` rejecting on both cells is **not** a control. Its diagnostic is
`error: unsupported call statement [state.mut(0).c.key(1).set(2)]` — the analyzer failing to model the call
shape, not enforcing const. `KeyT` is `id`, whose API has no matching `set`. Do not cite it as evidence the
compiler models const-ness anywhere.

---

## F7 — three `const T&` accessors accept mutation on the typescript cell, and the write lands

**Score 7.5 · Medium-Hard · same area as F6, so fix F6 first**

### Symptom

QPI declares these accessors `const T&`. The typescript compiler accepts mutation through them; clang
refuses the identical source. Both cases were deployed and the changed bytes compared:

```
MapValue: 416 bytes, changed at [45, 408, 409]   marker bytes moved: 2   OTHER bytes moved: 1 -> [45]
ListElem: 312 bytes, changed at [13, 304, 305]   marker bytes moved: 2   OTHER bytes moved: 1 -> [13]

MapValue: byte 45  0x00 -> 0x01   bit set = 0
ListElem: byte 13  0x00 -> 0x01   bit set = 0
```

The two marker bytes are the procedure's one legal write. The single remaining byte in each case is
`0x00 -> 0x01` at a byte-5 offset into the `BitArray<64>` — absolute bit 40, exactly what the const accessor
was told to set. The write is not optimised away and does not land in a temporary: it reaches contract state
through a path QPI forbids and the real core cannot compile.

The accessors, and the probe for each:

| Accessor | Probe | Statement |
| --- | --- | --- |
| `HashMap` value | `MapValue.h` (findings appendix) | `state.mut().m.value(0).flags.set(40, true)` |
| `LinkedList::element` | `ListElem.h` (appendix below) | `state.mut().c.element(0).flags.set(40, true)` |
| `Array::get` | `BitNest.h` (findings appendix) | `state.mut().inArray.get(input.slot).flags.set(input.idx, true)` |

The `Array::get` case was found separately (round 9, filed as R9-E2) and is the same defect. Clang's
diagnostic on it names the const-ness precisely:

```
error: 'this' argument to member function 'set' has type 'const BitArray<32>', but function is not marked const
note: 'set' declared here   (core-v7/src/qpi/qpi_containers.h:35)
```

### Cause

Same validator area as F6. There is **no** evidence the typescript compiler models const-ness on container
accessors anywhere: three of three violations it could parse were accepted.

### Suggested fix (unverified)

Model the declared const-ness of QPI container accessors so a mutating call on their result is rejected.
Whether that is best done in the validator or by carrying const through the type resolver is a design call
for whoever holds the compiler — that is why this is Medium-Hard rather than Medium.

### Proof required

The natural home is `packages/compiler/tests/differential/container-parity.test.ts`. A case per accessor,
each asserting the typescript cell rejects what clang rejects. Then re-run the three probes end to end and
confirm the forbidden byte no longer appears in the dump.

### Trap

The two sources per case must be byte-identical apart from the struct rename — the contract name must match
the struct name, so the clang twin is a sed-renamed copy (`MapValue` → `MapValueC`). `diff` the procedure
bodies to prove it. A divergence found between two files that differ in some other way is not a divergence.

---

## F8 — the MIGRATE trace's before-image is a zeroed buffer

**Score 7.0 · Hard, and entangled with a second defect · read the caveat before deciding it is a bug**

### Symptom

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

The rendered migration diff says roughly 152 bytes moved where **none** did, and every preserved value —
the two map entries, the marker — reads as `0 → v`, appearing from nothing. A reader cannot distinguish
"the migration preserved everything" from "the migration recreated everything from scratch". Those are very
different events for anyone auditing an upgrade.

### Cause — found, and it is a six-line ordering problem

`packages/engine/src/contract/runtime.ts`:

```
859:        memory.fill(0, this.stateAddr, this.stateAddr + this.stateSize);
...
867:        const stateBefore = recorder ? this.stateSnapshot(this.stateSize) : EMPTY;
```

The new state region is zeroed at `:859`, and the before-image is snapshotted from that same region at
`:867`. So the before-image is a snapshot of a buffer that was deliberately cleared eight lines earlier. It
is not lost data — `oldState` is copied to `oldStateOffset` at `:861` and is in hand.

### Why this is Hard rather than Easy

The old state has the **old layout and old size** — 192 bytes against the new 200 in the probe. Handing
`oldState` to the recorder as the before-image produces a region whose two sides have different lengths, and
the diff walk is not ready for that:

- `changedWindowsOf` in `packages/cli/src/trace/state-diff.ts` computes
  `end: off + Math.min(before.length, after.length)`.
- `imageAt` bounds against the individual side's `image.length`.

That mismatch is the "lopsided window" lead recorded in round 7 and never filed. Fixing F8 properly means
fixing it, which is why the two are entangled. A fix that only reorders the snapshot will produce a
truncated or mis-bounded migration diff instead of a zeroed one.

### Repro

`MigZoo1.h` and `MigZoo2.h` (appendix below). Deploy v1, `Put` two map entries and `Bump` the marker, then
deploy v2 into the same slot so its `MIGRATE` runs. Dump the state before and after the migration
independently, then read the `kind=3` frame from `/live/v1/debug-trace`.

### The caveat, stated plainly

There is a defensible reading in which the current output is correct: a migration allocates a fresh buffer
for the new layout and the handler writes into it, so the before-image *of that buffer* genuinely was zeros,
and the trace is truthful about writes. What makes it a finding anyway is that the engine demonstrably holds
the old bytes — it copied them in, and the identical after-image proves it knows the result — so a
before-image reflecting the prior state is available. As rendered, the diff is a true statement about a
buffer and a false one about the contract's state.

If whoever fixes this decides the current behaviour is intended, that is a legitimate conclusion. Then the
right change is to **label** the region as a fresh-buffer write rather than a state diff, so a reader is not
invited to read it as one. Do not leave it ambiguous.

### Proof required

- The MIGRATE region's before-image matches the independent pre-migration dump over the carried prefix.
- Preserved values render as unchanged, not as `0 → v`.
- The state transition itself stays exact — round 14 measured **0 of 192 carried bytes changed**, growth
  exactly 8, new field value correct. A fix must not move those numbers.
- Every other frame kind's before-image is still right. Round 15 confirmed that; it must not regress.

### Trap

An early reading that `region.before[0:40]` matched the old state was **coincidence** — the real old state
is also zero over those 40 bytes, so the agreement carried no information. Compare whole images, never
prefixes.

---

## Environment — bringing the cells up

Findings are stated per cell. Two of the four are cheap; all four are available.

| Cell | How |
| --- | --- |
| simulator × typescript | `bun run dev node run --runtime simulator --compiler typescript --core-dir <headers>` |
| simulator × clang | same node; `qinit deploy --compiler clang` per contract |
| core × typescript | a core-lite build — see below |
| core × clang | same node |

### The core cell

Six rounds recorded it as unavailable. It was a missing `-D`. core-lite's CI passes
`-DTESTNET_PREFILL_QUS=ON`, which funds the two `customSeeds` with 10 billion QUs immediately after
`loadSpectrum()`. Without it the spectrum is genuinely empty, nothing can pay for a deployment, and
`state-read` answers `bad slot` for every index — which reads exactly like an environmental problem.

Build with it and the node works:

```
deploy ok=True slot=30
complete: True   fields a..f = 0   containers m, s, q, l, arr, bits all status=loaded
```

Two things that cost time:

- The core dynamic slot window is **30..77**. Slot 29 gives `Tiny slot 29 is outside the dynamic window
  30..77` — a working node declining an out-of-range slot, not a failure.
- Both the engine's and core-lite's `state-read` RPC take **`slot=`**. `contractIndex=` returns
  `{"error":"bad slot"}`.
- The CLI flag for a node binary is `--node-bin`, not `--core-binary`.

---

## Method rules that kept this honest — keep them

These are not ceremony. Each one is here because dropping it produced a false finding at least once.

1. **Real flow only:** `build → node run → deploy → call --proc → inspect`. Never call `stateDiffLines`
   directly and never hand-build a `DebugStateRegion` array. A finding produced by feeding the renderer a
   synthetic input is a finding about your input.
2. **Raw bytes are the oracle.** `qinit state --dump` plus a conservation check, never qinit's own row
   validating qinit's other row. Four readers exist over the same bytes — container view, diff reader, K12
   digest, explorer — and they are independent only if you keep them so.
3. **`QINIT_STATE_DIFF=verify` must be live, and verified** via `/proc/<pid>/environ` on the node process,
   not assumed. The node daemonizes as `bun .../packages/cli/src/index.tsx __serve`, so a `pgrep -f` pattern
   built from the command you typed will not match it — and a pattern loose enough to match will also match
   your own checking shell. Select on `argv[0]` ending in `/bun` plus `__serve`.
4. **One cell per node.** Two cells on one node once produced an agreement for the wrong reason: the
   typescript trap halted the node, so the clang row read a dead node.
5. **Run core binaries from a temp directory.** They create runtime data relative to the working directory.
   `qinit state --dump` also writes into the project unless given `--out` — use it.
6. **Report the numbers, never "passed."** And say explicitly when a cell could not be started.
7. **State the control that rules out your own error**, per finding. Half the retractions in the record came
   from a control that looked like one and wasn't.
8. Trace entry frames are keyed on **`index`**, not `contractIndex`. Keying on the wrong field once
   fabricated four false positives that looked exactly like a real finding.
9. `cmd | tail` returns **tail's** exit status.
10. Avoid the all-zero id (60 `A`s) as a container key — it collides with "empty" in more than one reader.
11. Long values are truncated at 60 characters in some views, which can make distinct rows look duplicated.

---

## Appendix — probe contracts not already in the findings document

The findings document's own appendix (`# Appendix — the probe contracts, in full`) has `BitCap.h`,
`BitNest.h`, `MapValue.h`, `GetOnly.h`, `LinkZoo.h`, `LogClean.h`, `FailWords.h`, `JsonShapes.h` and the
earlier rounds' probes. These are the ones it does not.

### `DigitSep.h` — F1

```cpp
// R12 parity probe: constructs the token-based source policy may reject textually.
using namespace QPI;

struct DigitSepUnused
{
};

struct DigitSep : public ContractBase
{
    struct StateData
    {
        uint64 marker;
    };

    struct Poke_input { uint64 v; };
    struct Poke_output {};

    PUBLIC_PROCEDURE(Poke)
    {
        state.mut().marker = 1'000'000;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Poke, 1);
    }
};
```

Controls: `PlainNum.h` is the same file with `marker = 1000000;`, `CommentApos.h` the same file with the
apostrophe inside a comment. The clang twins are sed renames (`DigitSep` → `DigitSepC`), because the
contract name must match the struct name.

### `GetArray.h` / `GetBits.h` / `GetScalar.h` — F6

One statement differs between the three. Each pairs the illegal write with a legal one, so a rejection
cannot be blamed on the procedure as a whole:

```cpp
// R11 parity probe: a write reached through `state.get()`, which QPI declares `const T& get() const`.
PUBLIC_PROCEDURE(Poke)
{
    state.get().arr.set(0, input.v);      // GetArray  — accepted by typescript, rejected by clang
    // state.get().flags.set(3, true);    // GetBits   — accepted by typescript, rejected by clang
    // state.get().marker = input.v;      // GetScalar — rejected by both (negative control)
    state.mut().witness = 12345;
}
```

`MutScalar.h` is the positive control: `state.mut().marker = input.v;` alone.

### `ListElem.h` — F7

```cpp
PUBLIC_PROCEDURE(Poke)
{
    state.mut().c.element(0).flags.set(40, true);
    state.mut().marker = input.v;
}
```

`MapValue.h` is the same shape with `state.mut().m.value(0).flags.set(40, true)` and is in the findings
appendix. Both need a `BitArray<64>` inside the element/value struct so the forbidden write lands on a byte
the marker does not touch.

### `MigZoo1.h` / `MigZoo2.h` — F8

```cpp
// Migration probe v1: a container plus a marker, so the v2 MIGRATE reads an old state that holds a container.
using namespace QPI;

struct MigZooUnused
{
};

struct MigZoo : public ContractBase
{
    struct StateData
    {
        HashMap<id, uint64, 4> bal;
        uint64 marker;
    };

    struct Put_input { id k; uint64 v; };
    struct Put_output { sint64 idx; };
    struct Bump_input {};
    struct Bump_output {};

    PUBLIC_PROCEDURE(Put) { output.idx = state.mut().bal.set(input.k, input.v); }
    PUBLIC_PROCEDURE(Bump) { state.mut().marker += 1; }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Put, 1);
        REGISTER_USER_PROCEDURE(Bump, 2);
    }
};
```

```cpp
// Migration probe v2: the old state (a container + a marker) arrives as the MIGRATE entry's input.
using namespace QPI;

struct MigZooUnused
{
};

struct MigZoo : public ContractBase
{
    struct StateData
    {
        HashMap<id, uint64, 4> bal;
        uint64 marker;
        uint64 extra;
    };

    struct OldStateData
    {
        HashMap<id, uint64, 4> bal;
        uint64 marker;
    };

    struct Put_input { id k; uint64 v; };
    struct Put_output { sint64 idx; };
    struct Bump_input {};
    struct Bump_output {};
    struct Get_input {};
    struct Get_output { uint64 marker; uint64 extra; uint64 pop; };

    PUBLIC_PROCEDURE(Put) { output.idx = state.mut().bal.set(input.k, input.v); }
    PUBLIC_PROCEDURE(Bump) { state.mut().marker += 1; }
    PUBLIC_FUNCTION(Get)
    {
        output.marker = state.get().marker;
        output.extra = state.get().extra;
        output.pop = state.get().bal.population();
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Put, 1);
        REGISTER_USER_PROCEDURE(Bump, 2);
        REGISTER_USER_FUNCTION(Get, 1);
    }

    MIGRATE()
    {
        state.mut().bal = oldState.bal;
        state.mut().marker = oldState.marker;
        state.mut().extra = 4242;
    }
};
```

### A QPI constraint that bites when adapting any of these

Local variables are not allowed in procedures. Use `PUBLIC_PROCEDURE_WITH_LOCALS` with a `<Name>_locals`
struct. `Array::get` returns `const T&`, so an element is copied out, mutated, and written back — see the
`InArray` body under F5.

---

## What is not in scope here

- The eight earlier defects (S1–S8) are fixed and merged — qinit#23 landed as `c92bd84` on `main`,
  and core-lite#11 landed on `develop`.
- The churn follow-up on the per-slot state version — narrowing the comparison to overlapping ranges so a
  contract writing every tick reports a view rather than a race — is named in both merged PR bodies as the
  next change and was not attempted.
- core-lite's residuals from the seqlock work: native slots never bump, boot-time state restore is
  uncovered, and the `contractStates[i]` pointer race is narrowed rather than closed.
