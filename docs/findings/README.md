# Findings

Raw ledgers from the test campaigns, one file per campaign, written as the campaign ran and never
rewritten. They hold every repro command, oracle, root cause and the exact shape of each break, which
is what an agent or a developer needs when a behaviour looks familiar. This file is the map; the
ledgers stay as they were filed.

Read one entry: `grep -n '^#* *F41' docs/findings/*.md`. Ids are numbered across campaigns, so an id
appears once as a filing and again wherever a later campaign extends or closes it.

## Series

| Ids       | Campaign                                                  | Where                                                                  |
| --------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| F1–F85    | CLI campaigns 1–7                                         | `TESTING-FINDINGS.md`, `-2` … `-7-windows`                             |
| F86–F199  | reserved for the macOS campaign (`testing-macos-handoff.md`) | no file yet                                                        |
| F200–F226 | Solidity-port campaign, TypeScript backend vs clang       | `TESTING-FINDINGS-9-solidity-port.md`; repros in `corpus/solidity-port/triage/F<n>-<slug>/` |
| F227+     | reserved for the oracle/OC campaign (`testing-oracle-oc-agent-prompt.md`) | no file yet                                           |
| S1–S8     | state read-back and state-diff inspection                 | `TESTING-FINDINGS-STATE-INSPECTION.md`                                 |
| E1–E28    | VS Code extension, campaign 1                             | `TESTING-FINDINGS-VSCODE.md`                                           |
| W1–W31    | browser IDE, campaign 1 (fixes land in the Qinit-web repo) | `TESTING-FINDINGS-WEB-IDE.md`                                         |

Never filed: F10, F18, F31. F17 was fixed (`655bb3f7`) but never written up. Campaign 3's `### S1` …
`### S13` headings are test scenarios, not findings; the S series lives only in the state-inspection ledger.

## Ledgers

Each file marks status in its own way; the last column says what to look for.

| File                                                                           | Ids             | Under test                                                                             | Status marked as                                                              |
| ------------------------------------------------------------------------------ | --------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [TESTING-FINDINGS.md](./TESTING-FINDINGS.md)                                   | F1–F21          | campaign 1: `call`, `--in`/`--args`/`--out`, trace and `CC_PRINT` on a probe contract  | `Verdict:` line at the end of each entry                                      |
| [TESTING-FINDINGS-2.md](./TESTING-FINDINGS-2.md)                               | F22–F39         | campaign 2: `--json`, explorer, `debug`, restart, callee traps, on `qinit new` templates | `Severity:` only; `## Index` table at the end                                |
| [TESTING-FINDINGS-3.md](./TESTING-FINDINGS-3.md)                               | F40–F45         | campaign 3: real developer workflows across clang/typescript × simulator/core           | `**Status: fixed**` under the heading                                         |
| [TESTING-FINDINGS-4.md](./TESTING-FINDINGS-4.md)                               | F46–F54         | campaign 4: decode/print layer on production contracts (Qx, Qearn, Quottery)            | summary prose ("remain open"); `**Resolved**` under an entry                  |
| [TESTING-FINDINGS-5.md](./TESTING-FINDINGS-5.md)                               | F55–F64         | campaign 5: toolchain, environment, the CLI's consumers (`gen`, `test`, `gtest`)        | `Severity:` only, report only; `## Index` table at the end                    |
| [TESTING-FINDINGS-6.md](./TESTING-FINDINGS-6.md)                               | F65–F74         | campaign 6: one product's lifetime (QLaunch), P0–P8                                     | repeated headings: `— withdrawn`, `— fix applied and confirmed`               |
| [TESTING-FINDINGS-7-windows.md](./TESTING-FINDINGS-7-windows.md)               | F75–F85         | campaign 7: the QLaunch lifecycle re-run on Windows                                     | `### Fixed after the campaign` list; summary bullets fixed / open / withdrawn |
| [TESTING-FINDINGS-9-solidity-port.md](./TESTING-FINDINGS-9-solidity-port.md)   | F200–F226       | campaign 9: Solidity-ported corpus, TypeScript backend vs clang, in rounds              | per-round result tables: `proposed` / `located` / `verified` / `fixed` / `refused`; `— closed` headings |
| [TESTING-FINDINGS-STATE-INSPECTION.md](./TESTING-FINDINGS-STATE-INSPECTION.md) | S1–S8           | state-diff rows, state rendering, container views                                       | `# Fixes` sections with a `What changed` table                                |
| [TESTING-FINDINGS-VSCODE.md](./TESTING-FINDINGS-VSCODE.md)                     | E1–E28          | the QPI VS Code extension against a headless editor, in rounds                         | heading suffix: `(fixed)`, `(not fixed)`, `(withdrawn)`, `(partly fixed)`     |
| [TESTING-FINDINGS-WEB-IDE.md](./TESTING-FINDINGS-WEB-IDE.md)                   | W1–W31          | the browser IDE: edit, compile and run, call, state, TS tests                           | last line of each entry: `Fixed in Qinit-web <sha>`                           |

Commits name the id they close, so `git log --oneline --grep='\bF224\b'` is the fix record for any id.
