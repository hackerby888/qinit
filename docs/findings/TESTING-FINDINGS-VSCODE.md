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

**Two independent defects stack here, and both need fixing:**

1. **The fallback never fires.** `memberCompletions` (`src/extension.ts:154`) only retries through the
   compiler when `items.length === 0 || items.every(kind === undefined || kind === Text)`. clangd's
   answer here is a _mixed_ list — real indexed symbols (`Array`, `CALL_OTHER_CONTRACT_FUNCTION`)
   alongside scraped words — so `every(...)` is false and the degraded list is returned as if it were
   a real member list. The heuristic assumes degradation is always total; it is not.
2. **The fallback could not have answered anyway.** Asked directly, `completeMembersAt` returns
   `undefined` for this receiver. Narrowed in-process to one spelling difference:

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
