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

The contract sends only `(line << 8 | ordinal, bytes)`. The reader joins the two back together. A value
with no literal in front is labelled with `expr` — the argument's own source text, captured at compile
time, which is more accurate than a hand-written label and costs nothing at runtime.

`"a" + value` is not supported and never will be: it fails to lower in one backend and is pointer
arithmetic in the other. Use the comma form.

## 4. Both backends

| | TypeScript backend | clang backend |
|---|---|---|
| Shim | `driver/qpi/cheats.ts`, injected in `contract-frontend.ts` | `assets/qinit_cheats.h`, injected in `generateWasmWrapperSource` |
| `CC_PRINT` | `__qinit_cheat_print` intrinsic in `host-intrinsic-call.ts` | parameter pack with an `if constexpr` literal test |
| `__LINE__` base | derived from the real prelude, never pinned | 0 — the contract is `#include`d |

The two shim texts differ; `cheat-parity.test.ts` is what holds them to the same `(id, part, bytes)` on
the wire. It is the test that caught the base being off by one, so do not delete it.

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
| `cheat/too-many-per-line` | Keeps the id readable |

`qpi/no-string` and `qpi/no-char` are suppressed inside a cheat argument, since those literals are
interned rather than lowered. Aliasing needs no rule: `qpi/no-preprocessor` already forbids `#define` in
contract source.

## 7. What has actually been exercised

The claim that cheatcodes behave the same everywhere is only tested for half the matrix. Be precise
about which half before relying on it.

| | simulator | core node |
|---|---|---|
| TypeScript backend | executed end to end | **not executed** |
| clang backend | executed end to end | **not executed** |

`cheat-parity.test.ts` runs *both* backends' wasm through the engine and asserts identical
`(id, part, bytes)`, so the simulator column is genuinely covered.

For the core node, what is verified is that a node built from the cheat branch compiles, links,
registers `cheat` among its lhost native symbols, carries `cheats` in the debug-trace serializer, and
ticks. What has **not** happened is a cheat call executing under WAMR: deploying to a local node needs a
funded identity, and a node started without a spectrum snapshot funds nobody. The self-funding
`LONG_RUN_LOCAL_TESTNET` build does not compile on this tree — `revenue.h:427` asserts a fixed layout
that the struct's tail padding breaks whenever `5 * (TESTNET_EPOCH_DURATION + 3) * 2` is not 8-aligned,
which is a pre-existing core-lite bug unrelated to cheatcodes.

So the remaining step, for anyone with a funded node: deploy a cheat-carrying contract with
`--runtime core`, call it, and check `/live/v1/debug-trace` carries the `cheats` array.

## 8. What is deliberately absent

- **Wall-clock warp.** `CHEAT_OP_WARP_TIME` is reserved. `now()` reads seven separate `etalonTick`
  fields and core-lite has no inverse of `dayIndex()`, so shifting the calendar is real date arithmetic
  rather than an offset. Tick and epoch are exact.
- **Snapshot and revert.** Numbers reserved. Neither runtime has a world-snapshot primitive, and honest
  scope is spectrum plus universe plus every contract state plus the log store, twice over.
- **Anything that belongs in a test file.** The in-contract mutators exist for mutations that must happen
  *mid-execution*. Everything you can do between invocations already works from `.test.ts` against a real
  node, and from `wasm_contract_testing.h` in gtest.
