# VS Code extension — campaign 1

First campaign against the QPI VS Code extension, run per `docs/testing-vscode-agent-prompt.md`.
Findings are numbered from **E1** so they do not collide with the CLI campaigns' F-series.

Environment: VS Code **1.137.0** (downloaded by `@vscode/test-cli`), vscode-clangd **0.6.0**, clangd
**20.1.0**, core-lite pinned at `1bffb1ff`, wasi-sdk 29.0, Linux x64 under `xvfb-run`.

Suites run and their counts:

| Suite                        | Result                                              |
| ---------------------------- | --------------------------------------------------- |
| `bun test packages/vscode`   | 88 pass / 0 fail (11 files, 10 617 assertions)      |
| `scripts/clangd-gate.ts`     | PASS — 10/10 contracts, 0 errors each               |
| `scripts/clangd-complete.ts` | PASS — all 9 probes, KNOWN-BAD canary still bad     |
| `test:int` (`ws` workspace)  | 17 passing / 0 failing, exit 0                      |
| `campaign` (`zoo` workspace) | 5 passing / 3 failing, exit 1 — the failures are E1 |

---

## E1 — in a contract, completing through a callee's nested struct returns English words from comments

**Severity: high.** It is the second tier of the prompt's ladder — the editor silently drops the
completion the developer needs — and it replaces it with visible garbage, so the developer reads it
as "this struct has no fields".

Minimal repro — two contracts in one `qinit.json` project (`packages/vscode/test-fixtures/zoo`):

```cpp
// contracts/Vault.h — the callee. `Tag` is spelled bare inside Get_input.
struct Vault : public ContractBase {
    struct Tag { Array<uint64, 4> bits; sint16 rank; };
    struct Get_input { Array<uint64, 8> history; Tag detail; };
    ...
};

// contracts/Desk.h — the caller
struct Desk : public ContractBase {
    struct Read_locals { Vault::Get_input input; Vault::Get_output output; };
    PUBLIC_FUNCTION_WITH_LOCALS(Read) {
        locals.input.history.setAll(0);
        locals.input.detail.rank = 0;      // <-- complete at `locals.input.detail.`
        ...
    }
};
```

**Expected** `bits, rank`. **Actual** 74–98 items beginning
`a, and, Array, at, below, bits, both, CALL_OTHER_CONTRACT_FUNCTION, callee, Caller, calls, campaign`
— clangd's degraded word-scrape, including words lifted out of the file's comments.

Evidence, all three readings from ground rule 2, in the same buffer at the same moment:

| Reading                                     | `locals.input.detail.`                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| editor, `qpi.completionFilter: "qpi"`       | 74 items, `rank` absent                                                 |
| editor, `qpi.completionFilter: "off"`       | 74 items, `rank` absent — **identical**, so the filter is not the cause |
| compiler fallback asked directly in-process | `UNRESOLVED (undefined)`                                                |

Controls that rule out a broken buffer, workspace or language client:

| Control                                                                | Result                                     |
| ---------------------------------------------------------------------- | ------------------------------------------ |
| `locals.input.` (one hop less, same statement)                         | 4 items — `detail, history, offset, who` ✓ |
| `locals.input.history.` (container hop)                                | 7 items ✓                                  |
| `locals.output.`, `state.get().`, `state.mut().recent.`                | ✓                                          |
| `Desk.h` under `clangd --check`                                        | 0 errors                                   |
| `Desk.h` diagnostics in the editor                                     | 0                                          |
| **the identical shape from a gtest** (`gi.detail.` in `Desk.test.cpp`) | **2 items — `bits, rank` ✓**               |

The gtest row is the finding: same receiver, same types, same workspace, same clangd — it works in a
`.cpp` and fails in the `.h`. The two documents take different resolution paths
(`src/member-fallback.ts:48-59`): a gtest goes through `rootType` (a hover scrape) and
`completeMembersOfType`, a contract goes through `completeMembersAt` on its own AST.

**Corrected: this is one defect, not two.** The first version of this entry claimed the fallback never
fires because clangd's answer is a _mixed_ list — real indexed symbols alongside scraped words. That was
inferred from labels (`Array`, `CALL_OTHER_CONTRACT_FUNCTION` look like real symbols) and is **wrong**.
Measuring `CompletionItemKind` directly settles it:

| Receiver                               | Items | Kinds         |
| -------------------------------------- | ----- | ------------- |
| `locals.input.history.` (healthy)      | 7     | `Method=7`    |
| `locals.input.` (healthy)              | 4     | `Field=4`     |
| `state.get().` (healthy)               | 2     | `Field=2`     |
| `locals.input.detail.` (degraded)      | 98    | **`Text=98`** |
| `locals.input.detail.bits.` (degraded) | 98    | **`Text=98`** |

The degraded list is entirely `Text` — those symbol-looking labels are scraped words too. So
`items.every(kind === Text)` is **true**, `unresolved` is **true**, and the fallback **does** fire. It
simply returns nothing, because of the one real defect below. `memberCompletions`
(`src/extension.ts:154`) is correct as written and needs no change.

**The one defect: the fallback cannot resolve the receiver.** Asked directly, `completeMembersAt`
returns `undefined`. Narrowed in-process to one spelling difference:

    | Receiver               | Declared as                                    | Result                       |
    | ---------------------- | ---------------------------------------------- | ---------------------------- |
    | `locals.direct.`       | `Vault::Tag direct;` in the caller's `_locals` | **2 items — `bits, rank` ✓** |
    | `locals.input.detail.` | `Tag detail;` inside the callee's `Get_input`  | **UNRESOLVED**               |

    So the callee's nested type is registered and resolvable when the _caller_ names it qualified. What
    fails is resolving the **bare `Tag`** that the callee writes inside its own struct. A same-contract
    nested struct resolves fine (`locals.detail.`, `state.mut().saved.` both → `bits, rank`), so this is
    specific to a nested type reached through a callee's field.

This shape was never covered: `test-fixtures/ws/project/contracts/Proxy.h` only hops
`locals.input.history.` (a container) and `locals.input.offset` (a scalar). The nested-struct hop is
exercised only from the gtest (`Proxy.test.cpp`, `gi.detail.rank`), which is the path that works.

Repro in-tree, kept as a live failing suite off the default gate:
`bun run --filter qpi-vscode test:campaign` (or `xvfb-run -a ./node_modules/.bin/vscode-test --label zoo`).

---

## E2 — `.exports` is read unguarded, and the getter throws for a known-but-inactive extension

**Severity: low** — reachable only if vscode-clangd is known but not active — **but the throw is real
and both call sites are unprotected.**

`vscode.extensions.getExtension(id)?.exports` looks safe and is not: when the extension is installed
but not yet activated, the `exports` **getter throws**, and optional chaining does not help because
`getExtension` returned a real object. Proof, from this campaign's own harness before I fixed it:

```
Error: Extension 'llvm-vs-code-extensions.vscode-clangd' is not known or not activated
    at Xg.getActivatedExtension (extensionHostProcess.js:542:12613)
    at BR.getExtensionExports (extensionHostProcess.js:546:13874)
    at get exports            (extensionHostProcess.js:546:29985)
    at clangdClient (test-integration/campaign-lib.js:12:53)
```

The extension does the same thing in two places, neither wrapped:

- `ensureCompletionFilter` (`src/extension.ts:236`), called from the `setInterval` retry in
  `scheduleCompletionFilter` (`:262-268`). A throw there is an uncaught exception in the extension host.
- `clangdClient` (`src/extension.ts:272`), called from `clangdSettled` inside
  `void clangdSettled().then(...)` (`:296`). A throw there is an unhandled rejection.

`extensionDependencies` makes vscode-clangd active before the QPI extension activates, which is why
this is not seen in practice; it does not hold if clangd's extension is disabled or reloaded mid-session,
and the retry timer keeps firing for 60 s after activation. Fix is one check: `if (!ext?.isActive) return`.

---

## E3 — the itest env script pins `clangd.path` into one workspace only

**Severity: low (harness).** `scripts/prepare-itest-env.ts` wrote `clangd.path` into
`test-fixtures/ws/.vscode/settings.json` and nowhere else, because the extension host does not inherit
`$PATH`. Any second workspace added to `.vscode-test.mjs` therefore comes up with no clangd, and every
clangd-dependent case in it fails for a reason the log does not state. Patched here to loop over the
configured workspaces.

---

## Checked and found correct — do not re-file

- **The completion filter's treatment of banned keywords.** `float`, `double`, `union`, `const_cast`
  and `QpiContext` are all correctly dropped from the identifier scope. `long` and `size_t` _are_
  offered, but `qpi/lp64-width-type` is a **warning**, not an error — the contract may legally write
  them — so the filter is right to keep them. Filed and withdrawn in the same pass.
- **`qpi/no-char` is about character literals** (`'x'`), not the `char` keyword; `char` appearing in a
  completion list is not a contradiction.
- **The Marketplace "Failed" lines** in a headless run (`SSL error ... net_error -101` against
  `vscode-unpkg.net`) are not proof the clangd extension is missing — it still installs via fallback.
  Check `.vscode-test/extensions/` before concluding anything from them.
- **The KNOWN-BAD canary still holds**: raw clangd returns 0 items for `locals.gi.`, so
  `src/member-fallback.ts` cannot be retired yet.

## Harness notes for the next campaign

- `defineConfig` accepts an **array** of configs, each with its own `workspaceFolder` and `label`;
  select one with `vscode-test --label <name>`. This is the clean answer to "one workspaceFolder per
  config", and better than driving `runTests` by hand.
- `npx vscode-test` fails with _could not determine executable to run_; use
  `./node_modules/.bin/vscode-test`.
- Without `xvfb-run`, Electron exits `SIGTRAP` with *Missing X server or $DISPLAY* — and a wrapper of
  the form `bash -c '...'; echo exit=$?`still printed`exit=0`, exactly the trap the prompt's closing
  section warns about. Check the inner status.
- Two of my own probes were malformed before they were right: `.exports` (E2's discovery) and a
  contract body with two statements on one line, which makes `completeMembersAt` rewrite the wrong
  statement and report `UNRESOLVED` for everything including the controls. Suspect the probe first.

---

# VS Code extension — campaign 2 (cross-contract)

Focused on cross-contract IntelliSense with deliberately hostile state and input/output shapes:
a three-contract diamond (`Teller` → `Bank` → `Ledger`) holding typedefs, two-level nested structs,
struct HashMap keys, `Array<HashMap<…>>`, `Array<Array<…>>`, `Collection`, `LinkedList`, `BitArray`,
arrays of structs, and each contract referencing the next one's types.
Fixtures: `packages/vscode/test-fixtures/xross/`.

## E4 — one bare nested type name in a callee kills the caller's entire IntelliSense, and diverges the two backends

**Severity: high.** The top tier of the prompt's ladder in both directions: the TypeScript backend
rejects a contract clang accepts, and the editor goes completely dead on a file that compiles cleanly.

### Minimal repro

```cpp
// Ledger.h — the callee
struct Ledger : public ContractBase {
    struct Stamp { uint64 at; };
    struct Entry { Stamp stamp; };        // <-- `Stamp` spelled BARE, inside Ledger's own scope
    ...
};

// Bank.h — anyone holding that type
struct Bank : public ContractBase {
    struct StateData { uint64 marker; Ledger::Entry e; };   // <-- poisons this contract
    ...
};
```

Writing `Ledger::Stamp stamp;` inside `Entry` instead makes everything below go away. That is the
whole difference.

### What breaks

| Path                                                     | Result                                                    |
| -------------------------------------------------------- | --------------------------------------------------------- |
| `clangd --check` on Bank.h                               | **0 errors**                                              |
| clang backend (`buildContractWithClang`)                 | **builds OK**                                             |
| TypeScript backend (`compileContractWithTypeScript`)     | **FAIL** — `Codegen failed: unknown type 'Stamp'`         |
| `analyzeContract` on Bank with Ledger as a callee source | **FAIL** — `Source analysis failed: unknown type 'Stamp'` |
| Editor, Teller.h (the caller)                            | **1 error + IntelliSense entirely dead**                  |

The two backends disagree on identical source. The CLI defaults to `clang`
(`packages/cli/src/ops/deploy/index.ts:127`), so a default `qinit build` is unaffected — but
`--compiler typescript` fails, and the editor uses the analyzer, so the editor fails either way.

### The editor cascade — this is why it is high and not medium

`analyzeContract` throwing makes `resolveProjectSourceDetails` throw, and from there everything
unwinds:

1. `regenerateContract` catches the throw, logs `clangd config failed` to the output channel, returns.
2. So **no prefix header, no `.clangd`, and no `compile_commands.json` are written at all** — verified:
   after a full editor run the xross workspace has no `compile_commands.json` on disk.
3. clangd therefore has no compile entry for `Teller.h`, falls back to default flags, resolves nothing,
   and answers every member request with its word-scrape.
4. `QpiDiagnostics.analysisFor` returns undefined, so there is no IDL — no hover, no QPI diagnostics —
   and the member fallback is handed `context: undefined`, so it cannot answer either.

Both the language server and the safety net are down at once. Measured on `Teller.h`:

```
Teller.h project diagnostics -> 1
  qinit-project:qinit/project-dependencies — Project dependency resolution failed:
  cannot analyze callee 'Bank': Source analysis failed: unknown type 'Stamp' …

locals.                       ->  91 items, `in`     MISSING
locals.in.                    ->  89 items, `hist`   MISSING
locals.in.hist.               ->  89 items, `setAll` MISSING
locals.in.tranche.            -> 100 items, `tier`   MISSING
locals.in.tranche.tier.       -> 100 items, `rank`   MISSING
locals.in.tranche.tier.bits.  -> 100 items, `setAll` MISSING
locals.in.key.                -> 100 items, `a`      (false ✓ — see below)
locals.in.lots.               -> 100 items, `setAll` MISSING
locals.in.grid.               -> 100 items, `setAll` MISSING
locals.in.flags.              -> 100 items, `setAll` MISSING
locals.in.stamp.              -> 100 items, `at`     MISSING
```

Even `locals.` — the shallowest possible receiver — fails, where the same receiver answers in 14 ms in
the `zoo` workspace. Nothing about the contract's own shape matters; one callee poisons all of it.

The controls settle it. `locals.direct.`, `locals.directTranche.` and `locals.directEntry.` name their
types **qualified** (`Bank::Tier`, `Bank::Tranche`, `Ledger::Entry`) — the spelling that resolves
everywhere else — and they fail too, at 100 junk items apiece. This is not the resolver picking the
wrong type; there is no compile entry and no analysis context for the file at all.

The qualified scopes go the same way: `Bank::` → 89 items without `Quote_input`, `Ledger::` → 89
without `Entry`. In the `zoo` workspace the equivalent `Vault::` answers with its structs.

### The diagnostics point at the wrong file, and one is an internal code

Nothing in the editor names the actual offending line (`Stamp stamp;` in `Ledger.h`):

| File                                | What the developer sees                                             |
| ----------------------------------- | ------------------------------------------------------------------- |
| `Ledger.h` — where the bare name is | nothing                                                             |
| `Bank.h` — the middle contract      | `qinit-compiler:compiler/internal` and `qpi:qpi/public-callee-type` |
| `Teller.h` — the caller             | `qinit-project:qinit/project-dependencies` at line 1                |

`compiler/internal` is an internal-error code surfaced straight to the user. Chasing this from the
editor alone means starting at the file furthest from the cause and never being pointed at the fix.

Suite result: `test:xross` → **2 passing / 2 failing, exit 1** (4 min).

### Blast radius

| Shape in the callee                                                  | Analyzer                               |
| -------------------------------------------------------------------- | -------------------------------------- |
| `Ledger::Stamp` referenced directly (flat)                           | clean                                  |
| `Entry { Stamp stamp; }` — bare nested **struct**                    | **FAIL**                               |
| `Boxed { Hist hist; }` — bare nested **typedef**                     | clean (typedefs are registered scoped) |
| `WithArr { Array<Stamp, 4> stamps; }` — bare name inside a container | **FAIL**                               |
| `Array<Ledger::Entry, 4>` — a poisoned struct inside a container     | **FAIL**                               |

Grouping related fields into a nested struct is ordinary contract style, so this is not an exotic shape.

### Cause

Same root-cause class as E1 — a bare type name needs its enclosing callee's scope to be re-qualified —
but a **different code path**, so E1's fix does not cover it:

- E1: `analyzer/member-query.ts`, completion only.
- E4: `backend/wasm/idl/abi-type-builder.ts:126`. `layoutOfType` is asked to resolve the bare `Stamp`
  with no record that it came from inside `Ledger::Entry`, so it never tries `Ledger::Stamp` and throws.

A complete fix needs the enclosing-scope context threaded into layout/IDL resolution for callee
structs, not just into the completion resolver.

**Workaround for contract authors today:** qualify nested type references inside a contract that other
contracts depend on (`Ledger::Stamp stamp;`, not `Stamp stamp;`).

## Probe errors worth recording

- `locals.in.key.` reported `a ✓` and it is **false**. The matcher accepted a prefix match, and `a` is a
  real word in clangd's degraded word list. Tightened to "exact, or `name(`" so a one-letter field can
  no longer be satisfied by prose. Every other row in that table is a true MISSING.
- The first fixture draft did not compile, for three reasons worth knowing: `Array<T, N>` requires N to
  be a power of two; a contract that only _references_ another's types gets no callee prelude unless it
  actually `CALL_OTHER_CONTRACT_FUNCTION`s it; and two calls in one entry body collide on
  `interContractCallError` (`qpi/duplicate-call-error-var`). All three were my error, not the tool's.

---

# Recheck against main `ecbb1b7`

Both campaigns re-run after rebasing onto main `ecbb1b7` (34 commits ahead of the campaign base,
carrying the TypeScript-compiler fix series). Core pin unchanged at `1bffb1ff`, so the same bundled
headers, clangd 20.1.0 and VS Code 1.137.0 as before.

| Finding                                                           | Status on `ecbb1b7`                      |
| ----------------------------------------------------------------- | ---------------------------------------- |
| **E1** — completion through a callee's bare nested struct         | **still open**                           |
| **E2** — unguarded `.exports`                                     | still open (not in the fix series' path) |
| **E3** — itest env pins one workspace                             | fixed in this branch                     |
| **E4** — bare nested type breaks analysis, build and IntelliSense | **fixed**                                |

## E4 is fixed

Every shape that failed now passes, in-process and end to end:

| Check                                           | Before                       | On `ecbb1b7`                 |
| ----------------------------------------------- | ---------------------------- | ---------------------------- |
| `analyzeContract`, `Ledger::Entry` in state     | FAIL `unknown type 'Stamp'`  | **clean**                    |
| `analyzeContract`, bare name inside a container | FAIL                         | **clean**                    |
| `analyzeContract`, `Array<Ledger::Entry, 4>`    | FAIL                         | **clean**                    |
| TypeScript backend                              | FAIL `Codegen failed`        | **OK, 4157 bytes**           |
| clang backend                                   | OK                           | OK — divergence gone         |
| Editor: `Teller.h` project diagnostics          | 1 (`project-dependencies`)   | **0**                        |
| Editor: `Bank.h` diagnostics                    | 2, incl. `compiler/internal` | 1 (`qpi/public-callee-type`) |
| `test:xross`                                    | 2 passing / 2 failing        | **3 passing / 1 failing**    |

Consistent with `ca1a544 fix(semantics): resolve a struct's fields in its own scope, not the caller's`,
which rewrites the `abi-type-builder.ts` site this finding named, alongside `9be0562`, `ab68e9b` and
`cc8a37d`. I did not bisect, so treat the attribution as consistent-with rather than proven.

## E1 is not fixed, and the matrix now says exactly why

`packages/compiler/src/analyzer/member-query.ts` was **untouched** by all 34 commits, and `scopeOf`
is still called in exactly one place (`:388`, the gtest path).

The compiler-side defect is unchanged and deterministic: asked directly, `completeMembersAt` still
returns `UNRESOLVED` for `locals.input.detail.` while the qualified control `locals.direct.` returns
`bits, rank`.

The **editor** symptom is now inconsistent, which is new and worth stating plainly. In the same
session, on the same receiver: the nested-struct-hop suite saw 48 items that did contain `rank` and
`bits` (so its assertion passed), while the completion-surface suite saw 98 items without them. So
clangd now sometimes answers that position with a list wide enough to include the names by accident.
That is not the member list being resolved — 48 items for a two-field struct is still a flood — but it
does mean a pass/fail on label presence alone is no longer stable here. The zoo suite went from
5 passing / 3 failing to 6 passing / 2 failing on that basis alone.

With E4 out of the way the cross-contract matrix is clean enough to state the rule precisely:
**a hop resolves when the type is spelled qualified, and dies on the next hop through a field whose
type its owning contract spelled bare.**

| Receiver                               | Type as written                                        | Items       |
| -------------------------------------- | ------------------------------------------------------ | ----------- |
| `locals.in.`                           | `Bank::Quote_input`                                    | 9 ✓         |
| `locals.in.hist.`                      | `Hist` typedef → `Array`                               | 7 ✓         |
| `locals.in.lots.` / `grid.` / `flags.` | `Array<Lot,4>`, `Array<Array<…>>`, `BitArray`          | 7 / 7 / 5 ✓ |
| `locals.in.stamp.`                     | `Ledger::Stamp` — another callee's type, **qualified** | 2 ✓         |
| `locals.direct.`                       | `Bank::Tier` **qualified** in the caller               | 2 ✓         |
| `locals.directTranche.`                | `Bank::Tranche` **qualified** in the caller            | 3 ✓         |
| `locals.directTranche.tier.`           | `Tier` **bare**, inside `Tranche`                      | **89 ✗**    |
| `locals.in.tranche.`                   | `Tranche` **bare**, inside `Quote_input`               | **89 ✗**    |
| `locals.in.key.`                       | `Key` **bare**                                         | **89 ✗**    |
| `locals.out.lot.`                      | `Lot` **bare**, inside `Quote_output`                  | **89 ✗**    |

`locals.directTranche.` at 3 items and `locals.directTranche.tier.` at 89 is the whole bug in one
pair: the same object, one hop deeper, and the scope was not carried into its members.

Containers, arrays of structs, nested containers, `BitArray` and cross-contract qualified types all
work. Only the bare nested struct fails.

The one-line fix still applies verbatim on `ecbb1b7` and still works — `locals.input.detail.` →
`bits, rank` — with `bun test packages/vscode` 88/88 and the compiler analyzer tests 11/11 green:

```ts
// analyzer/member-query.ts, targetOfType
return structDeclaration ? structTarget(programAnalysis, structDeclaration, bindings, scopeOf(resolved) ?? scope) : undefined;
```

## Open, not yet explained

`Bank::` returns 89 items without `Quote_input` while `Ledger::` returns 11 with `Entry` ✓, in the same
buffer at the same moment. Both qualifiers are in the document and neither is a blocked namespace, so
the filter keeps both; the difference is in what clangd answered. Not chased this round.

## Method corrections from this round

- **Count is the signal, not presence.** clangd's degraded word-scrape includes identifiers taken from
  the file itself, so a member name already written in the source can be "found" in it. Two rows read
  ✓ that way (`locals.in.tranche.tier.bits.` at 90 items, and `locals.in.key.`'s `a` in the earlier
  run). A correct member list here is 2–9 items; a scrape is 89–150. Judge the count first.
- **Three probe rows were invalid**: `state.get().calls`, `state.get().mirror.rank` and
  `locals.out.lot.tier` are markers my fixture never writes. The helper reported them as "marker
  absent" rather than passing them, which is the behaviour to keep.
- **The `gtest gi.detail.` row read as a regression and is not one.** It returned 100 core symbols in
  the editor, but the gtest resolution path answers correctly in-process
  (`Vault::Get_input` + `[detail]` → `bits, rank`). The editor row is an artifact of running against a
  freshly cleaned workspace whose gtest compile entry had not been regenerated yet.
- **Two self-inflicted invalidations, both covered by rules already in the prompt.** The first recheck
  ran `./node_modules/.bin/vscode-test --label …` directly, which skips `bun esbuild.mjs`, so the
  editor exercised a bundle built before the rebase; and the fixture workspaces still held
  `compile_commands.json` and `.clangd` from the previous campaign, so clangd had a stale-but-valid
  entry. Go through the package scripts, and clean generated artifacts between campaigns.

---

# Fixes applied, and one new finding

## E1 — fixed

One line in `packages/compiler/src/analyzer/member-query.ts`, in `targetOfType`:

```ts
return structDeclaration ? structTarget(programAnalysis, structDeclaration, bindings, scopeOf(resolved) ?? scope) : undefined;
```

`scopeOf` already existed in that file and was called in exactly one place (`:388`, the gtest path).
A qualified type now carries the scope its own members' bare type names resolve in.

Verified end to end, workspaces cleaned and the bundle rebuilt:

|                                                  | Before                                  | After                                                                  |
| ------------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------------- |
| `locals.input.detail.` (editor, filter on)       | 74–98 items, `rank` absent              | **2 items — `bits, rank`**, 14 ms                                      |
| the same receiver with `completionFilter: "off"` | 74 items                                | 74 items — unchanged, so the **fallback** is what fixes it, not clangd |
| `test:campaign` (zoo)                            | 6 passing / 2 failing                   | **9 passing / 0 failing, exit 0**                                      |
| `test:xross` receiver matrix                     | 89-item floods on every bare nested hop | **2–7 items each, all ✓**                                              |
| `bun test packages/vscode` + analyzer            | 88 / 11                                 | **99 pass / 0 fail**                                                   |

## E2 — fixed

`clangdClient()` now checks `isActive` before touching `.exports`, and `ensureCompletionFilter` calls it
instead of repeating the unguarded access, so there is one guarded path rather than two unguarded ones.

## Retracted: E1 did not have a second defect

The original entry claimed `memberCompletions`' `unresolved` heuristic also needed changing because
clangd returns a _mixed_ list. Measuring `CompletionItemKind` showed the degraded list is `Text=98` —
entirely Text. The heuristic was already correct, the fallback was already firing, and the resolver was
the only defect. The kind histogram is kept as `test-integration/campaign/kinds-probe.itest.js`: if
clangd ever starts returning a mixed degraded list, that heuristic really would break, and the probe
would show it.

## E5 — a transitive callee is silently dropped from the caller's prelude

**Severity: high.** This is what the unexplained `Bank::` vs `Ledger::` asymmetry turned out to be. It is
_not_ a warm-up artifact: with the queries run in both orders, `Bank::` fails in both and `Ledger::`
succeeds in both.

In the diamond `Teller → Bank → Ledger`, where Bank's own structs reference `Ledger::Stamp`:

```
parseRegisters(Bank) THREW: Source analysis failed: unknown type 'Ledger::Stamp'
```

`buildCalleePrelude` (`packages/build/src/contracts/intercontract.ts:203`) calls `parseRegisters` on
Bank **in isolation** — with Bank's name, slot and the QPI header, but without Bank's own callee
sources — so a perfectly qualified `Ledger::Stamp` is unresolvable. The throw is then swallowed by the
bare `catch {}` at `:231`, which drops the sibling "with its subtree" by design, and Bank never reaches
the prelude:

```
dynCallees order: ["Ledger","Bank"]   slots: Ledger=29, Bank=30 | Teller=31
Ledger  struct decl … header mention at 6812
Bank    struct decl … header mention at -1      <-- absent entirely
```

Consequences on `Teller.h`, which is valid QPI:

- `clangd --check` reports **8 errors**, all `use of undeclared identifier 'Bank'`, so every `Bank::`
  line carries a red squiggle.
- `Bank::` completion returns an 89-item word-scrape without `Quote_input`; `Ledger::` returns 11 with
  `Entry` ✓.
- Nothing explains why. The `catch {}` discards the reason, and no diagnostic names Bank or Ledger.

Member completion still works, because the extension's fallback builds its own analysis context from
`calleeSources` rather than from the prelude — which is exactly why this hid behind E1 until now.

Not fixed here: the honest fix is to resolve a callee's own callees before parsing its registrations,
which is a change in `packages/build` with a real design question (what a prelude should do when a
callee genuinely cannot be analysed). Swallowing the error is the current answer and it is the wrong
one; at minimum the reason should surface as a diagnostic instead of vanishing.

Repro: `bun run --filter qpi-vscode test:xross` — the case
"the caller compiles: a transitive callee is not dropped from the prelude".

---

# Round 3 — the compiler as the oracle

Rounds 1 and 2 asked what the editor _offers_. This round asks what it _says_, against the only
authority that matters: the build. The instrument is `packages/vscode/scripts/diag-differential.ts`
(`bun run --filter qpi-vscode diag:diff`), 52 probes, each compiled three ways — `analyzeContract`,
which is the call behind every `qpi`/`qinit-compiler` squiggle; the TypeScript backend; and clang.

Three oracles, because one does not cover the surface. Policy rules (`qpi/*`) fire as **warnings** and
clang compiles them happily, so clang cannot judge them and each probe names the code it must produce.
clang is the oracle for everything semantic. Controls must build _and_ stay silent, so a diagnostic on
one is a false positive. Every refusal row carries an accepted control beside it, so a rule that simply
refuses more is visible as such.

Two corrections to my own instrument are recorded below rather than quietly fixed: both made the
extension look better than it was.

## E6 — `qpi/no-qpicontext` bans the one context type nobody writes (fixed)

Core spells the privileged host context as **ten** distinct types. `KEYWORD_RULES` is an exact-match
table keyed on `QpiContext`, which is the _rarest_ of them:

| spelling                         | occurrences in core | banned before |
| -------------------------------- | ------------------- | ------------- |
| `QpiContextFunctionCall`         | 95                  | no            |
| `QpiContextProcedureCall`        | 69                  | no            |
| `QpiContextProposalFunctionCall` | 20                  | no            |
| `QpiContext`                     | 16                  | **yes**       |
| …six more                        | 31                  | no            |

In a `_locals` struct, where `qpi/stack-local` does not apply to absorb it, the miss is total:

```
QpiContext* ctx;                -> qpi/no-qpicontext
QpiContextFunctionCall* ctx;    -> (silent)
QpiContextProcedureCall* ctx;   -> (silent)
```

Fixed in `packages/compiler/src/analyzer/source-policy.ts` by banning the family by prefix, but only
where the name is used as a _type_ — followed by `*`, `&`, `::` or a declarator. The first attempt
matched the prefix alone and flagged `uint64 QpiContextual;`, a false positive that is recorded here
because the tightened form is what shipped. Now 30/30 (ten types × type/pointer/reference spellings)
are caught and both controls stay clean. Comments and string literals never reach the token pass.

## E7 — the editor stops before the compiler does (not fixed)

`analyzeContract` runs the frontend and `prepareContractModule`, and stops. It never lowers a function
body. **Seven** error sites live in that unreached phase — three under `backend/wasm/expressions`, four
under `backend/wasm/calls` — and every diagnostic they raise is invisible to the editor. Four
confirmed, same source, three readings:

| probe                                               | clang   | TypeScript backend | editor     |
| --------------------------------------------------- | ------- | ------------------ | ---------- |
| a member function hiding a file-scope enum constant | refuses | error              | **silent** |
| `BitArray + 1` (no viable operator)                 | refuses | silent             | **silent** |
| an aggregate assigned to a scalar                   | refuses | error              | **silent** |
| a default-constructed `AssetOwnershipIterator`      | refuses | error              | **silent** |

The first is already tracked as refused by `clang-refusal-diff.test.ts`; that suite asserts the
_backend_ catches it, and it does. The editor does not, which is the finding: a green editor for a file
neither backend will build — the top of the severity order in the campaign prompt.

Not fixed, because the two available fixes are both design calls, not patches. Running the full compile
in the editor costs **215 ms against 65 ms** for `analyzeContract` on `StateZoo.h` — 3.3× on every
debounced settle, plus emitting wasm that is thrown away. Moving the seven checks into semantic
analysis, where they are arguably semantic facts rather than codegen facts, is the better answer and is
a compiler change with its own review. Pinned as four `GAP` rows in the differential.

The last row is the sharpest illustration: main's `7539bda` added a frontend rejection for exactly that
declaration, and the editor still shows nothing, because the diagnostic that actually fires for this
shape is raised while lowering the `begin()` call.

A second, smaller defect sits underneath it: diagnostics raised during lowering carry **no `code`** at
all, only a message. `QpiDiagnostics` sets `diagnostic.code = item.code`, so even if these reached the
editor they would arrive uncoded and unkeyable for a quick fix.

## E8 — every mistyped type squiggles line 1 and blames the compiler (fixed)

The most common error a developer makes is a typo in a type name. Every one of them lands in
`internalDiagnostic`, the catch-all in `analyzer/index.ts`, which hardcoded
`span: { line: 1, column: 1 }`:

```
uint64   -> (silent)
uint46   -> compiler/internal[error]    "Source analysis failed: unknown type 'uint46'"
Uint64   -> compiler/internal[error]
unit64   -> compiler/internal[error]
```

A typo on line 44 of a 48-line file drew its red squiggle on **line 1**.

Fixed in two places. `abi-type-builder.ts` now attaches the offending type's own span to the error it
throws — `TypeSpec` has always carried one; it was simply discarded. `analyzer/index.ts` hoists
`preprocessed` out of the `try` so the catch-all can map that span back into user coordinates, which
matters because a span raised behind the generated prelude is in preprocessed lines: the first version
of this fix reported **line 55 of a 48-line file**. Both files now report the exact typo line, verified
at two file lengths, and an error carrying no span still lands at the top of the file as before.

The _code_ is left alone deliberately. `compiler/internal` reads as "the compiler broke" where this is
ordinary user error, but it is the shared catch-all for genuine internal faults too, and
re-classifying it is a compiler decision rather than a testing-round one.

## A note on `qpi/public-complex-type`

The rule inspects a registered entry struct's own members, so a forbidden container nested one struct
deep does not reach it. The developer is not left in the dark — the semantic pass reports
_"Collection is forbidden in registered entry 'Take_input'"_ on the right line, which is the same
sentence the dedicated rule would have written — but it arrives as `compiler/semantic`. The cost is
consistency and quick-fix keying, not a missing diagnostic, so it is recorded rather than fixed.

## What held up

Worth recording, because a campaign that only lists failures overstates itself.

- **The editing session.** A new `live` workspace and suite (`bun run --filter qpi-vscode test:live`,
  7 passing) mutate an open buffer the way a developer does. De-classifying by deleting
  `: public ContractBase` clears every stale squiggle in 400 ms; renaming the contract type strands
  nothing; typing the file from empty in eight steps produces only honest `compiler/syntax` at the
  half-typed marks and settles clean; commenting out a registration reports `qpi/unregistered` from the
  **unsaved buffer** in 401 ms; a 25 000-character paste and undo both settle clean; and five
  completion requests fired during `clangd.restart` returned 69, 2, 2, 2, 2 items without a throw,
  recovering afterwards. This is the family the prompt called "the part that finds things", and it
  found nothing — the extension handles it.
- **The container zoo against clang.** Ten container probes — `Array<HashMap<…>>`, `Array<Array<…>>`,
  a struct `HashMap` key with padding holes, `HashMap<id, Array<…>>`, `Collection`, `HashSet`,
  `BitArray`, three-level nesting, and a state holding all of them — build clean and draw no
  diagnostic. No false positives anywhere in the corpus: **0 SPURIOUS across 52 probes**.
- **The banned surface.** Every other policy rule fires on a crafted violation and stays silent on its
  control, including the div/mod pairs where the qualified spelling must survive.
- **A workspace root the developer already occupies.** The extension rewrites `compile_commands.json`,
  `.clangd` and `.vscode/settings.json` in the developer's own root, so every way that root can already
  be taken is a way to destroy their setup. Eight conditions were tried and none misbehaved: a
  hand-written `.clangd` is never rewritten; someone else's database at the root pushes ours into
  `.qpi/clangd/` and `.clangd` is rewritten to name it; with **both** occupied nothing of theirs is
  touched and the result reports `clangdConfigured: false`, which the caller turns into a toast naming
  the file and the directory to point at; a database that cannot be parsed — malformed JSON, or a JSON
  object where an array belongs — is treated as someone else's rather than overwritten in place; and an
  ownership marker left behind by a different checkout does not license a clobber either. Nothing threw.
  These paths had no coverage, so they are now pinned in `clangd-config.test.ts`.

## Two corrections to the instrument

Both are the campaign's own ground rule 7 — suspect the probe first — and both initially read as
extension bugs.

1. **Five "clang refuses a valid contract" rows were my template.** It emitted `types:` _after_
   `StateData`, so a struct used by state was declared below it; clang's real error was
   `use of undeclared identifier 'Cell'`, not anything about containers. Two more were bad C++ of mine
   (`get()` returns a const reference, and `m256i` has no `_0` member on this core). Fixed; all 14
   container/deep/scalar probes then agreed.
2. **The harness reported a real error as silence.** Lowering-phase diagnostics carry no `code`, and
   the harness mapped `d.code` and joined — so `[undefined]` rendered as `(silent)`. E7 was found
   because the raw diagnostic list disagreed with the summary line. The harness now labels an uncoded
   diagnostic by its message. Separately, the harness did not call `initK12()`, which the backend needs;
   without it `compileContractWithTypeScript` returns no diagnostics rather than failing loudly, which
   reads as "everything agrees".

Neither changed a verdict in the end, but both would have.

---

# Round 4 — the quick fix has to compile

Round 3 asked whether the editor's diagnostics match the build. This round asks the same of its
_remedies_. A quick fix is the one place the extension writes the developer's code for them: they
accept it on the extension's authority, so a fix that produces source the compiler rejects is worse
than no fix at all — the file is now broken in a way they did not type and did not choose.

The instrument is `packages/vscode/scripts/fix-differential.ts`
(`bun run --filter qpi-vscode fix:diff`). It applies every fix the analyzer offers and asks three
questions of the result: is the diagnostic the fix was attached to gone, did any new diagnostic
appear, and — the only one that really matters — does clang accept the fixed source. A fix is correct
only when all three hold, and a source clang already refused is scored separately, because there the
fix cannot be blamed for a build that was broken anyway.

Two of the three fix producers were handing out source that does not compile.

## E9 — `Convert to Array<T, N>` breaks a file that built (fixed)

`Array<T, N>` carries a `static_assert` that N is a power of two. `arrayFixForLine` copied the C array
size through verbatim:

| written by the developer | offered by the fix        | clang                       |
| ------------------------ | ------------------------- | --------------------------- |
| `uint64 slots[8];`       | `Array<uint64, 8> slots;` | builds                      |
| `uint64 slots[6];`       | `Array<uint64, 6> slots;` | **static assertion failed** |
| `uint64 slots[3];`       | `Array<uint64, 3> slots;` | **static assertion failed** |

The original `uint64 slots[6];` **compiles** — a C array is a QPI policy violation, not a clang error —
so this is the worst shape a fix can have: the developer's file built, they accepted the lightbulb, and
it stopped building. Fixed by declining when the size is a literal that is not a power of two. A size
that is not a literal (`uint64 owners[CAP];`) may well be legal and is still offered.

## E10 — `Convert to QPI::div(a, b)` breaks on the commonest divisor there is (fixed)

`div` is `template <typename T> inline static constexpr T div(T a, T b)` — one type parameter for both
operands. A bare integer literal beside a typed operand therefore gives two candidate deductions for T
and the call does not resolve:

```
locals.a = locals.a / 2;   ->   locals.a = QPI::div(locals.a, 2);
                                error: no matching function for call to 'div'
```

`x / 2` and `x % 10` are the ordinary way anyone writes division, so this was the common path, not the
corner. The repository's own `codefix.test.ts` asserted the broken rewrite
(`QPI::mod(total, 10)`) — the assertion was changed, with the compiler's refusal recorded beside it.

No literal spelling fixes it either. Measured against clang, `10ULL` builds for a `uint64` dividend and
is refused for `sint64` and `uint32`, and this rule runs on tokens with no types to hand. So the fix
declines when either operand is a bare literal, leaving the developer the warning and its message
rather than a file that no longer builds. A mixed-type pair of _variables_ (`uint64 / uint32`) has the
same problem and is beyond what a token-level rule can see; it is left as a known limit.

## E11 — a resolution failure outside the main contract is silent (not fixed)

`resolveProjectSourceDetails` roots the dependency plan at `config.contract` and, for any file not in
the resulting plan, falls back to `standaloneDetails` — no callees at all
(`packages/vscode/src/project-context.ts:222-226`). Siblings are not second-class in general; the
asymmetry is narrower and only appears when something fails:

| the file being edited           | its callee | resolution                      | the developer sees                              |
| ------------------------------- | ---------- | ------------------------------- | ----------------------------------------------- |
| the contract `qinit.json` names | exists     | `calleeSources=1`               | nothing, correctly                              |
| a sibling contract              | exists     | `calleeSources=2`               | nothing, correctly                              |
| the contract `qinit.json` names | **absent** | **throws**                      | `qinit/project-dependencies`, naming the callee |
| a sibling contract              | **absent** | **`calleeSources=0`, no throw** | **only clang's "use of undeclared identifier"** |

The bare `catch {}` at `packages/build/src/contracts/project-dependencies.ts:281` rolls the sibling and
its subtree out of the plan and discards the reason. The file then looks standalone, which is
indistinguishable from a header that genuinely belongs to no project, so nothing is reported.

The developer action that hits this is completely ordinary: add a second contract, reference a callee,
create that callee's file next. Until the file exists they get five raw clang errors and nothing that
names the cause.

Not fixed, and deliberately so — this is E5's design question at a second site (what a plan should do
when a contract in it cannot be analysed), and the honest answer is a `packages/build` change with its
own review rather than a patch invented in a testing round. Pinned as a failing case in `test:live`:
"a callee referenced before its file exists is reported, then clears when it appears".

## What held up

- **The stack-local fix is exemplary.** `uint64 scratch = 3;` becomes
  `struct Go_locals { uint64 scratch; };` with `locals.scratch = 3;` in the body and every reference
  rewritten. The initializer a struct member cannot carry is preserved as an assignment rather than
  dropped — the failure mode that a "does it build" check alone would never have caught.
- **Every remaining fix.** After E9 and E10, all 12 fixes the corpus provokes clear their own
  diagnostic, introduce nothing new, and produce source clang accepts.
- **The rest of the project shapes.** No `qinit.json`, malformed JSON, a JSON array where an object
  belongs, and a header that is not a contract all resolve to sensible standalone details without
  throwing. A slot outside the dynamic window is refused with a message that names the window.

One cosmetic note: `qpi/no-brackets` fires once for `[` and once for `]`, so the same
`Convert to Array<T, N>` appears twice in the lightbulb for one declaration. Two legitimate
diagnostics, each offering the same remedy — recorded, not worth a change.

---

# Round 5 — the hover a developer builds a call from

`idl-hover.ts` is fifty lines and had never been campaigned. It is also the one place the extension
states a **number the developer copies into a transaction**: the registration index. A completion that
is missing costs a developer a few seconds; an index that is wrong costs them a call to the wrong entry.

The provider resolves the word under the cursor against `analysisFor(doc).idl` — the IDL of the file
being edited — by bare-name match, with no check that the word is being _used_ as an entry of this
contract. Three consequences, found by hovering the same four positions in a two-contract workspace
(`test:live`, suite "live — the IDL hover").

One hypothesis was disproved before it cost anything: the hover prints `entry.inputType` under the
label "index", which looked like it might be a type id rather than the registration index. Traced to
`registrations.ts:87` — `inputType` is the second argument of `REGISTER_USER_FUNCTION`, so the label is
correct. The line-number fallback beside it applies only to oracle-reply notifications, where `__LINE__`
genuinely is the synthetic id.

## E12 — a procedure's output was hidden (fixed)

`hoverFor` printed the output line only when `kind === "function"`. A QPI procedure carries an output
struct exactly as a function does, so half the payload was missing:

```
before   Bump · index 2   input  : (empty)
after    Bump · index 2   input  : (empty)
                          output : uint64
```

One line. The existing suites only ever asserted function hovers, which is why it survived.

## E13 — a callee's entry borrowed this contract's index (fixed)

The headline. `Meter` calls `Feed`:

```cpp
CALL_OTHER_CONTRACT_FUNCTION(Feed, Read, locals.in, locals.out);
```

`Read` here is **Feed's** function, registered at index 1. If Meter also registers an entry called
`Read` — an ordinary name collision, `Read` being about as common as an entry name gets — hovering the
call site answered from Meter's IDL:

| hovered                                                 | truth                        | shown before           |
| ------------------------------------------------------- | ---------------------------- | ---------------------- |
| `Read` in `PUBLIC_PROCEDURE(Read)`                      | Meter's procedure, index 3   | procedure, index 3 ✓   |
| `Read` in `CALL_OTHER_CONTRACT_FUNCTION(Feed, Read, …)` | **Feed's function, index 1** | **procedure, index 3** |

Both the kind and the index were wrong, for the call the developer was looking at.

Fixed by declining when the word is the entry argument of a cross-contract call —
`CALL_OTHER_CONTRACT_FUNCTION`, `INVOKE_OTHER_CONTRACT_PROCEDURE` and their `_E` variants. Answering
_correctly_ would mean resolving against the callee's own IDL, which this provider does not hold
(`analysisFor` returns only the edited file's), so silence is the honest answer rather than a
confident wrong one.

## E14 — the bare-name match reaches things that are not references (partly fixed)

The same match fired on any word spelling an entry name. Two shapes:

- **In prose or a string literal** — a comment reading "Poll is mentioned here" hovered as the QPI
  function `Poll`. **Fixed**: the hovered offset must correspond to an `IDENTIFIER` token, using the
  analyzer's own `Lexer`. A buffer too broken to tokenize keeps its hovers rather than losing them
  silently.
- **A struct field sharing the name** — `uint64 Bump;` still hovers as the procedure `Bump`. The field
  _is_ a real identifier token, so the token pass cannot see the difference; telling a declarator from a
  reference needs parse context the provider does not have. Left unfixed and pinned: the payload shown
  is correct, merely about something else, which puts it at the bottom of the severity order rather
  than in the same class as E13.

## What held up

- **The index and payload for this contract's own entries.** `Poll` reads
  `QPI function · index 1 · input uint64 · output uint64` and `Bump` reads `QPI procedure · index 2`,
  both matching their `REGISTER_USER_*` lines.
- **Invalidation.** The `ws` suite already covers re-hovering after an edit changes an index, and after
  `: public ContractBase` is deleted; both still hold.

---

# Round 6 — several contracts open at once

The campaign prompt's own ground rule 5 says one file open is not the state a developer is in, and
until now every round has campaigned one file at a time. The reason to care is visible in the source:
`contractAnalysisContexts` is a `Map` keyed per document, so diagnostics analyse each contract under its
own identity — but `contractPrefixPath` and `contractCorePath` are **single module globals**
(`extension.ts:20-21`), set by whichever contract was last regenerated, and `filterCompletions` walks
the allowed-identifier set from that one global (`extension.ts:190-191`). Switching editor tabs fires no
open event, so the global stays pointed at the file you left while you complete in the file you
returned to.

**Nothing leaked.** Measured in `test:live`, suite "live — several contracts open at once":

| probe                                     | Meter's prefix live         | Feed's prefix live          | difference                       |
| ----------------------------------------- | --------------------------- | --------------------------- | -------------------------------- |
| member list at `locals.scratch.` in Meter | 2 items — `flags, tick`     | 2 items — `flags, tick`     | none                             |
| identifier list at type position in Meter | 41 names (3/3 warm samples) | 41 names (3/3 warm samples) | **nothing lost, nothing gained** |
| Meter's own names offered in Feed         | —                           | —                           | none                             |
| warm completion, two contracts open       | —                           | —                           | 14–16 ms against a 500 ms budget |

Two mitigations are doing that work, and both are worth naming because the global on its own would not
be enough: every contract's prefix walks the same QPI surface, so the sets are near-identical to begin
with, and `documentIdentifiers(doc.getText())` keeps whatever the current buffer itself mentions
regardless of which prefix is live. The global is still a smell — a per-document map beside two globals
that must agree with it — but on this workspace it does not produce a wrong answer.

## Getting the instrument to the point where that claim means anything

The first three runs all "found" something, and all three were the harness. They are recorded because a
negative result is only worth as much as the probe's ability to have seen a positive one.

1. **A `settle` that accepted the answer it was waiting for.** The member probe waited for the list to
   contain `tick`. clangd's degraded reply is a word-scrape of the whole buffer, which contains `tick`
   — so the wait was satisfied by the scrape, and the run compared 48 scraped words against 2 real
   members and called it a leak. Waiting on a name cannot distinguish a resolved list from a scrape.
2. **A kind check that did not separate them either.** The obvious repair — reject a list that is
   wholly `Text`-kind, as round 3's canary measured — did not hold here: at this position clangd
   returned the scrape with real kinds attached. What does separate them is content: a member list is
   the receiver's fields, and never contains `struct`, `namespace`, `using`, `public` or `class`.
   That is now the discriminator.
3. **A one-item probe, and then a noisy one.** The identifier tier was first measured at a position
   offering a single item, which cannot show a difference at all; moving to a position offering forty
   exposed the opposite problem, that clangd volunteers the odd C library symbol between a cold and a
   warm index (`arc4random_buf` gained on one run, a QPI name lost on the next). Sampling three times
   and intersecting — after settling each sample to a warm one, because a request made straight after a
   tab switch comes back nearly empty — gives 41 names reproducibly in both states.

The assertion was also narrowed deliberately, and the narrowing is the point rather than a way to make
a red test green: the hazard is a name the contract needs going missing, or a sibling's name appearing.
clangd's own volunteered symbols are neither, so they are printed on every run and left out of the
assertion.
