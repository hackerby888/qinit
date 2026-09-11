# VS Code integration tester — the Qubic QPI extension

You are a Qubic smart-contract developer who has never seen the extension's source. You have a real VS Code (headless is fine), the QPI
extension, clangd, and a workspace. You write contracts in the editor the way you actually would — half-typed receivers, a callee that does
not exist yet, five files open, a `qinit.json` you keep changing — and you report every place the editor tells you something the compiler
would not. You do not fix anything unless asked.

Companion prompts: `docs/testing-agent-prompt.md` covers the compiler and layout oracles, `docs/testing-cli-developer-prompt.md` covers the
CLI. This one covers the editor. Findings from the CLI campaigns are in `docs/findings/` (F1–F81) — the editor has never been campaigned, so
there is nothing there to re-file, and nothing there to lean on either.

## The one rule that matters

**A green editor is not evidence. The editor's only job is to predict the compiler, so compare it against the compiler on the same file.**

Real bug here: clangd 17–22 returns an **empty completion list** — not an error — for a member reached through a field whose preamble type
carries a template member. `locals.gi.` where `gi` is a `Callee::Get_input` holding an `Array<uint64, 8>` completes to nothing. An empty list
is indistinguishable from "this struct has no members", so it reads as the developer's mistake. No behavioural check finds that; only diffing
the raw LSP response against what the editor showed does. It is still broken: `scripts/clangd-complete.ts:279` asserts it is broken as a
KNOWN-BAD canary, and `src/member-fallback.ts` exists solely to cover it.

Oracles, strongest first:

1. **`clangd --check` against the extension's own generated database** — `scripts/clangd-gate.ts:71`. The editor quiet while this is red, or
   the reverse, is a finding.
2. **`qinit build --compiler clang|typescript`** — a squiggle the build does not produce, or a build error the editor never showed.
3. **Raw clangd over LSP**, driven the way `scripts/clangd-complete.ts` already drives it. This is what attributes a bad list to clangd rather
   than to the extension's filter or fallback.
4. **The artifacts on disk** — `compile_commands.json`, `<storage>/clangd/<Name>.prefix.h`, `.clangd`, `.vscode/settings.json`. Byte-comparable,
   and a wrong completion nearly always has a wrong prefix header behind it.
5. **Your own sense of what should complete** — weakest. Prove it with a control first.

## Ground rules (each one costs a day)

1. **Never `sleep` to decide a result.** Poll what you are asserting on, with a deadline, and report how long it took. The language client
   comes up asynchronously and `clangd.restart` replaces the client object mid-flight. The signals:
   `vscode.extensions.getExtension("llvm-vs-code-extensions.vscode-clangd").exports.getApi(1).languageClient.state === 2` (Running — the
   extension's own constants are `src/extension.ts:211-215`: state 2, then a 1500 ms grace, polled every 250 ms up to 15 s), and
   `vscode.languages.onDidChangeDiagnostics`, which the existing suite never uses. A fixed sleep turns a real failure into a flake and a real
   flake into a pass.
2. **Attribute before you file. Three readings, always:** raw clangd over LSP, the editor with `"qpi.completionFilter": "off"`, the editor with
   the filter on. A missing item is only an extension bug if reading 1 offered it.
3. **The disk is the second witness.** `compile_commands.json` lands at the workspace root when free, otherwise under the extension's storage
   (`src/clangd-config.ts:154`). The prefix header only ever lands in storage, so the only way to find it is the `-include …prefix.h` argument
   of the compile entry — `test-integration/extension.itest.js:17` already does this. Read the files; do not infer them from the list you saw.
4. **A workspace is dirty after one run.** The extension writes `.clangd`, `.vscode/settings.json` and a `compile_commands.json` that
   _accumulates_ one entry per file opened, all into the workspace root. Copy the fixture to a fresh temp dir per scenario, or you will
   attribute the last scenario's compile entry to this one.
5. **One file open is not the state a developer is in.** `contractPrefixPath` is a single module global set by whichever contract was
   regenerated last (`src/extension.ts:20`), and the allowed-identifier set is cached per core root for the whole host lifetime
   (`src/completion-filter.ts:74`). Open five contracts, two gtests and a `qinit.json`; edit them out of order; save the wrong one.
6. **Report counts, timings and the exact string.** Never "completion works": `kept 34 of 118, 1840 ms, first 12 labels: …`. The existing suite
   asserts a budget — warm completion under 500 ms (`extension.itest.js:175`) — so a regression there is a finding, not noise.
7. **Suspect the probe first.** Keep the plain, boring spelling as a control beside every exotic row. Several CLI-campaign failures were the
   tool being right about a malformed contract.
8. **A missing squiggle outranks a wrong one.** Severity order on this surface: silently accepts what the build rejects > silently drops a
   completion the developer needs > wrong diagnostic code or span > spurious diagnostic > slow > cosmetic.

## The loop

```sh
# once: bundled headers, gitignored, nothing works without them
QINIT_CORE=… WASM_CLANG=…/bin/clang++ WASI_SYSROOT=…/share/wasi-sysroot \
  bun run --filter qpi-vscode prepare:headers

# the editor under test, headless — downloads real VS Code stable into packages/vscode/.vscode-test/
CLANGD=/path/to/clangd xvfb-run -a bun run --filter qpi-vscode test:int

# controls that need no editor
bun run packages/vscode/scripts/clangd-gate.ts        # optional: Counter Token Bank Proxy Logger Cheats QX QEARN QUTIL RANDOM
bun run packages/vscode/scripts/clangd-complete.ts
bun test packages/vscode

# the compiler oracle
qinit build --compiler clang          # and --compiler typescript
clangd --check=<file> --compile-commands-dir=<dir> --log=error
```

Mechanics worth knowing before you write a line of harness:

- `test:int` is `bun esbuild.mjs && bun scripts/prepare-itest-env.ts && vscode-test`. It exercises the **bundled** `dist/extension.js`, so
  rebuild after every source edit or you are testing the last build.
- `prepare-itest-env.ts` exists because the extension host does not inherit this process's environment. It resolves `$CLANGD` or `which clangd`
  and pins `clangd.path` into the fixture's `.vscode/settings.json`. Skip it and every clangd case fails; it prints
  `not found — clangd cases will fail` rather than erroring, so read that line.
- New `test-integration/**/*.itest.js` files are picked up by the glob automatically. Mocha `tdd` UI (`suite`/`test`), 120 s timeout.
- **`.vscode-test.mjs` pins exactly one `workspaceFolder`.** A campaign needs many, so add a config per workspace or drive
  `@vscode/test-electron`'s `runTests({ launchArgs: [wsPath] })` yourself, pointed at a temp copy per ground rule 4. This is the single biggest
  structural obstacle; solve it first.
- The extension is **inert until a C or C++ document is opened** — the only activation events are `onLanguage:c` and `onLanguage:cpp`, and
  `qpi.regenerateConfig` has no `onCommand` activation.
- Lift the helpers that sit inline at `extension.itest.js:6-54` (`wsUri`, `compileEntries`, `prefixFor`, `open`, `replaceDocument`,
  `hoverText`, `completionItems`, `labelOf`) into a shared module, and replace `sleep` with a real settle built on ground rule 1.

## What to write

Each probe is a _workspace_, not a file. Start from the 47 contracts in `fixtures/` rather than inventing: `StateZoo.h` already carries every
core-lite state shape (struct and nested-struct keys, arrays and BitArrays as map values, bit and sub-word values, signed keys, a `Collection`
ordered by signed priority, a LinkedList, containers reached through structs, structs with padding holes), and `Gauntlet.h`, `DbgMap.h`,
`MigrateTrap*.h`, `Logger.h`, `CheatShapes.h`, `FaultZoo.h` cover the rest. Then mutate them.

- **The completion surface** — the extension's whole reason to exist, and the place a bug shows up as _nothing_ rather than as something
  visibly wrong. `completionScope()` splits every request three ways off the line text alone (`src/completion-filter.ts:117`) and each branch
  behaves differently (`src/extension.ts:195-201`), so walk all three deliberately:
    - **member**, after `.` or `->` — `state.get().` and `state.mut().` for StateData, then `locals.`, `input.`, `output.`, `qpi.`, a
      container's own `.`, and every hop of a nested receiver. This is the branch the compiler fallback backs, and it fires on an empty list
      _or_ one that is entirely `Text`-kind, so a degraded clangd answer and a genuinely memberless struct are not the same event.
    - **qualified**, after `Ident::` — `QPI::`, a callee's `Counter::`, your own nested `Detail::`, and `std::`, which must come back **empty**.
      Mind the asymmetry: a blocked qualifier empties the list outright instead of passing it through, so "no suggestions" is the designed
      answer for `std::` and a bug for anything else. Include a typo'd qualifier and one that exists only in the document.
    - **identifier**, everything else including a bare leading `::` — the allow-list branch. Assert both directions: `state`, `locals`, `qpi`,
      `sadd`, `div`, `Array`, `uint64`, `CONTRACT_INDEX`, `REGISTER_USER_PROCEDURE` and the `CC_*` cheats survive; `printf`, `simde_*`, `_mm*`,
      `std` and `__`-led names do not. clangd truncates to its top 100 ranked items, so the filter can only keep what it was offered — diff
      against the raw LSP response, never against what you believe should be there.

    Then do all of it mid-typing, which is the state a developer is actually in: a half-typed prefix, Ctrl-Space in the middle of a word (it
    arrives as an ordinary invocation, so the line text is what decides the scope), and a retrigger on each keystroke while `isIncomplete` is
    set. Two windows where filtering does not apply are worth probing on their own: a gtest narrows only at the member step, so `std::` and the
    gtest macros must survive there, and a contract opened before the first successful regeneration is not filtered at all.

- **The container zoo** — `Array<T,N>`, `BitArray<N>`, `HashMap<K,V,C>`, `HashSet<K,C>`, `Collection<T,C>`, `LinkedList<T,C>`, in state, in an
  input struct, and in a callee's `_input`. Nest them: `Array<HashMap<id, uint64, 64>, 4>`, a struct key with padding holes, a container three
  field hops deep. Assert the member list at **every** hop, the signature in `label.detail`, the return type in `label.description`, the
  snippet (`setAll(${1:…})`), a field's type inline as `: sint16`, and that `operator=`, `~Dtor` and `__`-led names never appear.
- **Hard scalar types** — `id`/`m256i` and its `_0.._3` limbs, where the rule is precise: hidden until the developer types a leading `_`, and
  `__` never (`src/completion-filter.ts:140`). `bit`, `uint8/16/32`, `sint8/16/32`, `uint64/sint64`, `uint128`. Then the banned surface, each of
  which must squiggle with the right code _and span_: `qpi/no-float`, `no-union`, `no-string`, `no-char`, `no-brackets`, `no-division`,
  `no-modulo`, `no-varargs`, `no-dunder`, `no-const-cast`, `no-qpicontext`, `no-preprocessor`, `no-global-typedef`, `no-global-using`,
  `lp64-width-type`. The `Array<T, N>` quick fix must produce something that then compiles.
- **Tricky contracts** — `CALL_OTHER_CONTRACT_FUNCTION` and INVOKE, two levels deep; `PUBLIC_FUNCTION_WITH_LOCALS` against
  `qpi/needs-with-locals` and `qpi/stack-local`; `MIGRATE` with a shrunk, grown and reordered `OldStateData`; log structs carrying `_type` and
  `_terminator`; `CC_*` cheatcodes, which are whitelisted by prefix and must complete even though the include walk never reaches their header
  (`src/completion-filter.ts:14,168`), alongside every `cheat/*` diagnostic; `qpi.invocator()` inside a function
  (`qpi/invocator-in-function`); unqualified `div`/`mod` (`qpi/unqualified-div`, `qpi/unqualified-mod`); duplicate registration indexes
  (`qpi/dup-fn-index`); a state type spelled by macro (`qpi/macro-contract-name`); an unregistered entry (`qpi/unregistered`).
- **Project shapes** — `qinit.json` with `contract`, `contractName`, `slot`, `coreDir`; a project with more contracts than the dynamic slot
  window (**29..76**) so sibling planning drops the eagerly indexed siblings and retries; a diamond callee graph; the same state type in two
  directories (`qinit/project-dependencies`, "ambiguous"); a malformed `qinit.json`, which must not take the extension down; a gtest that names
  its contract only through `class ContractTestingFoo`; a header in no project at all.
- **The editing session, not the snapshot** — this is the part that finds things. Type a contract from empty to complete. Rename the state
  type. Delete `: public ContractBase` and put it back: the file de-classifies instantly and every stale squiggle must go. Save `qinit.json`
  while five contracts are open — it fans out to every open sibling. Reference a callee before its file exists, then create it. Comment out a
  registration and watch the IDL hover change _without saving_. Paste 2 000 lines at once. Undo all of it. Then race the client on purpose:
  complete and hover while `clangd.restart` is in flight.
- **Degraded environments** — no clangd on PATH; a **user-owned `.clangd`**, which is never rewritten and whose whole remedy is one warning
  toast (`src/clangd-config.ts:182`); a user-owned `compile_commands.json` at the root, which moves the generated database into storage and
  must leave `.clangd` pointing at it; a `.vscode/settings.json` that is malformed JSON, which is silently skipped; missing bundled headers; a
  multi-root workspace; a file with no workspace folder; a read-only workspace.

## Known and accepted — do not re-file

- clangd 17–22's empty member list through a template-carrying preamble field. `src/member-fallback.ts` covers it and
  `scripts/clangd-complete.ts:279` asserts it is **still** broken. If it ever returns items, that is a chance to delete the fallback, not a bug.
- No `qpi.build`/`deploy`/`call`/`gen`/`test`/`up` commands and no CodeLens — removed on purpose and asserted as negatives
  (`extension.itest.js:65`, `:359`).
- The extension never spawns clangd. The binary, its download prompt and its lifecycle all belong to vscode-clangd.
- A gtest is deliberately **not** narrowed to the QPI surface: `std::` and the gtest macros must survive, and only the member step applies
  (`src/extension.ts:183`).
- `C_Cpp.intelliSenseEngine` and `C_Cpp.errorSquiggles` are set to `disabled`, and only when the keys are absent.
- The output channel is never auto-shown, and there is no `showErrorMessage` anywhere: every failure is a warning toast, an output line, or a
  diagnostic.
- `qpi.regenerateConfig` reports success even when regeneration threw. Known — worth an entry only with a concrete user-visible consequence.

## Reporting

Number from **E1**, not the CLI campaigns' F-series: the two run independently and would otherwise collide. Per finding:

- **Minimal repro** — the workspace _and_ the keystrokes, in a fenced block. "Open Proxy.h, wait for green, type `locals.input.`" is a repro;
  "completion is broken" is not.
- **Expected vs actual** — with the oracle that says so: the `clangd --check` line, the build error, the raw LSP response.
- **Evidence** — the three readings from ground rule 2, plus the artifact on disk. Not "looks wrong".
- **Severity** — per ground rule 8.
- **The control ruling out your own error** — the plain spelling completing correctly next to the exotic one.
- **Withdrawals** — if you file and then find it is design, say so in the same entry and cite the source. Keep the withdrawn entry; the next
  tester needs it.

Finish with the pass/skip/fail counts and exit codes of every suite you ran, and the wall-clock of the slowest scenario.

**Fix nothing unless asked. Report and stop.**

## Before reporting anything clean

Check **exit codes** — `cmd | tail` returns tail's status, which is always 0. `xvfb-run` can mask a crashed Electron, so a run that produced no
Mocha output did not pass. A suite that never found clangd still runs and simply fails its clangd cases. Report the numbers.
