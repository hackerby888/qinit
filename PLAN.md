# Qinit — framework for Qubic dynamic contracts

**Status:** plan / greenfield.
**Pairs with:** `qubic-core-lite/src/extensions/DYNAMIC_CONTRACTS.md` — Qinit is the dev-facing
toolchain (client side) for that on-chain runtime-deploy mechanism, and the vehicle we use to
actually exercise/test it.

Qinit is the framework for Qubic dynamic contracts: scaffold → build → deploy → test →
typed client, in one polished CLI.

---

## 1. Goals / non-goals

**Goals**
- One CLI: `qinit new | build | deploy | test | call | node | keys | idl | registry`.
- Build a Qubic contract header (`.h`, qpi.h-constrained) → `.so` + descriptor + IDL + K12 hash.
- Deploy via the on-chain chunked-upload protocol (the client side of `DYNAMIC_CONTRACTS.md` §2.2).
- Generate a typed TS client from the IDL.
- Spin a local testnet node and run TS tests against deployed contracts.
- **Ship as a standalone single-file binary** (`bun build --compile`) — no runtime install for users.
- Claude-Code-style terminal UX (Ink): streaming output, spinners, interactive prompts, command
  palette; works both interactively and as one-shot commands/CI.

**Non-goals (now)**
- Mainnet deploy. Qinit targets testnet-lite-RAM + `LITE_WASM_SC` only (the core firewall stands).
- Reimplementing the C++ contract compiler — we shell out to `clang-18`.
- A general Qubic wallet; only the keys needed to sign deploy/test txs.

---

## 2. Stack & why

- **Bun** — runtime + bundler + test runner + **`--compile` standalone binary**. Single toolchain.
- **TypeScript** — typed protocol + IDL codegen.
- **Ink (React for the terminal)** — composable TUI; matches the Claude-Code-style ask.
- **clang-18** — external subprocess for the `.so` build (documented prereq, not bundled).

### Standalone-binary constraint (drives architecture, from day 1)
`bun build --compile` bundles JS + assets + the Bun runtime into one executable. Consequences baked
into the design:
- **No native node-gyp addons** anywhere in the dependency tree — they don't bundle. All crypto is
  **pure-TS or WASM** (K12, FourQ/schnorrq). WASM must be **embedded** (imported as bytes), never
  loaded from a runtime file path.
- **Templates/assets embedded** (imported modules or `Bun.embeddedFiles`), not read from `__dirname`.
- **`clang-18` is invoked via `Bun.spawn`** — external dependency checked at runtime by `qinit doctor`,
  not bundled.
- Cross-compile targets produced in CI: `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64`,
  `bun-windows-x64`.

---

## 3. Day-1 bun standalone setup

`package.json` (root, Bun workspaces):
```jsonc
{
  "name": "qinit",
  "private": true,
  "workspaces": ["packages/*"],
  "bin": { "qinit": "./dist/qinit" },
  "scripts": {
    "dev": "bun run packages/cli/src/index.ts",
    "build:bin": "bun build packages/cli/src/index.ts --compile --minify --sourcemap --outfile dist/qinit",
    "build:all": "bun run scripts/build-matrix.ts",   // loops --target=bun-{linux,darwin,windows}-{x64,arm64}
    "test": "bun test",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```
`bunfig.toml`:
```toml
[install]
exact = true
[test]
coverage = false
```
Smoke check for the compile path on day 1: a trivial Ink "hello" → `bun run build:bin` → run
`dist/qinit` with no Bun installed. Validates Ink + yoga-wasm + embedding under `--compile` before
any real code. This de-risks the binary goal early.

---

## 4. Monorepo layout

```
Qinit/
  packages/
    cli/        # Ink TUI + command dispatch (the --compile entry point)
    core/       # wraps @qubic-lib/qubic-ts-library: identity, K12, schnorrq sign, tx, connector
    proto/      # lite deploy protocol: chunk/UploadBegin/Chunk/Deploy, ARQ, activation poll, registry read
    build/      # .h → .so via clang-18; descriptor extraction; IDL emit; K12 hash
    idl/        # IDL schema (zod) + codegen (IDL → typed TS client)
    testkit/    # local node lifecycle + assertion helpers (drives the core feature end-to-end)
  templates/    # embedded project scaffolds (contract.h, qinit.toml, tests, .gitignore)
  scripts/      # build-matrix, release
  PLAN.md
```
Workspaces for dev ergonomics; the shipped artifact is the single compiled `cli` entry that imports
the rest.

---

## 5. Command surface (Claude-Code-style)

| Command | Does |
| --- | --- |
| `qinit new <name>` | scaffold a project from an embedded template (contract.h, qinit.toml, tests) |
| `qinit doctor` | check clang-18, node endpoint, deployer key, core headers path |
| `qinit build` | `.h` → `.so` + descriptor + IDL + hash (see §7) |
| `qinit idl` | (re)generate IDL JSON + typed TS client from the built contract |
| `qinit deploy [--slot N] [--node URL]` | chunked on-chain upload + Deploy tx + activation wait (§6) |
| `qinit call <fn|proc> [args]` | build/sign a tx (proc) or RequestContractFunction (fn); decode output via IDL |
| `qinit registry` | read deploy registry / upload status / missing-seq bitmap from a node |
| `qinit node <up|down|status>` | manage a local testnet `qubic-core-lite` node for tests |
| `qinit test` | bring up node, deploy, run `bun test` specs against the typed client |
| `qinit keys <new|show|import>` | manage the deployer seed (55-char), derive identity |

Two modes: one-shot (`qinit deploy …`, CI-friendly, plain output when not a TTY) and an interactive
REPL (`qinit`) with a command palette + live panes.

---

## 6. Protocol client (`packages/proto`) — the crux

Implements the client side of `DYNAMIC_CONTRACTS.md` exactly:

- **Tx types** `LiteUploadBeginTx`, `LiteUploadChunkTx`, `LiteDeployTx` — destination = system address
  (`dest == 0`), `inputType` in the lite range; encoded + signed by `core`.
- **Upload:** split `.so` into ≤1008-B chunks `{ sessionId, seq, len, bytes }`; send `UploadBegin`
  then chunk txs; the node scatter-writes by `seq`. Respect the 4096 tx/tick budget; pace across ticks.
- **ARQ:** poll the registry/status read endpoint for the missing-seq bitmap; resend only gaps until
  the seq bitmap is full and `K12(blob) == finalHash`.
- **Deploy + derived activation:** send `Deploy { sessionId, targetSlot, finalHash }`; then poll the
  registry until `status == constructed` at the derived activation tick. No client-chosen tick.
- **Calls:** procedures = signed txs to the slot index; functions = `RequestContractFunction` RPC;
  inputs/outputs (de)serialized from IDL layouts.

Built on `core`, which wraps **`@qubic-lib/qubic-ts-library`** (`github.com/qubic/ts-library`):
`QubicHelper` (seed→identity), `libFourQ_K12` (K12 + schnorrq sign), `QubicTransaction` /
`QubicPackageBuilder` (tx framing), `QubicConnector` (node network). The lite deploy tx types
(`LiteUploadBeginTx`/`LiteUploadChunkTx`/`LiteDeployTx`) are **not** in the upstream lib — Qinit
layers them on top of its tx-building primitives.

---

## 7. Build pipeline (`packages/build`)

`.h` → artifacts, via the pinned recipe (`DYNAMIC_CONTRACTS.md` §5.4):
```
clang++-18 -fPIC -shared -O2 -std=c++20 \
  -I <core>/src -I <core>/src/contracts \
  -DLITE_DYN_SO_BUILD -DCONTRACT_INDEX=<slot> -DCONTRACT_STATE_TYPE=... \
  -include qpi.h -include extensions/wasm/lite_dyn_abi.h \
  contract.cpp -o build/<name>.so          # NEVER include contract_exec.h
```
Then:
- **Descriptor** — read the exported `liteContractDescriptor()` from the `.so` (sizes, inputTypes,
  entrypoint kinds, stateSize, stateLayoutVersion).
- **IDL** — parse the contract source's `REGISTER_USER_FUNCTION/PROCEDURE` macros + input/output
  struct layouts → IDL JSON (names + types). Cross-check sizes against the descriptor (mismatch =
  build error).
- **Hash** — `finalHash = K12(.so bytes)`; written to the manifest for deploy.

`qinit doctor` verifies `clang-18` + the configured `qubic-core-lite` headers path.

---

## 8. IDL + codegen (`packages/idl`)

- IDL schema validated with **zod**. `{ name, version, stateLayoutVersion, entrypoints: [{kind, name,
  inputType, fields, output}], errors }`.
- Codegen: IDL → a typed TS client — `await program.methods.foo({...}).proc()` /
  `await program.views.bar({...}).call()` — that encodes inputs to the contract's structs, builds/signs
  txs (proc) or RPC (fn), and decodes outputs.
- Layout codec: map Qubic primitive types (`uint64`, `sint32`, `id`/m256i, `Array<T,N>`, QPI
  collections' wire forms) ↔ TS, little-endian, matching the C++ struct packing.

---

## 9. Test harness (`packages/testkit`)

- `node up` builds/launches `qubic-core-lite` (TESTNET + TESTNET_LITE_RAM + LITE_WASM_SC), MAIN mode, waits
  for ticking; `down` kills it (honor "pkill Qubic before restart").
- Helpers: `deploy(soPath)`, `program(idl)`, tick/await utilities, balance/state assertions.
- `bun test` specs use the typed client. This is also our **acceptance test for the core feature** —
  the first real end-to-end exercise of on-chain deploy.

---

## 10. TUI / UX (`packages/cli`)

- Ink components: streaming log pane, step/spinner list (build → upload → deploy → activate), a
  missing-seq progress bar for ARQ, tables for `registry`.
- Claude-Code-style: interactive command palette, inline prompts (pick slot, confirm deploy), color
  + symbols, graceful non-TTY fallback to plain lines for CI.
- Command dispatch shared between REPL and one-shot.

---

## 11. Config & scaffold

`qinit.toml` (per project):
```toml
[project]      name = "myc"
[toolchain]    core = "/path/to/core-lite"; clang = "clang++-18"
[contract]     header = "src/MyContract.h"; slot = 0; state_type = "MYC"
[node]         rpc = "http://127.0.0.1:41841"; p2p = "127.0.0.1:31841"
[deploy]       seed_ref = "env:QINIT_SEED"          # never store raw seed in the file
```
Embedded template: `MyContract.h` (qpi.h-constrained, with INITIALIZE + a sample proc/fn), a sample
`*.test.ts`, `qinit.toml`, `.gitignore`.

---

## 12. Dependencies / validations to settle first

- **Qubic crypto = `@qubic-lib/qubic-ts-library`** (`github.com/qubic/ts-library`). Crypto is
  `src/crypto/libFourQ_K12.js` — an Emscripten module (FourQ sign + K12). The repo ships no separate
  `.wasm`, so it is almost certainly single-file (base64-embedded) → bundles under `bun --compile`.
  **Verify empirically in M0** (sign + K12 from the compiled binary). Fallback if it ever loads wasm
  from a path: vendor+embed a WASM build of the core's `lib/k12` + FourQ.
- **Ink + `bun --compile`** — validate yoga-wasm + React reconciler in the compiled binary (the day-1
  smoke test, §3).
- **Lite tx wire format** — pin `LiteUpload*`/`LiteDeploy` `inputType` values + struct layouts jointly
  with the core side so client and node agree.
- **Node read endpoint** for registry/missing-seq (lite HTTP GET / request msg) — define alongside the
  core extension.

---

## 13. Milestones

- **M0 — bin skeleton. ✅ DONE.** Bun workspaces, `--compile` script, Ink CLI (`help`/`version`/
  `doctor`/`smoke`), standalone-binary smoke test. Validated: `./dist/qinit smoke` derives a Qubic
  identity (K12 + FourQ via `@qubic-lib/qubic-ts-library` wasm) from the compiled binary under a clean
  `env -i` — fully self-contained (~91 MB; bun runtime baseline). **Gotcha:** Ink eval-imports
  `react-devtools-core`; under `--compile` it must resolve, so we ship a tiny stub at
  `stubs/react-devtools-core` wired as a `file:` dep (`--external` does NOT work with `--compile`).
- **M1 — build. ✅ DONE (build core).** `qinit build`: `.h` → `.so` against `qpi.h` +
  `lite_dyn_abi.h`. Validated on `fixtures/Counter.h` → `Counter.so` (16.5 KB), exports
  `liteContractRegister` + `liteSetHostServices`, **0 unresolved QPI symbols** (minimal ABI
  satisfies it). Recipe (in `packages/build`): clang ≥18 (any clang, not gcc), `-std=c++20 -O2 -fPIC
  -shared -fno-rtti -mavx2` (m256i AVX ABI must match host), `-I<core>` (repo root, for `lib/...`) +
  `-I<core>/src`, a std prelude, `LITE_DYN_SO_BUILD` + `CONTRACT_INDEX/STATE_TYPE`, never
  `contract_exec.h`. K12 hash works in dev; **pending in the `--compile` binary** (wasm-instance
  quirk) — fix in M2 (deploy needs it). TODO: descriptor/IDL extraction (M3).
- **M2 — protocol + deploy. 🔶 foundation done.**
  Done + validated: `core/tx` (`buildSignedTx` via `QubicTransaction`+`DynamicPayload`+`PublicKey`;
  tx = 80 hdr + payload + 64 sig), `core/rpc` (`LiteRpc` GET client for the built-in RPC — `/tick-info`
  etc., the fast read path), `proto` (lite tx encodings `UploadBegin`/`UploadChunk`/`Deploy` + `chunkSo`,
  inputTypes 240/241/242 to the system dest). Encodings + signing unit-validated.
  Remaining: tx **broadcast** (QubicConnector P2P — built-in RPC is GET-read-only), `qinit deploy`
  orchestration (chunk → upload → ARQ → deploy → activation poll), and the **core host-side**
  (`lite_dynamic_contracts.h` + `processTickTransaction` hook + blob store/registry + B' construction)
  — required before deploy runs end-to-end against a node. Also: fix binary-K12, live lite-testnet test.
- **M3 — IDL + client + call.** IDL emit, codegen, `qinit call`.
- **M4 — testkit.** `qinit node` + `qinit test`; the typed client drives deployed contracts.
- **M5 — UX polish + release.** Palette, panes, cross-target binaries in CI.

---

## 14. Risks

- `@qubic-lib/qubic-ts-library` wasm not embedding under `--compile` (low — looks single-file;
  verify M0) → vendor+embed fallback.
- Lite tx/endpoint contract drift between Qinit and core → single shared spec, versioned (`abiVersion`).
- C++ struct ↔ TS layout mismatches → descriptor sizes are the source of truth; IDL cross-checks at
  build.
- `bun --compile` + Ink edge cases (raw mode TTY) → keep a plain-output fallback path.
