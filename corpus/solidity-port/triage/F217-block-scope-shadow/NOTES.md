# F217 — a block-scope local shadowing an outer name is refused

Severity: **medium** (loud refusal of legal C++; a contract that builds with the default backend fails
to build with `--compiler typescript`). Same class as F209, F214 and F215.

## Repro

```sh
export QINIT_CORE=… WASM_CLANG=…/bin/clang++ WASI_SYSROOT=…/share/wasi-sysroot
d=corpus/solidity-port/triage/F217-block-scope-shadow
bun run scripts/solidity-port/triage.ts $d/BlockShadow.h $d/script.json
```

```
clang      : ACCEPTED
typescript : REJECTED
  error: 'tier' is used before its declaration (or outside the scope that declares it)
  error: 'tier' shadows a declaration in an enclosing scope — locals share one slot per name,
         so shadowing is not supported
```

## What the contract does

```cpp
static constexpr uint64 tier = 1;

locals.atOne = tier;            // no local `tier` is in scope yet -> the file constant
{
    uint64 tier = 20;
    locals.atTwo = tier;        // the block's own binding
    {
        uint64 tier = 300;
        locals.atThree = tier;  // the innermost binding
    }
}
locals.afterBlocks = tier;      // control: the file constant again
```

## Oracle

clang compiles it and returns **1, 20, 300, 1**, and core's own WAMR host reproduces that state
byte-for-byte:

```
clang  simulator 0100000000000000 1400000000000000 2c01000000000000 0100000000000000 0100000000000000
       WAMR      0100000000000000 1400000000000000 2c01000000000000 0100000000000000 0100000000000000
                 outer=1          depthOne=20      depthTwo=300     afterAll=1       calls=1
```

That is the C++ rule exactly, so the program is well-formed and the TypeScript backend's refusal is
the divergence.

## The two diagnostics are not equally interesting

The **second** names the cause and is a fair statement of a design limit: the backend's locals model is
flat — one slot per name per entry — so a block cannot introduce its own binding. A developer reading
it knows to rename.

The **first** is the one worth looking at. `locals.atOne = tier;` is read *before* any block declares a
local `tier`, so in C++ it unambiguously names the file-scope constant; there is nothing
use-before-declaration about it. Reporting it as one means the block-local declaration is being
hoisted over the whole entry body — the name is bound for the entire function rather than from its
declaration to the end of its block. That hoisting is precisely what C99 block scoping exists to
prevent, and it is the same mechanism the Solidity test this was ported from
(`scoping/c99_scoping_activation.sol`) was written to pin down.

So the refusal is not only "shadowing is unsupported"; the analyzer's scope model appears to place the
inner declaration in the outer scope, which is what makes the earlier, legal read look invalid.

## Corpus rows

`namespaces/NsBlockScopeShadowChain__*` — 12 variants, pinned through `expectedVerdict:
"one-side-rejected"`, so they pass by diverging exactly as documented and fail the moment they stop.

## How it was found

Lane 4 of round 6, which probes *which* declaration wins rather than whether one resolves. It was very
nearly mis-filed: `corpus:analyze` reported the rejection, and the diagnostic's wording ("the build
gate refuses…") led to an initial assumption that the gate was shared and both backends rejected. The
sweep said `one-side-rejected`, not `both-rejected`, which is what forced the recheck. Building the
same file through `buildContractWithClang` and `buildContractWithTypeScript` side by side settled it:
the rule runs only on the TypeScript path.

A note for the next round: checking a rejection with the *raw* driver
(`compileContractWithTypeScript`) reports ACCEPTED here, because the raw driver skips the build gate.
Only the `@qinit/build` wrappers — which is what the sweep uses — show the refusal.
