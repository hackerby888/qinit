# qinit CLI test campaign 7 — the QLaunch lifecycle re-run on Windows (F75+)

Binary: `dist\qinit.exe` built from `75cbad9b` with `bun run build:bin` (Bun 1.3.14, 3.2 s, 102 MB; reports `v0.0.0`).
Node: core-lite `develop` @ `0397da15` built on this machine (§Step 0). Workspace: `C:\q\` (product repo `Launch\`, harness
`work\bin\`, raw rows `work\p*\`). Every row below was taken on Windows 11 Home 10.0.26200, 22 cores, 32 GB, Git Bash 2.47,
on 2026-09-06 (01:00–03:30 local, 2026-09-05 UTC). Report only; nothing in Qinit or core-lite was changed. Findings number
on from **F75**; F1–F74 are extended, not re-filed.

**Headline for the Linux author.** The product lifecycle (P0–P8) reproduces on Windows, the P2 round agrees with the
oracle **29/29 on all four cells**, the P1 spec passes **8/8 on both core cells**, and the fixed findings F59, F67, F68, F71,
F72, F73 all hold here — P4 (an upgrade over live state) even runs on core for the first time, because F73 no longer blocks
it. What differs is the platform edge: `setup` cannot install the WASI SDK on this box (F75), `node run` then fetches it
anyway (F65, five minutes), the Core hand-off shows a Windows-only rejection that no Qinit gate catches (F76), and the
simulator's management-rights callback runs with a zero `originator`/`invocator` while core's carry the user and the calling
contract (F82 — the product-level shape campaign 6 filed and withdrew as F69; the vault fails on both simulator cells and
passes on both core cells). Everything the handoff marked **[verify on Windows]** is answered in §Step 0, and four of
those recipes were wrong.

## Step 0 — environment, and what the handoff got wrong

| item | on this machine |
|---|---|
| Bun / Git / CMake / Python / jq | 1.3.14 · 2.47.1.windows.2 · 4.1.0-rc1 (vcpkg fetched its own 4.4.2) · 3.13.1 via `py -3` (the `python` on PATH is the Store stub) · jq 1.8.2 via winget (not on PATH until the shell restarts; `env.sh` adds the WinGet package dir) |
| Visual Studio | 2022 Community, MSVC 14.42.34433, Windows SDK 10.0.26100 |
| `bun run build:bin` | emits **`dist\qinit.exe`** (the handoff's `dist\qinit(.exe)` — confirmed `.exe`) |
| `QINIT_CONFIG` | **not read by any code path**. `config.ts` reads `XDG_CONFIG_HOME`, then `%APPDATA%\qinit`, falling back to `~/.config/qinit`. The sandbox therefore uses `XDG_CONFIG_HOME=C:\q\sandbox\config`; the seed lands at `C:\q\sandbox\config\qinit\seed`. |
| `QINIT_CORE=/c/q/core-lite` (Git Bash form) | works — MSYS converts path-shaped env vars before exec'ing the native exe; `doctor` shows `C:\q\core-lite/src/qpi/qpi.h` (mixed separators, cosmetic) |
| core-lite build recipe | the handoff's **Visual Studio `Qubic.sln` path does not produce a usable node**: `src\Qubic.vcxproj` defines `NO_RPC` (no HTTP controller, nothing for the CLI to talk to), and the three testnet defines are not enough — the release node also needs **`LITE_WASM_SC`** (`CMakeLists.txt:73` makes it a hard requirement of the wasm engine). The working recipe is core-lite's own CI job (`.github/workflows/dynamic-contracts.yml`, `windows-x64`): CMake + vcpkg static triplet, `-DTESTNET=ON -DTESTNET_LITE_RAM=ON -DTESTNET_PREFILL_QUS=ON -DLITE_WASM_SC=ON -DCMAKE_NO_USE_SWAP=ON -DADDON_TX_STATUS_REQUEST=ON`; no edit to `qubic.cpp` at all (the defines are CMake options). Script: `work\bin\build-core.sh`. vcpkg needs Strawberry Perl for openssl; that 150 MB download dropped once (curl error 56) and had to be pre-seeded with `curl --retry 8 -C -`. |
| node exe path | `C:\q\core-lite\build-win-static\src\Release\Qubic.exe` (15.7 MB), not `x64\Release\`. 0 compiler errors; ~25 min including vcpkg's openssl/libffi/c-ares/zlib/brotli. |
| core node boot through the CLI | `node run --runtime core --core-dir C:\q\core-lite --node-bin …` → ticking in **11.8 s**, epoch 229, 48 slots (`1bffb1ff` present), RSS ~3.5 GB |
| WASI SDK asset | **535 MB** on Windows (`wasi-sdk-29.0-x86_64-windows.tar.gz`), not the 119 MB the handoff quotes (that is the Linux tarball); 1.3 GB on disk; clang 21.1.4 |
| tmux | none; Ink TUIs were driven through a real ConPTY with `work\bin\tui.py` (pywinpty + pyte, keys in, rendered screen out). `winpty` cannot allocate a console from a headless shell. |
| qubic-cli / qlogging | not built (§4D optional rows skipped) |

Sandbox for every row: `QINIT_CACHE=C:\q\sandbox\cache`, `XDG_CONFIG_HOME=C:\q\sandbox\config`, `QINIT_CORE=C:\q\core-lite`,
`WASM_CLANG`/`WASI_SYSROOT` → `C:\q\wasi-sdk\wasi-sdk-29.0-x86_64-windows` (curl-fetched, see F75). Harness: `work\bin\env.sh`,
`lib.sh` (`run`/`runj`/`settle`), `phase-P2.sh`, `phase-P3.sh`, `phase-P4.sh`, `vault-probe.sh`, `epoch-issue.sh`,
`rights-probe.sh`, `f64.sh`, `oracle_qlaunch.py`, `compare.py`, `tui.py`. One `node run --restart` per cell, `--offline`
after the first start.

## Summary

- **New: F75–F83** (9). Two are Windows platform divergences in the handoff's sense (F76 hand-off rejection, F77 CRLF
  scaffold), one is a Windows-only setup failure (F75), one is a runtime divergence surfaced by the product (F82), one is
  the repo's own test suite on Windows (F83), the rest are diagnostics (F78 false drift, F79 wrong "unreachable", F80
  `clean` report, F81 `ext install` marketplace id).
- **Fixed findings confirmed on Windows:** F59, F67, F68, F71, F72, F73 (and F24 for `seed --show` / `doctor`).
- **Open findings reproduced unchanged:** F22, F30, F57, F62, F65 (worse here), F66, F74; F7 (one-field output is a bare
  value) cost the harness two rows. F64 could not be reproduced (twice the kill landed before the first chunk; see §P7).
- **Withdrawn before filing:** one runtime divergence that was my own probe (an asset name with a lowercase byte — the
  campaign-6 `<U` trap in a new coat, §Probe errors).
- Four handoff recipes corrected (§Step 0): `.sln`/`NO_RPC`, missing `LITE_WASM_SC`, `QINIT_CONFIG`, the SDK size.
- **Post-fix re-run (§Re-run after the fixes):** F82 closed on all four cells, the P1 spec green everywhere, and the first full `bun test`
  count for Windows; two more filed from it — F84 (`node stop` reports failure for a stop that worked) and F85 (the suite needs ~19 GB).

### Fixed after the campaign (2026-09-06, commits `0b75d9c4` and `25e007da`; re-run in §Re-run after the fixes)

- **F75** — `downloadVerifiedAssetToFile` (`packages/core/src/cache/download.ts`): streamed to a `.part` under `<cache>/downloads`,
  three attempts with backoff, HTTP Range resume, sha256 on the stream; the SDK archive survives a failed run. Re-checked on this
  box: a `setup` killed after 75 s left a 66.6 MB `.part`, the rerun resumed from it.
- **F65** — `node run` reuses an env-configured or cached SDK before fetching (`packages/cli/src/ops/node-wasi.ts`); simulator start 4 s.
- **F76** — analyzer rules `qpi/unqualified-div` / `qpi/unqualified-mod` and a shared build gate (`packages/build/src/compile/build-rules.ts`)
  on both compilers, `verify` and `integrate`; system contracts are exempt (`contractKind: "system"`), `--no-build-rules` /
  `QINIT_BUILD_RULES=off` switch the user rules off. Re-checked: `Launch.h` now fails both compilers and `verify` at lines 281/284/296;
  the `QPI::` spelling builds at 49 371 / 12 931 B.
- **F78** — `versionDrift()` (`packages/cli/src/ops/node.ts`) compares two managed release refs only; `node status` on the
  `--core-dir`/`--node-bin` node now `versionDrift:false`, exit 0.
- **F79** — `RequestTimeoutError` / `RpcTimeoutError`, advance-route budgets above core's fast-forward caps (15 s / 30 s), and
  `tick`/`epoch advance` follow the tick after a timeout instead of reporting "unreachable". Re-checked: three `epoch advance`
  runs on the core node, no false diagnosis.
- **F82** — the simulator fires PRE/POST_RELEASE_SHARES and PRE/POST_ACQUIRE_SHARES with originator = tx signer and
  invocator = the calling contract (`packages/engine/src/qubic-simulator.ts`). Re-checked with `rights-probe.sh clang simulator`:
  `originatorIsB true`, invocator `EBAAAA…`, mode 1 `Take` = 0 — the core row.
- **F83** — shared `test-utils/cli.ts` (`runCli`: stdin closed, `QINIT_NO_UPDATE`, kill on timeout, 60 s budget) and a pruned
  import-style walk; the four files pass on Windows (9/9).
- Not addressed: F81 (skipped by request until the extension is published).

## Findings

### F75 — `qinit setup` cannot install the WASI SDK on this Windows box: 3/3 attempts die with "The socket connection was closed unexpectedly", while curl and a bare Bun `fetch()` of the same asset succeed

Severity: **high on Windows (no clang backend, no gtest, no `node run` without the F65 detour, and the message names nothing a developer can act on)**.

```
QINIT_CACHE=C:\q\sandbox\cache dist\qinit setup
# ✓ core headers    fetched qinit-v0.0.47  1.4s
# ✓ node binary     ready qinit-v0.0.47  4.5s
# ✗ WASI SDK        The socket connection was closed unexpectedly. For more…
# ✗ setup failed: … pass `verbose: true` in the second argument to fetch()      exit 1
#   attempt 1: 4m48s   attempt 2: 1m05s   attempt 3: 1m41s
curl -L -o wasi-sdk-windows.tar.gz https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-29/wasi-sdk-29.0-x86_64-windows.tar.gz
# http=200 size=535368492 speed=3.3 MB/s time=160 s
bun fetch-probe.ts        # the same URL, streamed with fetch(): DONE 535368492 bytes in 295 s
```

`downloadVerifiedAsset()` (`packages/core/src/cache/download.ts`) does one `fetch`, buffers the whole body in memory
behind a 60 s stall watchdog, and has no retry and no resume; the error it surfaces is Bun's raw socket message with a
hint (`verbose: true`) that a CLI user cannot apply. The Windows asset is 4.5× the Linux one, so a link that drops a
long transfer — this one also dropped vcpkg's Strawberry Perl download once (curl error 56) — kills `setup` every time
while never affecting the 18 MB node download. Control: the same `setup` with `WASM_CLANG`/`WASI_SYSROOT` pointing at the
curl-fetched SDK reports `WASI SDK ready … 2ms` and completes in 3.5 s; `doctor` is 3/3 green; `clean` then `setup` from
nothing takes 8.6 s. Workaround for the next tester: `curl -L --retry 8 -C -` the tarball, `tar xzf` it, export the two
variables. (`node run` later fetched the same 535 MB successfully in 300 s — F65 below — so the failure is not the URL.)

### F65 (Windows extension) — `node run` still fetches the managed SDK although the env SDK was accepted: **5 min 00 s** for a first simulator start, 1.3 GB written to the cache, and this download succeeded where `setup` failed 3/3

```
node run --runtime simulator --tick-ms 100 --json
# real 5m0.4s   → {"ok":true,"runtime":"simulator (in-process)","tick":"3022",…}
du -sh C:\q\sandbox\cache\wasi-sdk   # 1.3G  (wasi-sdk-29.0-x86_64-windows)
```

Same cause as on Linux (`node-run.tsx` calls `fetchWasiSdk()` unless `--offline`), but on Windows the cost is five minutes
and 1.3 GB, and `--offline` is the only way to avoid it. With the SDK cached, later starts take ~12 s (core) / ~5 s
(simulator). Every later row in this ledger uses `--offline`.

### F76 — a bare `div(sint64, sint64)` passes `qinit verify` and builds on both backends, but Core's Windows build rejects it: MSVC resolves the unqualified call to the CRT's `lldiv_t div(long long, long long)`

Severity: **medium (loud rejection at the hand-off, Windows-only, and every Qinit gate says the contract is fine)**.

```
# Launch.h, END_EPOCH:
locals.shares = div(smul(state.get().round.totalShares, state.get().investors.value(locals.idx)), state.get().round.raised);
locals.fee    = div(smul(state.get().round.raised, LaunchFeeBps), sint64(10000));

qinit verify contracts/Launch.h --json                     # {"ok":true}
qinit build  contracts/Launch.h --compiler clang           # ok · 49 371 B
qinit build  contracts/Launch.h --compiler typescript      # ok · 12 931 B
qinit integrate contracts/Launch.h --asset QLNCH --construction-epoch 200 --out C:\q\core-lite-int   # ok, index 30, branch qinit/launch
cl /Zs /std:c++20 /EHsc /I src /I . /D NDEBUG /D _CONSOLE /D NO_RPC src\qubic.cpp      # the VS project's own flags
# src\contracts/Launch.h(281): error C2440: '=': cannot convert from 'lldiv_t' to 'QPI::sint64'
# src\contracts/Launch.h(284): error C2440: '=': cannot convert from 'lldiv_t' to 'QPI::sint64'
```

Oracle: `qubic.cpp:17` includes `<cstdlib>`, and the Windows UCRT declares `inline lldiv_t div(long long, long long)` in the
**global** namespace (`ucrt\stdlib.h:378`); with `using namespace QPI;` the non-template exact match beats `QPI::div<T>`.
On Linux the `long long` overload lives only in `std::`, so the same header builds — which is why six Linux campaigns never
saw it. Control: spelling the three helpers `QPI::div` / `QPI::smul` / `QPI::mod` removes both errors (the 63 remaining
errors are the `/arch:AVX2` mining static-assert, unrelated to contracts). Core's own contracts call bare `div(` 257
times but always with an unsigned second operand (`676ULL`, `10000000ULL`), which never matches the CRT overload. Neither
`contractverify` nor either backend warns; the campaign-1 prompt's "bare and `QPI::`-qualified spellings" row was the right
instinct and this is the platform where it bites. Fix nothing; recorded for the compiler owner (a verify rule or a backend
warning for unqualified `div`/`mod` with two signed 64-bit operands would catch it before the hand-off).

### F77 — a CLI built on Windows scaffolds contracts and tests with CRLF line endings, from a checkout whose template assets Git converted; the released Windows binary scaffolds LF, and the same project then mixes LF (README, `.gitignore`, `qinit.json`) and CRLF (`.h`, `.test.ts`, `.test.cpp`)

Severity: **low (cosmetic/team-workflow; the scaffold's bytes differ from Linux and from the release, git warns on the first commit)**.

```
git ls-files --eol packages/build/src/assets/templates/counter.h     # i/lf  w/crlf   (system core.autocrlf=true)
bun run build:bin && dist\qinit new Tcounter
file Tcounter\contracts\Tcounter.h      # C source, ASCII text, with CRLF, LF line terminators   (39 CR bytes / 40 lines)
file Tcounter\README.md Tcounter\qinit.json       # ASCII text (LF)
git add -A   # warning: in the working copy of 'contracts/Tcounter.h', LF will be replaced by CRLF …  (×4 files)
```

The templates are embedded at build time with `import … with { type: "text" }`, so whatever Git checked out is what the
binary emits; the repo has no `.gitattributes`. Controls: the **released** `qinit-cli-v0.1.12` Windows exe (fetched with
`install.ps1`'s URL, 102 MB, 19 s) scaffolds the same template with **0 CR bytes**, the locally built one with 39 — so a
developer who builds from source on Windows ships different bytes than the release; and build hash and `verify` are
identical for the CRLF and an LF copy (`3812398b…`, typescript backend), so nothing downstream is wrong — only the bytes
and the noise. `integrate` writes `src/contracts/<Name>.h` with LF into a Core checkout whose `.vcxproj` files are
BOM+CRLF (it preserves those), so the Core-side `git add` warns too. A `.gitattributes` pinning the template assets to LF
would make the Windows-built CLI scaffold the same bytes as the Linux one.

### F78 — `node status` reports a false "headers/node version drift" (and exits 1) for a node launched with `--node-bin` from a `--core-dir` checkout

Severity: **low–medium (a healthy node fails every scripted health check; the advice "run `qinit setup`" is wrong)**.

```
node run --runtime core --core-dir C:\q\core-lite --node-bin C:\q\core-lite\build-win-static\src\Release\Qubic.exe
node status --json
# {"up":true,"ticking":true,"fault":null,"headersVersion":"local","nodeVersion":"qinit-v0.0.47","versionDrift":true,
#  "error":"⚠ headers/node version drift — run `qinit setup`"}        exit 1
```

Headers and node come from the same `develop` checkout, so there is no drift; `status` compares the `local` headers label
with the cache pointer's `nodeVersion` (the last *downloaded* node) instead of with the binary it actually launched.
`qinit setup` would make it worse (it would fetch `qinit-v0.0.47`, which lacks the F73 fix). Control: the simulator node
reports `versionDrift:false`, exit 0. This is the other half of F56 (`doctor` blind to real drift; `status` loud about
imaginary drift). Every core cell in this ledger therefore shows `node-status exit=1` on a node that is fine.

### F79 — `qinit epoch advance` can fail with "node unreachable … is it running?" on a healthy core node when its 10 s `advance-tick` request outlives the sprint to the last tick; the next attempt succeeds

Severity: **medium (a wrong diagnosis on the one command the campaign already knows is fragile; a script that trusts exit 1 restarts a good node)**.

```
epoch advance --json        # attempt 1, ~2 690 ticks from the boundary
# {"ok":false,"fromEpoch":null,"toEpoch":null,"error":"node unreachable at http://127.0.0.1:41841 — is it running? (qinit node run)
#   [request timed out after 10000ms: http://127.0.0.1:41841/live/v1/dev/advance-tick?n=134]"}     exit 1
epoch advance --json        # attempt 2, 2 s later
# {"ok":true,"fromEpoch":229,"toEpoch":230}                                                          exit 0
```

Seen on **4 of 11 attempts across 8 core advances** (one advance needed four calls: three "unreachable", then
`switched`); a core advance takes ~100 s wall here, 36–48 s on the simulator. The route is alive — `tick --json` answers
during the sprint — but `LiteRpc.get()` uses `fetchWithTimeout(…, 10000)` and maps every failure to "unreachable".
Control: the simulator switched on the first call every time. With the F73 fix active the advance itself is sound
(F68/F73 closed, §Verified), so this is now the loudest remaining sharp edge of `epoch advance`.

### F80 — `qinit clean` on an empty cache reports `killed:true` ("stopped a running node first") for a node it does not track and did not stop

Severity: **low (misleading report; the promised "never kill by image name" holds, but the report contradicts it)**.

```
QINIT_CACHE=C:\q\sandbox\cache2 qinit clean --json      # cache2 has no active-node-scratch; cache1's core node is running
# {"ok":true,"total":19418006,"items":[…],"killed":true}
tasklist /FI "IMAGENAME eq Qubic.exe"                    # cache1's node: still running, pid unchanged, ticking
```

`wipeCache()` sets `killed = nodeAlive()`; with no tracked pid, `nodeAlive()` on Windows falls back to
`tasklist … Qubic.exe` (`ops/node.ts:109`), which sees the *other* cache's node, so the report says "stopped" while
`killNode()` correctly did nothing. Control: with no `Qubic.exe` anywhere the same command reports `killed:false`.

### F81 — `qinit ext install` fails on every machine that has VS Code: the marketplace id it installs (`qinit.qpi-vscode`) does not exist, VS Code's reason is swallowed, and `--json` reports `ok:false` with no `error`

Severity: **medium (the documented editor path is dead on arrival, silently)**.

```
qinit ext install --editor code --json
# {"ok":false,"editor":"code","source":"marketplace (qinit.qpi-vscode)"}      exit 1   (no error key)
qinit ext install --editor code
# [install failed]  editor code · source marketplace (qinit.qpi-vscode)   Installing extensions…   exit 1
code --install-extension qinit.qpi-vscode
# Extension 'qinit.qpi-vscode' not found. Make sure you use the full extension ID, including the publisher …
```

Control: `qinit ext install --vsix packages\vscode\qpi-vscode.vsix --editor code --json` → `{"ok":true,…}` and
`code --list-extensions` shows **`qubic.qpi-vscode`** — the packaged publisher is `qubic`, the id the CLI asks the
marketplace for is `qinit.…` (`packages/vscode/package.json` says `"publisher": "qinit"`). Whether the extension is
unpublished or published under `qubic`, the CLI's id is wrong and its failure path drops VS Code's one useful line.
Probably not Windows-specific (VS Code 1.124.2 here); recorded because P8 is the phase nobody had reached.

### F82 — inside `PRE_RELEASE_SHARES`, the simulator's `qpi.originator()` and `qpi.invocator()` are both zero while core's are the transaction's user and the acquiring contract, so a contract that releases management rights "only to the owner who asked" works on core and returns `INVALID_AMOUNT` on the simulator

Severity: **medium (silent runtime divergence in the QPI family campaign 6 filed as F69 and withdrew; the product's vault fails on every simulator cell and passes on both core cells)**.

Minimal probe (`work\p2\probes\RightsMgr.h` + `RightsTaker.h`, runner `rights-probe.sh`, one fresh node per cell): the
manager issues 1 000 `RGHTS`, gives user **b** 400, and records what its `PRE_RELEASE_SHARES` sees when the taker (at the
higher slot) calls `qpi.acquireShares(asset, b, b, 100, 29, 29, 0)` signed by **b**; `allowMode 0` allows always (the
campaign-6 F69 probe), `allowMode 1` allows iff `qpi.originator() == input.owner` (the product).

| cell | mode 0 `Take` | mode 0 callback saw | mode 1 `Take` | mode 1 callback |
|---|---|---|---|---|
| clang × core | **0** (rights moved) | `originator == b` **true**, `invocator ==` the taker contract's id (`EBAAAA…`), `owner == b`, `otherContractIndex 30`, post-callback 1 | **0** (rights moved) | `allowed 1`, post-callback 2 |
| clang × simulator | 0 (rights moved) | `originator ==` **zero**, `invocator ==` **zero**, `owner == b`, `otherContractIndex 30`, post-callback 1 | **INVALID_AMOUNT** | `allowed 0`, no post-callback |
| typescript × simulator | 0 | zero / zero / `owner == b` | **INVALID_AMOUNT** | `allowed 0` |

So the rights family itself agrees on both runtimes (mode 0, which is all the F69 probe tested), and the callback's
*context* does not: core follows `doc/contracts.md` ("for system procedures 6 to 9, `qpi.invocator()` returns the
contract ID of the contract calling `qpi.acquireShares()`"; `originator()` is the user who triggered the chain), the
simulator fires the sysproc with `registry.fire(contract, SYSPROC, spId, request.bytes, { entryPoint })` and a
system-procedure context whose `originator` is `ZERO32` (`packages/engine/src/qubic-simulator.ts:596-690, :945`).

Product-level evidence, `vault-probe.sh` (CLI only) and the P1 spec:

```
# Launch@30 issued QLNCH at the boundary; b holds 1 000 000 shares managed by 30; Vault@29 pulls 100 in;
# Launch's PRE_RELEASE_SHARES allows iff qpi.originator() == input.owner
clang × core            Vault.Stats.lastResult = 0     VaultLocked(b)=100   Holdings(b,30)=999900   Holdings(b,29)=100
clang × simulator       Vault.Stats.lastResult = -9223372036854775808 (INVALID_AMOUNT)   VaultLocked(b)=0   Holdings(b,30)=1000000
typescript × simulator  the same INVALID_AMOUNT, VaultLocked(b)=0
P1 spec "vault: lock … release after the lock":  core 2/2 cells pass, simulator 2/2 cells fail
```

The simulator's trace shows the callback did run (`Launch` sysproc entry 5 at the lock's tick, 0 diff rows) and refused.
A vault, an escrow, or any contract that checks *who is asking* before releasing rights therefore cannot be developed on
the simulator. Fix nothing; the engine owner should pass the originator and the caller's contract id into the
management-rights callbacks the way `invokeProcedure` already threads `originator`.

### F83 — six of the repo's own CLI tests fail on Windows: the CLI they spawn is still running when the 5 s test budget expires, and the temp-dir cleanup then hits `EBUSY`

Severity: **low–medium for the product, high for anyone gating a Windows CI on `bun test`** (the failures are all in the harness's spawn shape, not in the command under test).

```
bun test packages/cli/tests/commands/new.test.ts packages/cli/tests/commands/pickers-cli.test.ts \
         packages/cli/tests/commands/state-dump-cli.test.ts test-utils/import-style.test.ts
# (fail) intercontract scaffold relies on workspace discovery, not config callees [5012 ms]   this test timed out after 5000ms
# error: EBUSY: resource busy or locked, rm 'C:\Users\Admin\AppData\Local\Temp\qinit-new-5hW9Kv'   (afterAll → "(unnamed)" fail)
# (fail) a picker refuses to prompt without a terminal … [5014 ms]      expect(exitCode).toBe(1)  Received: null
# (fail) a picker reports an unknown name with a failing exit status    Received: null
# (fail) state --dump --json writes the state and reports the file       expect(0)  Received: null
# (fail) state --dump --json reports a failure and exits nonzero         Received: null
#  4 pass / 6 fail, "killed 1 dangling process" after each
```

`exitCode: null` at 5 s means the spawned `bun packages/cli/src/index.tsx …` had not exited; a cold `bun run index.tsx
--version` takes 1.4–2.1 s here (0.8–1.1 s for `dist\qinit.exe`) with stdin closed and exits 0, so it is not the
start-up cost but whatever these four files do next (an in-process node, a scaffold in `%TEMP%`, a picker) that never
finishes on Windows inside the budget, and the still-running child keeps the temp directory locked (`EBUSY` is the
Windows shape of "file in use"). Control: the same commands work through the compiled binary in this campaign (`state
--dump --json` returned in ~1 s on every cell; `new` × 5). Not root-caused; recorded so a Windows CI run is not read as
six product regressions. The full `bun test` run is in §Suite counts.

### F84 — `qinit node stop` on a core node reports `stop failed · node still alive (pkill failed)` (exit 1) for a node it did stop: the pid is dead, so the check falls back to a `tasklist` image scan that still lists the process while Windows tears it down

Windows only (found in the post-fix re-run, §Re-run after the fixes). Repro 2/2, `C:\q\work\p7\node-stop\`:

```
qinit node run --restart --runtime core --core-dir C:/q/core-lite --node-bin $NODE_BIN --offline --json   # ok, tick 77700002
qinit node stop --json
# {"ok":false,"action":"stop","lines":[{"text":"node still alive (pkill failed)","ok":false}],"stopped":false,"wasRunning":true,
#  "error":"node still alive (pkill failed)"}                exit 1, after 686 ms (cycle 1) / 474 ms (cycle 2)
tasklist | grep -c Qubic.exe                                  # 0 — immediately after, and again 2 s later
qinit node status --json                                      # {"up":false,"error":"rpc: down (node not reachable)"}
```

Expected: `stopped ✓`, exit 0 — the node is gone and nothing is left to stop. Actual: a failure report and exit 1, so a script
that stops the node between cells (`set -e`, or `runj node-stop … || exit`) aborts on a successful stop.

Cause (`packages/cli/src/ops/node.ts`): `killNode()` runs `taskkill /F /PID`, polls `pidAlive()` until the pid is dead, then
**deletes the pid file**; `node stop` (`node.tsx:101-103`) then calls `nodeAlive()`, which has no tracked pid any more and falls
back to `tasklist /FI "IMAGENAME eq Qubic.exe"`. That snapshot still lists the 3.5 GB process for a few hundred milliseconds
after the kill, so the command reports "still alive" and, on Windows, calls it a `pkill` failure. Linux takes the `pgrep -x
Qubic` branch after `SIGKILL`, where the reap is immediate, so the window is much narrower there. The pid file is
correctly gone in both cycles, so the next `node run --restart` is unaffected — only the report and the exit code are wrong.

Fix (1 line of behaviour): let `killNode()` return whether the tracked pid died and trust that in `node stop`; or poll
`nodeAlive()` for up to ~2 s before declaring the stop failed, mirroring the wait `killNode()` already does for the pid.
Severity: wrong diagnostic (exit 1 on success); control: the same `stop` against the simulator reports `stopped ✓`.
**Fixed** in `b2e3700e`: `killNode()` returns whether the tracked pid died and `node stop` reports that; re-checked 2/2 on core and once on the simulator, `stopped:true`, exit 0.

### F85 — the full `bun test` needs ~19 GB of private memory on Windows: one file, `packages/compiler/tests/gtest/contract-testing.test.ts`, takes the bun process from 1.5 GB to 14.4 GB working set / 18.8 GB private bytes, and the system commit charge reaches 37.0 of 42.7 GB — which is what killed both campaign runs, not a low-memory guard

Measured in the post-fix solo run (32 GB RAM, default 10 GB page file, nothing else on the box), sampled once a minute:

| moment | bun working set | bun private bytes | commit used / limit | free physical |
|---|---|---|---|---|
| entering `contract-testing.test.ts` (file 28 of the run) | 13.8 GB | 18.8 GB | 37.0 / 42.7 GB | 2.7 GB |
| peak, same file | 14.4 GB | — | — | 2.4 GB |
| next file | 1.5 GB | — | — | 17.0 GB |

The file alone was 9.2 GB in the campaign's solo run (§Suite counts), so ~9 GB of that peak is memory retained from the
27 files before it — `bun test` runs every file in one process. The campaign's two aborted runs died at exactly this file with
~5 GB of commit headroom less (a core node was up in the first). Not a defect in a contract or a command; it caps the suite
on any box with < ~24 GB of commit headroom and makes the Windows count depend on the page-file size. Suggested: run the
compiler gtest files in a separate `bun test` invocation on Windows (or per package, as CI's shards effectively do), and look
for what the earlier files keep alive (compiled wasm modules or simulator instances that are never released).

### Probe errors caught by controls (kept for the next tester)

- **An asset name with a lowercase byte.** The harness first hard-coded `22913013085521` as "QLNCH"; it decodes to `Q`
  followed by a lowercase `l`, which `issueAsset`'s `[A-Z][A-Z0-9]*` rule rejects with **0** on both runtimes. Because the
  spec packs `"QLNCH"` at run time (310366850129) and passed on the simulator, while the CLI harness failed on core, this
  looked for forty minutes like "issueAsset returns 0 inside END_EPOCH on Windows core" — a two-context probe with a
  *different* name per context then "confirmed" it. The trace's `hostCalls` show arguments but never the return value,
  so nothing on the CLI side could say "invalid name". Control that caught it: the same probe with one python-packed name
  in both contexts (`epoch-issue.sh`, typescript × core): procedure 1 000 000, END_EPOCH 1 000 000. Every script now
  computes the name with `sum(ord(c) << 8*i)`.
- **Killing by command-line pattern.** `taskkill` on `qinit.exe` processes whose command line matched ` call ` took out
  the harness's own `call --fn Vault Stats` mid-chain (the Windows twin of the handoff's "don't pkill your own shell").
  That cell was re-run.

## Previous findings on Windows

| # | status here | evidence |
|---|---|---|
| F22 `call --proc` without `--trace` → `out: null` | **open, same** | `Invest --amount 5000` → `{"ok":true,"out":null,…}`; with `--trace` → `"7500"` |
| F24 `--json` ignored | **fixed for `seed --show` and `doctor`** (documents with `ok`); `info --json` still has no `ok` | `seed --show --json` → `{ok, seed:null, identity:null, path:"C:\\q\\sandbox\\config\\qinit\\seed"}`; `doctor --json` keys `[checks,error,ok]`; `info --json` keys `[compiler,core,qinit,runtime]` |
| F30 restart discards everything | **open, same** | `ls` before restart `["Vault","Launch"]`, after `node run --restart` `[]` (core) |
| F57 `ls --json` no `ok` | **open, same** — and no `address`/`balance` either (F72 stopped at `deploy`/`call`/`state`) | keys `[deployed,nodeDown,system]`; per contract `[codeHash,feeReserve,name,slot,state,version]` |
| F59 scaffold gtest with zero assertions | **fixed** | 4 templates × 2 compilers: `2/2 passed`, exit 0, 8/8 runs (9–28 s each) |
| F62 `tick show` / `epoch show` | **open, same** | `unknown subcommand 'show'`, exit 1, both |
| F64 mid-upload lockout | **not reproduced** (twice inconclusive) | §P7 |
| F65 SDK re-download by `node run` | **open, worse** — see above | 5 min, 1.3 GB |
| F66 `.gitignore` misses `tests/.qinit/`, `package.json`; absolute `coreDir` | **open, same** | README-verbatim `qinit test` on Tcounter → `?? package.json`, `?? tests/.qinit/`; `qinit.json` carries `"coreDir": "C:/q/core-lite"`; the product repo's first commit shipped 4 629 lines of generated runtime. Second developer (§P6) builds fine because the path exists here; with `coreDir` removed and `QINIT_CORE` unset the build silently falls back to the cache's `qinit-v0.0.47` headers. |
| F67 struct hidden by a same-named procedure | **fixed, verified** | typescript: `type 'Lock' is hidden by a procedure or function of the same name; C++ requires the elaborated 'struct Lock' here…`; clang: `must use 'struct' tag to refer to type 'Lock'`; control `LockEntry` builds on both (4 392 B / 15 263 B) |
| F68 F10 wait at the boundary | **fixed, verified** (`TESTNET_LITE_RAM` node) | 0 `press F10` lines in every core `node.log`; every advance switched (some needed a second call only because of F79) |
| F71 simulator calendar pinned to 2024 | **fixed, verified** | `regYear/regMonth/regDay` = `26/9/5` on all four cells (real UTC date), and the two runtimes' 13 544-byte states differ in **3 bytes only**, all epoch-derived (§Verified) |
| F72 no contract identity or balance | **fixed for `deploy`/`call`/`state`** | `"address":"EBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGRAM","balance":"2250"` on all three, text and `--json`; P3 bug C is now visible (§P3); `ls` still lacks both |
| F73 inclusion dies after the advance | **fixed, verified** | after every advance: `Invest` runs (`out -1`, the round is closed — correct), a fresh `deploy` succeeds, P4's v2/v3 deploys land on core after a settlement (§P4), on both core cells |
| F74 stale generated client after a reorder | **open, same — on core too** | §P4: `treasury 0 / donations 1062` from the v1 client against v3, `1062 / 0` from `qinit call` |
| F7 one-field output struct is a bare value | design, but it cost two harness rows | `Holdings_output { sint64 shares }` → `"out":"500000"`, `Invested_output` likewise; `jq .out.shares` fails, `--args`/`--in` road unaffected |

## Friction ledger

| where | what a Windows developer meets |
|---|---|
| `setup` | F75 — three failed five-minute downloads before reading the code to learn about `WASM_CLANG`/`WASI_SYSROOT` |
| `node run` | F65 — the first start of *any* runtime is a 5 min, 1.3 GB download the developer already has |
| `node status` on a `--node-bin` node | F78 — exit 1 on every healthy check; every cell script had to ignore it |
| `epoch advance` on core | ~100 s wall (sprint ≈ 2 690 ticks + transition), and F79 on a third of the attempts |
| `jq` from winget | not on PATH in an already-open shell (`WinGet\Links` is not created for it; the exe lives under `WinGet\Packages\jqlang.jq_…`) |
| `winpty` for the TUIs | asserts `cols > 0 && rows > 0` in a headless shell; a ConPTY driver (`tui.py`) was needed for every frame in this ledger |
| Ink TUIs in a pipe | `debug` renders static frames and never exits (`exit 124` under `timeout`); `explorer` refuses (`explorer is interactive — run it in a terminal`, F23/F25) |
| `--json \| jq` | a pipe returns jq's status: `tick show --json \| jq -e .ok` → 1 with `PIPESTATUS[0]=1` — both wrong for the same reason, so the row is only informative with `$PIPESTATUS` |
| `--in` per-token schema | works for `id, uint16` and `uint64, sint64×3` mixes (same bytes as `--args`, §Verified) |
| trace `hostCalls` | arguments only, no return value — an `issueAsset` that returned 0 looks identical to one that returned 1 000 000 (§Probe errors) |
| `state --all --json` | containers load (`status: loaded`, `occupiedSlots 3`, `totalEntries 3`, rendered `lines`) but the `population` key is always `null` — a script that reads the documented name gets nothing |
| `integrate` | refuses a detached HEAD (`Core checkout has a detached HEAD`) and any branch other than `main` for a first integration (`contract 'Vault' is not registered on existing branch 'qlaunch-int'` — the campaign-3 message); refuses a dirty checkout after its own first write, so two contracts need a commit and a fast-forward between them; carries the *scaffold's* `tests/Launch.test.cpp` (the counter template) into `test/contract_launch.cpp` and only warns `references Vault without INIT_CONTRACT(Vault)` |
| `cheat-sheet` in a pipe | boxes render; `[6 · inspect]` merges three commands onto one line (as on Linux) |
| `qinit test --runtime simulator` from a clone in `C:\q\Dev Two\qlaunch` | works (path with a space), 1m40s |
| Git line endings | `core.autocrlf=true` from Git for Windows' installer is system-wide; `python` text mode rewrites LF→CRLF, so every `diff` in the harness is `diff --strip-trailing-cr` |
| `qinit debug` for a system procedure | the frame list shows `sys#2 (END_EPOCH)` on the Windows console, but the frame's host calls (`transferShares -8446744073709`, the bug-B smoking gun) had to be read from `/live/v1/debug-trace` — the ConPTY driver's one arrow key selected the neighbouring `Info` frame; the raw ring is the reliable road for a report |

### Harness gotchas that still apply on Windows (the handoff's list, extended)

- **One node per port, and the CLI knows it.** After an orphaned simulator was left on 41841, every `node run --restart`
  answered `http://127.0.0.1:41841 is served by an untracked simulator node; stop it or choose another --rpc` and every
  later command in that script silently ran against the *orphan* — good diagnostic, but a harness that does not stop on a
  failed `node run` produces a whole cell of wrong numbers. Check `node run`'s exit before the first deploy.
- PowerShell output carries `\r`: a PID list piped into `taskkill /PID` fails silently unless passed through `tr -d '\r'`.
  Killing a chain's bash from the tool wrapper appends the wrapper's own `exit=` line to the log, which releases anything
  waiting on that marker — chain on a unique final marker, never on `^exit=`.
- `taskkill /IM qinit.exe` is the Windows twin of `pkill Qubic`: it takes the harness's own in-flight command with it.
- Four probes in parallel on one node plus the repo's `bun test` pushed the box into the OS low-memory guard, which killed
  everything at once; run the node-bound chains alone.

## Verified correct on Windows (oracle-checked, no defect)

| what | oracle | result |
|---|---|---|
| P2 round, all four cells (`phase-P2.sh`, `oracle_qlaunch.py`) | a Python replay of the action script | **29/29 agree** on clang×core, clang×sim, ts×sim, ts×core: `Register` 1 / −1 (by `--args` / by `--in`), `Invest` 5000/3000/2000/−2, `Invested` 5000 by both roads, deltas owner +7 750 · b −5 000 · c −3 000 · d −2 000, shares 500 000/300 000/200 000, treasury 2 250, contract balance 2 250, settledMask 1, historyCount 1, state 13 544 B |
| P1 spec on core | 64 `expect()`s derived on paper | clang × core **8/8**, typescript × core **8/8** — register, refunds, settlement, donation via a plain transfer, vault lock/release, failed round + `Claim` |
| same value by two roads | `--args` vs `--in` | `Register`, `Invested`, `Holdings` (`<ID>id, 30uint16`) produce identical results on every cell |
| cross-compiler state | byte compare of `state --dump` | clang vs typescript: **0 differing bytes** on core and on the simulator; `state --digest` identical per runtime (`221a2739…` core, `8e5231c6…` sim) |
| cross-runtime state | byte compare | core vs simulator: **3 bytes** (offsets 80, 11520, 11528 = `deadlineEpoch` 229 vs 1, its copy in the `history` record, and the Collection priority = epoch); every other byte, including the six date bytes, identical |
| IDL across backends | canonical JSON | Launch 12 077 B and Vault 4 540 B byte-identical between clang and typescript; state size 13 544 (v2 13 608 = +64 for `Array<sint64,8>`) |
| dates (F71) | `date -u` | `26/9/5` on both runtimes, all cells |
| `issueAsset` in END_EPOCH vs a procedure | `epoch-issue.sh`, one valid name | typescript × core: 1 000 000 / 1 000 000, possessed 1 000 000 / 1 000 000; clang × core: procedure 1 000 000 |
| management-rights transfer itself | `rights-probe.sh` mode 0 | `acquireShares` moves 100 of 400 shares on core and on the simulator, both backends; `PRE`/`POST_RELEASE_SHARES` fire once each |
| Windows core node lifecycle | `node.log` | 0 F10 lines, `EPOCH TRANSITION: COMPLETE` once per advance, inclusion after the advance (F73), 11.8 s boot, a v2 deploy over a settled state (§P4) |
| `strip` / `--production` | source + IDL | `strip` removes both `CC_PRINT` (leaves the `;`); `--production` builds 46 217 B / 12 825 B with `cheats: 0` vs 49 371 B / 12 931 B with 2 |
| second developer, path with a space | build hashes | `C:\q\Dev Two\qlaunch`: typescript `75c6cb6d…`, clang `43732fe4…` — the same hashes as the original location |
| `integrate` | Core checkout diff | Vault → index 29 on `qinit/vault`, Launch → index 30 on `qinit/launch`; `contract_def.h` three sections, `Qubic.vcxproj(.filters)` BOM+CRLF preserved, `src/contracts/*.h` with cheatcodes stripped |
| documented examples | `--help` parse | 13/14 (the 14th is the guide's intentional `--not-a-real-flag`), as on Linux |
| explorer / debug / call TUIs | ConPTY frames | overview (tick, epoch, mempool, recent ticks), contracts, wallet tabs render; `debug` lists the frames of a whole round (`sys#0 INITIALIZE … proc#1 Register … sys#2 END_EPOCH … fn#3 Holdings`) with the selected frame's `in`/`out`/`state` pane; `call` shows the registry loader — Ink works on the Windows console |
| scaffold README on core | `qinit test --runtime core` on Tcounter | 1 pass / 0 fail / 4 expect, `Tcounter @ 29`, 12 s |
| `ext install --vsix` | `code --list-extensions` | installs `qubic.qpi-vscode` |

## P0 — Day 0 (typescript and clang × simulator, one node)

| row | result |
|---|---|
| `bun install` + `build:bin` | 12 packages, 2.2 s; binary 102 MB in 3.2 s |
| `setup` into an empty cache | headers 1.4 s, node 4.5 s, verifier ok, **WASI SDK fails** (F75) |
| `setup` with the env SDK | 3.5 s, all green; `doctor` 3/3 |
| `node run --runtime simulator --tick-ms 100` | 5 min 00 s (F65), then ticking at 3022, 4 slots (`qinit-v0.0.47` headers) |
| `new` × 4 templates | all six files each (+ `Counter.h` for intercontract), exit 0; every `.h`/`.test.*` CRLF (F77) |
| README followed verbatim on Tcounter (`qinit test --runtime simulator`) | 1 pass / 0 fail / 4 expect, `Tcounter @ 29`, 5.6 s; then `?? package.json ?? tests/.qinit/` (F66) |
| gtests (F59) | 8/8 runs `2/2 passed`, exit 0 |
| `--json` rows | `ls` no `ok` (F57); `tick show`/`epoch show` rejected (F62); `seed --show` a document (F24 fixed); `info` no `ok`; `system ls` ok; `node status` ok |
| released exe as a control (`install.ps1`'s URL, `qinit-cli-v0.1.12`) | downloads in 19 s, `new` scaffolds LF (F77 control), no `tests/*.test.ts` (doc drift as on Linux) |

## P1 — the product, test-first (`Launch.h` + `Vault.h`, spec `tests/Launch.test.ts`, 8 tests / 59–64 `expect()`s)

Edit → build cycles: (1) `VAULT_LOCK_TICKS` / `LAUNCH_*` rejected by the protocol gate on both backends ("names declared in
global scope have to start with state struct name (Vault)") — my bug, renamed `VaultLockTicks` / `LaunchRegisterFee`;
(2) both contracts build on both backends, IDLs identical. Two spec bugs found by the first run and fixed in the spec
(`broadcastTx` wants `tx.bytes`; `invokeProcedure` needs an explicit `tick` and `confirm`).

| test | clang×sim | ts×sim | clang×core | ts×core |
|---|---|---|---|---|
| fresh contract · register (fee, date, second round refused) · invest (below-minimum refunded) · epoch boundary settles (shares, fee, owner paid) · donation via a plain transfer · failed round + Claim · raw `callFunction` | pass ×7 | pass ×7 | pass ×7 | pass ×7 |
| **vault: lock rights into the vault, release after the lock** | **fail** (`VaultLocked(b)` 0) | **fail** | pass | pass |
| totals | 7 pass / 1 fail / 59 expects, 71 s | 7 / 1 / 59, 72 s | **8 / 0 / 64, 4m07s** | **8 / 0 / 64, 3m03s** |

The one failure is F82.

## P2 — users arrive

See §Verified: 29/29 on every cell. Per-cell wall time 115 s (clang×sim), 162 s (ts×sim), 238–241 s (core cells);
the epoch advance is 36–48 s on the simulator and 103–105 s on core.

## P3 — a bug report comes in (clang × simulator **and** clang × core, `phase-P3.sh`, one fresh node per bug)

The same three plausible bugs as on Linux, planted as one- or two-line patches (`work\bin\plant-bugs.py`), reproduced from
the CLI only. Both runtimes showed exactly the same thing, so one table:

| bug | what a developer sees first | did the CLI name the cause? |
|---|---|---|
| **C** refund forgotten on the below-minimum branch | `call --proc Invest --amount 50` → `ok:true, out -2, exit 0`, no state rows — a correct-looking rejection | **yes, now** — the same document carries `"balance":"1050"` while `Info` says `treasury 1000` (F72's fix): the 50 qu the contract kept are one field apart. `state --json` shows the same `balance`; `ls` still shows nothing (`balance: null`) |
| **B** pro-rata with `*` instead of `smul` (wraps `sint64`) | round settles, `status 2`, `treasury 126000`, and `Holdings(b)` is **0** instead of 10 000 000 000 000 | **yes** — the END_EPOCH frame in the trace ring: `issueAsset shares=10000000000000` then `transferShares shares=-8446744073709` (the wrapped product, named), then `transfer 875000`. `qinit debug` lists the `sys#2 (END_EPOCH)` frame on the Windows console (§Friction for the pane caveat) |
| **A** fee charged per investor, rounded up | owner is paid **971** where 973 is due; `treasury 1140` vs 1138 | **partly** — the `transfer … 971` host call is visible in the END_EPOCH frame, the shortfall is not; and in this variant the summed fee stays in the treasury, so contract balance (1140) equals `treasury` and nothing is stranded — only the spec's number tells |

## P4 — v2 and v3 in production, with users' money in the state (clang × simulator **and clang × core**)

On Linux this phase could not run on core at all (F73 blocked every deploy after the settlement). On Windows with the
`TESTNET_LITE_RAM` node it runs end to end on both runtimes, one fresh node each (`phase-P4.sh`): v1 deployed, a round
registered, funded by two investors (300 + 200 against a goal of 500) and settled at the boundary, then v2 and v3 deployed
over that live state.

| check | v1 | after the v2 deploy (sim / core) |
|---|---|---|
| `deploy` | slot 30, `43732fe4…` | ok, `ceb3e85d…`, no warning, on both |
| state size | 13 544 | **13 608** (+64, the `Array<sint64,8>`) on both |
| treasury · roundSeq · status · raised · historyCount | 1062 · 1 · 2 · 500 · 1 | identical on both |
| `recentFees[0]`, seeded by MIGRATE from the old treasury | — | **1062** (`state --json` container 4, `array`, capacity 8, 1 occupied) |
| the v1 image as a prefix of the v2 image (`cmp -n 13544`) | — | **identical** on both runtimes |
| MIGRATE frame in the trace ring | — | `kind 3, ok:true, 6 diff rows` (sim tick 6057, 0.67 ms; core tick 77702760, 14 ms) |

**F74 reproduced on both runtimes.** v3 swaps `treasury`/`donations` in `Info_output`; `deploy` succeeds silently (`074c0f68…`), and:

```
qinit call --fn Launch Info --json          # treasury 1062, donations 0        (the truth)
bun stale.ts 30   (the client generated before the upgrade)
# {"treasury":"0","donations":"1062","roundSeq":"1"}                             (silently swapped, sim and core)
```

The generated `Launch.ts` embeds no code hash (`grep codeHash` finds nothing), so it cannot know. Unchanged from Linux.

## P5 — Core hand-off

`integrate` twice into a worktree of core-lite `main` (`C:\q\core-lite-int`), then the VS project's own compiler flags on
`src\qubic.cpp` with `cl /Zs`: **F76**. With the three helpers qualified, no contract error remains.

## P6 — second developer / CI

Clone into `C:\q\Dev Two\qlaunch`: both backends build with the original hashes; `qinit test --runtime simulator` from the
clone 7/1/59 (same F82 failure); with `coreDir` deleted and `QINIT_CORE` unset the build still succeeds against the cache's
`qinit-v0.0.47` headers (F66 extension: a CI box silently tests against different headers than the developer).

## P7 — families nobody touched

`clean` on a throwaway cache (19.4 MB, F80), `setup` from nothing 8.6 s with the env SDK, `doctor --json` a document,
`--json | jq` exit codes, `explorer`/`debug`/`call` on the Windows console through ConPTY, the released exe as a control.
**F64** (`f64.sh`): a `deploy` killed 4 s in (clang) and again 3 s in (typescript) left **no** upload session in `node.log`
(the kill landed while the CLI was still building/verifying), and the next `deploy` succeeded both times (`armed: 2`);
so the lockout was neither reproduced nor disproved on this node — a repro needs the kill inside the chunk window.
**F30**: `ls` after `node run --restart` on core is `[]`, as on Linux.

## P8 — editor

F81; the vsix path installs.

## Compiler × runtime matrix

| value | clang×core | clang×sim | ts×core | ts×sim |
|---|---|---|---|---|
| P2 oracle agreement | 29/29 | 29/29 | 29/29 | 29/29 |
| regYear·regMonth·regDay | 26·9·5 | 26·9·5 | 26·9·5 | 26·9·5 |
| state size · digest | 13 544 · `221a2739…` | 13 544 · `8e5231c6…` | 13 544 · `221a2739…` | 13 544 · `8e5231c6…` |
| epoch advance attempts | 1 | 1 | 1 | 1 |
| P1 spec (pass/fail/expects) | 8/0/64 | 7/1/59 | 8/0/64 | 7/1/59 |
| vault lock (`acquireShares`, originator-gated) | 0 (moved) | INVALID_AMOUNT | 0 (spec) | INVALID_AMOUNT |
| `PRE_RELEASE_SHARES` sees originator / invocator | user / calling contract | zero / zero | — | zero / zero |
| P4 v2 MIGRATE · v3 stale client | ok · swapped | ok · swapped | — | — |

## Suite counts

| suite | result |
|---|---|
| `qinit gtest` × 4 templates × 2 compilers | 8 runs, each `2/2 passed`, exit 0 |
| `qinit test` Tcounter (simulator / core) | 1 pass / 0 fail / 4 expect, exit 0 — both |
| `qinit test` Tasset (core) | 1 pass / 0 fail / 6 expect, exit 0 |
| `qinit test` Launch spec | see matrix |
| `bun test` (repo, `WASM_CLANG` set, `QINIT_CORE` set, default cache), first run | **did not finish**: the OS low-memory guard killed it after ~25 min while a core node (3.5 GB) and the probe chains shared the box, at `packages/compiler/tests/gtest/contract-testing.test.ts`. Up to that point: **6 fail** (all F83, four files), 172 `PASS` gtest-style lines, no `skip` markers seen. The four failing files re-run alone: 4 pass / 6 fail, 34 s (F83). |
| `bun test`, solo re-run (nothing else on the box) | **did not finish either**: killed by the same low-memory guard after 26 files / 171 gtest `PASS` lines / **0 fail**, again right after `packages/compiler/tests/edge/fidelity-edges.test.ts`, i.e. entering `packages/compiler/tests/gtest/contract-testing.test.ts`. That file alone: `1 pass / 0 fail` in 27.9 s (`contract_qutil.cpp: 51 PASS · 0 FAIL`), but bun's working set climbs from 207 MB to **9.2 GB** while it runs (free memory 21.5 → 12.6 GB). Two runs, same spot: the suite's memory high-water mark plus whatever earlier files keep resident is what the guard trips on, so **no full-suite count exists for Windows from this session**; the only failures ever observed are the six of F83. Someone with a plain shell (no guard) should run `bun test` once and paste the totals here. |
| `bun run typecheck` | not reached (queued behind the killed run) |

## Re-run after the fixes (2026-09-06, `dist\qinit.exe` rebuilt from `25e007da`, CI green)

The product repo first had to change: the F76 gate now rejects `Launch.h`'s three bare calls (lines 281, 284, 296), so they are
spelled `QPI::div` / `QPI::mod` (uncommitted in `C:\q\Launch`; `Vault.h` needed nothing). Then the cells the fixes touched, the
P1 spec on both simulator cells and the rights probe on all four:

| value | clang×core | clang×sim | ts×core | ts×sim |
|---|---|---|---|---|
| P1 spec (pass/fail/expects) | 8/0/64 (campaign) | **8/0/64**, 39 s (was 7/1/59, 71 s) | 8/0/64 (campaign) | **8/0/64**, 39 s (was 7/1/59, 72 s) |
| vault lock (`acquireShares`, originator-gated) | 0 (moved) | **0 (moved)** (was `INVALID_AMOUNT`) | 0 (spec) | **0 (moved)** (was `INVALID_AMOUNT`) |
| `PRE_RELEASE_SHARES` sees originator / invocator | user b / taker contract | **user b / taker contract** | user b / taker contract | **user b / taker contract** |
| rights probe: mode 0 `Take` · mode 1 `Take` · release/post-release calls | 0 · 0 · 2/2 | 0 · 0 · 2/2 | 0 · 0 · 2/2 | 0 · 0 · 2/2 |

The rights probe's `Seen` document is byte-identical on the four cells (`originatorIsB:true`, `invocatorIsB:false`,
`lastInvocator:"EBAAAAAAAAAA"` = the taker at slot 30, `ownerIsB:true`, `lastOther:30`, `lastShares:"100"`). F82 is closed on
Windows; the P1 spec is green on every cell. Rows: `C:\q\work\p1\cells-postfix\`, `C:\q\work\p2\probes\rights\<cell>\`.

**Observed during the re-run (not in the fix list):** after the last core cell, `qinit node stop --json` answered
`{"ok":false,"stopped":false,"wasRunning":true,"error":"node still alive (pkill failed)"}` (exit 1) although the node was gone
a second later (no `Qubic.exe` in `tasklist`, port 41841 closed) and the pid file had already been removed. `killNode` waits
for the *pid* to die and deletes the pid file; `nodeAlive()` then has no pid and falls back to `tasklist … IMAGENAME eq Qubic.exe`,
which still lists a 3.5 GB process while Windows tears it down. Reproduced 2/2 and filed as **F84**.

### Suite counts after the fixes

| suite | result |
|---|---|
| `bun run typecheck` | steps 1–2 (what CI runs) clean; step 3 (`tsc -p packages/compiler/tsconfig.build.json`) needs `packages/core` and `packages/proto` built first (`bun run build` in each, CI's `node-dist` order) — with them built, **all three steps exit 0** |
| `bun test`, solo, `QINIT_CORE` + `WASM_CLANG`/`WASI_SYSROOT` set, default cache | **2860 pass / 38 skip / 22 fail / 192 841 expect() calls, 2920 tests across 350 files, 23 m 44 s**, exit 1 — the first complete Windows count. Every failure is attributed and fixed in the working tree: **21** are the F76 gate rejecting compiler-differential sources that spell `div`/`mod` bare on purpose (`calc-diff` 1, `fuzz-diff` 20 pinned seeds) — a regression of the fix that CI cannot see because those clang branches skip without a WASI SDK; `buildRules: false` now exempts the differential runner, the fuzz test and the two fuzz tools. **1** is `source-abi-mutation.test.ts` rewriting a core header with an LF-joined search string that never matches the checkout’s CRLF (`core.autocrlf=true`) — the handoff’s line-endings watch item; its two readers now normalise. The three files re-run alone: **27 pass / 0 fail / 99 expects, 92 s**. Peak memory during the run: F85. Log `C:\q\work\bun-test-full.log`. |
