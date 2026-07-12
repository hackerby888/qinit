# Test layout

Tests live under each package and are grouped by behavior, not kept in a flat package-level directory.

| Package | Test groups |
| --- | --- |
| `build` | `corpus`, `generation`, `idl`, `pipeline` |
| `cli` | `commands`, `contracts`, `format`, `integration`, `rpc` |
| `compile` | `differential`, `edge`, `frontend`, `fuzz`, `gtest`, `integration`, `qpi` |
| `core` | `crypto`, `debug`, `network` |
| `engine` | `contracts`, `integration`, `logging`, `merkle`, `network`, `runtime` |
| `proto` | `codec`, `protocol` |
| `vscode` | `clangd`, `language` |

Keep reusable test modules in `support/` and binary/source assets in `fixtures/`. Do not add `*.test.ts`
directly to `packages/*/tests`; the portability/layout ratchet rejects flat additions.

Tests that read live core-lite source require its checkout path:

```bash
export QINIT_CORE=/path/to/core-lite
bun test
```

Bun discovers `*.test.ts` recursively, so package and repository commands do not need a list of every group.
