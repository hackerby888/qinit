# Cheatcodes

> **Scope** — the `CC_*` macros: what they are, how each backend lowers them, how they reach a reader,
> and how they are removed before a contract is submitted to Qubic Core.
> **Read when** — adding a cheatcode, changing the strip, or working out why one is not showing up.
> **Related** — [compiler walkthrough](./compiler-walkthrough.md) for the stages the shim sits between;
> [cli guide §14](./cli-guide.md) for the two testing systems these do *not* replace.

Cheatcodes are development scaffolding written inside contract source. Qinit strips them before the
contract reaches a Core checkout, so what ships is clean and its wasm is unchanged.

```cpp
CC_PRINT("balance is", state.get().total);   // any mix of words and values; legal in a function
CC_ASSERT(input.amount > 0);                 // abort carrying the source line
CC_PAY(input.to, 1000);                      // procedure only
CC_DEAL(alice, 1000000);                     // set a balance outright
CC_WARP_TICK(10);  CC_WARP_EPOCH(1);         // shift what the contract observes
CC_PRANK(alice, 500);  CC_UNPRANK();         // change the caller it sees
```

## 1. Why not `LOG_*`, and why not `CC::`

`LOG_INFO` cannot carry this. It is procedure-only (`doc/contracts.md:162`, and `logBytes` is in
`MUTATING_LHOST_IMPORTS`), it consumes a chain log id, and its payload must be a struct with a reserved
header word and a `_terminator`. A debug print has to work inside a function and must not become a
protocol event.

`CC::log(...)` is not available either: `::` outside a qpi.h or contract scope is a hard error in
`contractverify`, which runs over the raw header. A macro also reaches `qpi` and resolves `__LINE__` at
the call site, which a namespace-scope function cannot.

The name is `CC_PRINT`, never `CC_LOG`, so it cannot be mistaken for the protocol log.

## 2. The channel

Everything except `CC_ASSERT` (existing `abort` row) and `CC_PAY` (existing `transfer` row) rides one
new host import, `cheat(op, a, b, ptr, len) -> sint64`, added to core-lite's canonical ABI at version 6.
One opcode-dispatched row rather than one row per cheat, so a later cheatcode costs no import and no
further ABI bump.

`CHEAT_OP_PRINT` records against the debug trace and nothing else — no log id, no qLogger, no tick log
range, no entry in `idl.logs`. Both runtimes already serve `/live/v1/debug-trace`, so
`qinit debug` shows cheat rows beside log rows without either interfering with the other.

Refusal is always a negative return, never a trap:

| Code | Meaning |
|---|---|
| `-1` | unknown opcode — a newer client against an older node |
| `-2` | cheats not compiled in (a non-`TESTNET` build) |
| `-3` | a mutating opcode called from a function |

The row is deliberately **not** in `MUTATING_LHOST_IMPORTS`. That list is a per-import ban and would
block `CC_PRINT` from every function, so the mutating opcodes check the entry kind themselves instead.

Consensus is not at risk: `CMakeLists.txt:72` makes `LITE_WASM_SC` a fatal error without `TESTNET`, so
the wasm contract engine only exists in testnet builds. The `#if defined(TESTNET)` guards inside the
handler are a second layer, not the first.

## 3. Strings cost nothing

The TypeScript backend has no string codegen at all, and QPI bans string literals. Both problems go away
because a literal is never lowered: the compiler interns it in the IDL and emits no code for it.

```
cheats: [{ id: 33, line: 33, parts: [{ lit: "adding" }, { type: <uint64>, expr: "input.amount" }] }]
```

The contract sends only `(line << 8 | ordinal, bytes)`, and both runtimes unpack that into `(line,
part)` before it reaches the trace. The reader joins the two back together. A value with no literal in
front is labelled with `expr` — the argument's own source text, captured at compile time, which is more
accurate than a hand-written label and costs nothing at runtime.

Because the tag is the line, **a line holds at most one `CC_PRINT`** (`cheat/too-many-per-line`); an
assert may share it.

What a value part carries depends on whether the argument has an address:

| Argument | Wire | IDL type |
|---|---|---|
| anything addressable — `input`, `locals.abc.ab`, `state.get().items.get(0)`, `qpi.invocator()` | its bytes, at the layout's size (an empty struct is one byte) | the declared type, so the reader decodes it |
| a scalar temporary — `output.value + 2`, `qpi.tick()` | the value in the register slot, no bytes | `uint64`; a signed expression prints unsigned, so print the lvalue when the sign matters |

The reader decodes a value only when the bytes are exactly its type's size. Anything else — a stale IDL,
a shape the compiler could not type, bytes that contradict themselves — is shown raw with both sizes
(or marked undecodable) rather than dropped, and each part and each section of the trace decodes on its
own, so one unreadable value never blanks the rest.

A print is never cut short or elided: no terminal-width truncation, no `… +N more` cap. A print of
**one value that holds a container** — `state.get()`, `input` with an `Array` in it, a bare `HashMap` —
renders as the blocks `qinit state` draws, from the same decoder and the same components
(`state-read.ts` `decodeValueBlocks`, `views.tsx` `StateBlocks`): every scalar field as a row, then each
container under its own header with its counts, zero runs and unoccupied slots collapsed. A container
reached through struct fields is named for the path to it (`test_struct.map`) and gets a block of its
own, which is where `qinit state` picked up the same fix. Blocks in a print carry no `[n]` badge: there
is no `--container` to load them with. Two ceilings: a print with several values stays inline
(`"nums", state.get().nums, "second", …` is one line), and a container below a *container's element*
(`Array<TestStruct, 8>`) stays JSON, since a block per element would bury the container it lives in.
The `qinit debug` pane cannot scroll a block, so it shows the row count and points at `qinit call --trace`.

`"a" + value` is not supported and never will be: it fails to lower in one backend and is pointer
arithmetic in the other. Use the comma form.

## 4. Both backends

| | TypeScript backend | clang backend |
|---|---|---|
| Shim | `driver/qpi/cheats.ts`, injected in `contract-frontend.ts` | `assets/qinit_cheats.h`, injected in `generateWasmWrapperSource` |
| `CC_PRINT` | `__qinit_cheat_print` intrinsic in `host-intrinsic-call.ts`: addressable → bytes, else register | forwarding-reference pack: an lvalue ships bytes, an integral temporary rides the register, a literal is skipped |
| mutator refused | `if (result < 0) abort(0xCC1E0000 \| op)` around the call | the same abort in the macro |
| `__LINE__` base | derived from the real prelude, never pinned | 0 — the contract is `#include`d |

The two shim texts differ; `cheat-parity.test.ts` is what holds them to the same `(id, part, size, hex)`
on the wire, over `fixtures/Cheats.h` and every shape in `fixtures/CheatShapes.h`. It is the test that
caught the base being off by one, so do not delete it.

Neither macro ends in a `;` of its own: the user's semicolon closes the statement, so
`if (c) CC_PRINT(x); else f();` parses, and the strip (which keeps that `;`) matches the neutered build.

The clang placement matters twice: `clangd-config.ts:176-183` builds the editor's prefix header by
slicing the wrapper at the contract include, so a shim before that include reaches clangd with no
extension change.

**The cheats table is collected from the AST, not during emission** (`idl/collect-cheats.ts`). The
analyzer builds an IDL without generating any WAT, and that path is what feeds the clang backend's IDL
and both editors — collecting at emission would leave them empty.

## 5. Getting them out again

`qinit integrate` is the only hand-off to a Core checkout, so it scans, strips, and refuses on residue.
`qinit strip <file.h>` shows the same output beforehand. `qinit build --production` compiles a stripped
scratch copy — a build never rewrites the file you are working on.

`contractverify` is also given the stripped source. It bans string literals, so a `CC_PRINT` label would
otherwise fail a check for code that never ships.

### The gate

Two halves, and the second alone would be a tautology, because a neutered build erases a *missed*
cheatcode too:

1. `compile(strip(s), cheats: "off")` **succeeds** — with no shim, anything left behind is an undeclared
   identifier. This is exactly what Core does.
2. its wasm is **byte-identical** to `compile(s, cheats: "noop")` — so the strip removed only cheat text.

`cheat-strip-gate.test.ts` runs both, and a third defence is free: a leftover `CC_` fails the real Core
compile anyway, since Core's headers never define it.

## 6. Rules, and why each exists

`analyzer/cheatcodes.ts` enforces the properties that make blanking a call provably harmless.

| Rule | Why |
|---|---|
| `cheat/reserved-prefix` | The analyzer resolves no call targets, so nothing else catches a typo'd cheat name |
| `cheat/statement-only` | Blanking must never change an expression; this is also why a snapshot handle can never be returned |
| `cheat/no-side-effects` | The gate cannot catch this — a neutered build and a stripped build both drop the side effect, so only dev-versus-production diverges |
| `cheat/mutator-in-function` | Caught at compile time rather than left to the host's `-3` |
| `cheat/too-many-per-line` | The wire tags a print by its line alone, so a second `CC_PRINT` there would read back as the first |

`qpi/no-string` and `qpi/no-char` are suppressed inside a cheat argument, since those literals are
interned rather than lowered. Aliasing needs no rule: `qpi/no-preprocessor` already forbids `#define` in
contract source.

## 7. What has actually been exercised

Both compilers, both runtimes. `cheat-parity.test.ts` runs each backend's wasm through the engine and
asserts identical `(id, part, size, hex)`; a cheat-carrying contract has also been deployed to a real
core-lite node and called, with the printed values read back off `/live/v1/debug-trace` and the
protocol log left empty.

`fixtures/CheatShapes.h` is the argument matrix: a bare `input` (empty), `output` and `state.get()`, a nested struct
and a field inside it, `uint16`/`sint32`/`bit`, `Array` whole and by `get`, `id` from state and from
`qpi.invocator()`, a `HashMap`, an rvalue, values at ordinal 0 and 5, and a print on each side of an
unbraced `else`. Four layers read it: `cheat-idl-types.test.ts` pins the IDL type of every part,
`cheat-channel.test.ts` checks every wire record is exactly its IDL type's size (the arbiter — an
argument the typer misses ships its real bytes against a `uint64` and fails here), `cheat-parity` holds
both backends to the same records, and `cheat-end-to-end.test.ts` reads the text back, once through the
IDL file a deploy writes. `cheat-decode.test.ts` covers what the IDL cannot explain: a size mismatch,
an unknown site, no IDL at all, a corrupt sibling section, a line past 255.

That matrix exists because a `CC_PRINT(input)` on an empty struct once lost every print row of its
call: the IDL typed a bare root as `uint64`, the wire carried one byte, the decode threw, and a single
`catch` around the whole trace swallowed it. Neither backend was at fault and both were affected.

That live run was worth doing, because it found a bug the simulator structurally could not.
`w_cheat` treated a zero guest offset as "no payload" — but offset 0 is an ordinary linear-memory
address and contract state sits there, so every `CC_PRINT` of a state read arrived with no bytes. The
engine's import keys on the length instead, and slicing a JS array at 0 is fine, so every simulator
test passed while the native path silently dropped exactly the reads worth printing.

Two lessons worth keeping: **assert the bytes, not their length** — a dropped payload still reports the
size it was asked for — and a cross-runtime feature needs at least one run on each runtime, because
this class of defect lives in the gap between them and nowhere else.

Reproducing the live leg is fiddly rather than hard. A node with no spectrum snapshot funds nobody, and
computors are only paid at an epoch boundary, so it needs a `LONG_RUN_LOCAL_TESTNET` build with a short
`LONG_RUN_EPOCH_TICK_CAPACITY`, run until the epoch rolls. Note that build does not compile as shipped:
`revenue.h:427` asserts a fixed layout that the struct's tail padding breaks whenever
`5 * (TESTNET_EPOCH_DURATION + 3) * 2` is not 8-aligned. That is a pre-existing core-lite bug, unrelated
to cheatcodes, and worth reporting separately.

## 8. What is deliberately absent

- **Wall-clock warp.** `CHEAT_OP_WARP_TIME` is reserved. `now()` reads seven separate `etalonTick`
  fields and core-lite has no inverse of `dayIndex()`, so shifting the calendar is real date arithmetic
  rather than an offset. Tick and epoch are exact.
- **Snapshot and revert.** Numbers reserved. Neither runtime has a world-snapshot primitive, and honest
  scope is spectrum plus universe plus every contract state plus the log store, twice over.
- **Anything that belongs in a test file.** The in-contract mutators exist for mutations that must happen
  *mid-execution*. Everything you can do between invocations already works from `.test.ts` against a real
  node, and from `wasm_contract_testing.h` in gtest.
