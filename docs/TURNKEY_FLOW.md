# Plan: #1 `qinit sync` + #2 `qinit node` — works-out-of-the-box flow

## Goal
Remove the two manual setup deps for a contract dev, **keeping native clang** (#7 parked):
1. **#1** — no local core checkout. Headers come from a pinned snapshot fetched from GitHub releases.
2. **#2** — no local node build. A prebuilt testnet+dynamic `Qubic` is fetched + run by `qinit`,
   with every operational footgun baked in.

End state: `qinit up` = fetch headers + fetch node + run node ticking. Then `qinit deploy` / `qinit call`.
Dev installs: the `qinit` binary + system `clang-18`. Nothing else.

## Grounded facts (measured 2026-06-03)
- Compile pulls **41 transitive core headers (~791 KB)** (`clang -M` closure): dirs `contracts/`,
  `contract_core/`, `network_messages/`, `oracle_interfaces/`, `oracle_core/`, `platform/`,
  `extensions/`, `lib/platform_common/`.
- Inter-contract additionally needs **all `src/contracts/*.h` (35 files, ~1.7 MB)** + `contract_def.h`
  (callee types + index map). → snapshot ≈ a few curated subtrees, ~2.5 MB raw, tiny zstd.
- Core repo = `github.com/hackerby888/core-lite`, has `release.yml` + `linux-build.yml` to model on.
- All node toggles are CMake `-D` (verified): `TESTNET`, `TESTNET_LITE_RAM`, `TESTNET_PREFILL_QUS`,
  `LITE_DYNAMIC_CONTRACTS`, `CMAKE_NO_USE_SWAP`, `ONLY_LOGGING` → CI builds the node **without editing
  qubic.cpp**.

## Release target
All GitHub releases, workflow-test runs, and asset uploads go to **`hackerby888/core-lite`** (the
`hackerby888` remote / the user's fork) — **never `origin` (= `qubic/core-lite` upstream)** or `qubic/core`.
Manifest + node + header asset URLs all resolve against `hackerby888/core-lite` releases.

## Shared infra: cache + fetch + manifest
`~/.cache/qinit/<ver>/{core-headers/, node/Qubic}` — one dir per pinned version.

**Release manifest** (asset on core releases, the ABI linchpin):
```jsonc
// qinit-manifest-<ver>.json
{ "version": "v0.1.0",
  "node":    { "url": "...Qubic",                 "sha256": "..." },
  "headers": { "url": "...core-headers.tar.zst",  "sha256": "..." } }
```
One version ⇒ node + headers that match (the `.so` compiled vs the snapshot dlopens into that node).

New `packages/core/src/fetch.ts`: `fetchAsset(url, sha256) -> path` (download, verify sha, atomic
extract), `loadManifest(ref) -> Manifest`, `cacheDir(ver)`. `--offline` = cache-only. Used by sync + node.

## #1 — `qinit sync`
- `qinit sync [--ref <tag>] [--offline]` → fetch+verify `core-headers.tar.zst` → `~/.cache/qinit/<ver>/core-headers/`.
- **Resolution of the header root** (replaces today's `corePath`): `--core <path>` (local dev) >
  `~/.cache/qinit/<ver>/core-headers` > `$QINIT_CORE` > error("run `qinit sync`").
- Wire-in: `recipe.ts` `-I<root> -I<root>/src`; `intercontract.ts` reads `<root>/src/contract_core/contract_def.h`.
  Both already take `corePath` → just change how it's resolved (one helper `resolveCore()` in the CLI).
- `doctor` verifies snapshot present + sha matches manifest.

## #2 — `qinit node {get,run,status,stop}` + `qinit up`
- `get [--ref]` → download prebuilt `Qubic` → cache, chmod +x, verify sha.
- `run [--dir <scratch>]` → **bakes in the footguns**: `pkill -f Qubic` + confirm dead; fresh scratch
  dir (default `~/.cache/qinit/run`, never in-tree); launch
  `Qubic --peers 127.0.0.1 --node-mode 3 --ticking-delay 1000`; poll RPC until ticking; report tick + RPC up.
- `status` → RPC `tickInfo` + dyn-registry (armed slots). `stop` → pkill + confirm.
- `qinit up` = `sync` + `node get` + `node run` (one-command bring-up).

### Core-side work #2 needs (new)
1. **CI job to publish the prebuilt node** (extend `release.yml`): cmake with
   `-DTESTNET=ON -DTESTNET_LITE_RAM=ON -DTESTNET_PREFILL_QUS=ON -DLITE_DYNAMIC_CONTRACTS=ON
   -DCMAKE_NO_USE_SWAP=ON -DONLY_LOGGING=OFF -DCMAKE_BUILD_TYPE=RelWithDebInfo` → upload `Qubic` + sha.
   **Also required (see memory):** logging event ON — do **not** pass `-DNO_ENABLE_QUBIC_LOGGING_EVENT`
   (`getEventLogs` readback); TX-status addon ON — `#define ADDON_TX_STATUS_REQUEST` in `public_settings.h`
   (source toggle, not a `-D`; tx-confirmation RPC).
2. **CI job to publish the header snapshot**: tar the needed subtrees (or `clang -M` closure ∪ contracts
   ∪ contract_def.h) → `core-headers.tar.zst` + sha. (`clang -M` in CI = always-correct, self-updating.)
3. **Seeds for self-tick (no new flag).** A single-node dev testnet must hold all 676 computor seats
   (`broadcastedComputorSeeds`) to make quorum + tick. The `ONLY_LOGGING` shim (`empty_private_settings.h`)
   has empty seed arrays → 0 seats → never ticks. So the release must build with `ONLY_LOGGING=OFF`
   against a `private_settings.h` that carries a testnet computor fixture.
   `src/private_settings.h` is **git-tracked**, so the seed set is just *which copy CI compiles against* —
   **no compile flag**. Decider: is the committed file safe to publish (`OPERATOR="AAA…"`, peers/oracle
   `127.0.0.1`, throwaway testnet seeds)? If yes → CI builds it as-is. If it carries real operator/oracle/
   peer infra → CI swaps a dedicated `private_settings.public-testnet.h` at build time. Either way the
   user's local file is untouched and no `-D` is added.

## Open questions to resolve before coding the CI piece
- Does qubic.cpp honor `CMAKE_NO_USE_SWAP` to undo its hardcoded `#define USE_SWAP`? (verify; qubic.cpp
  is user-owned — may need a one-line guard).
- Is committed `src/private_settings.h` safe to publish, or does CI need a `private_settings.public-testnet.h`?
- Snapshot scope: whole curated subtrees (simple, future-proof) vs `clang -M` closure (minimal). Recommend
  subtrees — tiny anyway, won't under-include when upstream adds a header.
- Qinit has no GitHub remote → the `qinit` binary itself is distributed separately; qinit only **consumes**
  core releases here.

## Staging (de-risk order)
1. **[DONE]** Cache/fetch infra + manifest schema + `qinit sync`. `packages/core/src/fetch.ts`
   (cache/sha/manifest/current.json), `packages/build/src/snapshot.ts` (clang -M closure ∪ contracts ∪
   contract_def.h ∪ lite_contract_calls.h), `qinit sync --from <core>` (local) / `--ref` (release),
   `resolveCore()` (cli > env > cache). Proven: all 8 fixtures + inter-contract build from cache, byte-
   identical to a checkout. `--ref` path coded, untested until Stage 2 publishes assets.
2. **[WRITTEN]** Core CI: `.github/workflows/qinit-release.yml` + `scripts/qinit-header-snapshot.sh`
   (on hackerby888). Builds node (verified `-D` set incl. `ADDON_TX_STATUS_REQUEST=ON`, configure rc=0),
   builds snapshot (script proven: all fixtures + inter-contract build from it), writes manifest, `gh
   release`. Untested live (needs an Actions run on the fork + a public-safe committed private_settings.h).
3. **[DONE]** `qinit node run/status/stop/get`. `run --bin` optional → prefers CI-synced node, auto-fetches.
   status is RPC-driven (`/tick-info` ×2 + `/dyn-registry`). Footguns baked (pkill, scratch, ticking-delay,
   wait-for-tick).
4. **`qinit up`** — sync + node get + run, one command.
5. **`qinit dev` watch loop** — edit `.h` → auto build+deploy.

## Out of scope
#7 wasm toolchain (parked — see WASM_TOOLCHAIN.md), docker compile (#5), multi-node, oracle/proposal templates.
