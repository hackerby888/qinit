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
