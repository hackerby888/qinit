# Windows handoff — re-run the Qinit exploratory-testing campaigns on Windows

Goal: reproduce **all** the Qinit CLI/compiler exploratory testing (campaigns 1–6, the same
methodology and the same QLaunch product lifecycle) on **Windows**, from a clean machine, and report
what differs from the Linux runs. Everything below is a setup + execution guide; the *what to test* is
the two prompt docs plus the campaign plan, referenced in §5.

**The headline finding class on Windows is platform divergence:** a value or behaviour that differs
between the Windows and Linux cells (same compiler, same runtime) is a finding on its own, the same way
a clang-vs-typescript disagreement is. Re-verify the still-open findings (F1–F74) here, and file new
ones from **F75**.

> Accuracy note for whoever executes this: the author built and verified the Linux side only. Steps
> marked **[verify on Windows]** are the documented/expected recipe but were not run on Windows —
> confirm them and, if the real command differs, that difference is itself worth a line in the ledger.

---

## 1. What you are testing, and with which build

| Component | Source | Why from source (not a release) |
|---|---|---|
| **Qinit CLI** | `github.com/hackerby888/qinit` @ `main` | The released `qinit-cli-v*` predates the F46–F74 fixes; test the current `main`. |
| **core node** (`--runtime core`) | `github.com/hackerby888/core-lite` @ `develop` | The F73 fix (`0397da15`) is only on `develop`; no release carries it. Build it. |
| qubic-cli *(optional)* | `github.com/qubic/qubic-cli` @ `main` | Only the `cli-e2e` peer-protocol test needs it (§4D). |
| qlogging *(optional)* | `github.com/qubic/qlogging` @ `master` | Only the `qlogging-integration` test needs it (§4D). |

The **simulator** runtime (`--runtime simulator`) is built into the CLI — no external node needed.
The two-compiler axis is `--compiler clang|typescript`; clang comes from the WASI SDK that `qinit setup`
installs (§3B).

---

## 2. Prerequisites (install once)

1. **Git for Windows** — includes **Git Bash**. The campaign harness scripts (`env.sh`, `lib.sh`,
   `cell.sh`, and the core-lite `-fsyntax-only` check) are **bash**, not PowerShell; run them in Git
   Bash. (Memory: the syntax check needs bash, zsh/PowerShell won't split the flag vars.)
2. **Bun for Windows** — `powershell -c "irm bun.sh/install.ps1 | iex"`. Needed to build the CLI from
   source and to run `bun test`.
3. **Visual Studio 2022** with the **Desktop development with C++** workload (MSVC v143, Windows SDK).
   core-lite and qubic-cli are MSVC C++ builds. This is Qubic's native build platform.
4. **CMake** (≥ 3.20; ships with VS 2022) — for qubic-cli / qlogging only.
5. **Python 3** — the oracles (`oracle_qlaunch.py`, arithmetic models) are Python.
6. `jq` (optional, for the `--json | jq` rows) — `winget install jqlang.jq`.

Use **short, ASCII, space-free paths** (e.g. `C:\q\...`). Qubic core scatters files in the cwd and some
paths flow into generated build files; long/space paths have bitten this toolchain before.

---

## 3. Set up the Qinit CLI

### 3A. Clone + build from source
```powershell
git clone https://github.com/hackerby888/qinit C:\q\qinit
cd C:\q\qinit
bun install
bun run build:bin        # -> dist\qinit(.exe)   [verify on Windows: confirm the emitted name]
```
`dist\qinit` is the single CLI under test for the whole campaign — do not mix in a released binary.
(You can also `bun run dev -- <args>` to run from source, or install the prebuilt exe with
`irm https://raw.githubusercontent.com/hackerby888/qinit/main/install.ps1 | iex` as an *install-step*
control row, then discard it.)

### 3B. `qinit setup`
```powershell
dist\qinit setup
```
Fetches the core headers, a node binary, the **WASI SDK** (clang backend + `gtest`), and the contract
verifier into the per-user cache (`%LOCALAPPDATA%\qinit`). Windows release assets exist
(`qinit-windows-x64.exe`). **[verify on Windows]** and note anything that fails — an asset that doesn't
download on Windows is a finding (cf. the still-open **F65**: `node run` re-fetching the WASI SDK despite
the env being set).

To keep runs reproducible and off your real config, point the cache/config at a sandbox before each
campaign (as the Linux run did):
```powershell
$env:QINIT_CACHE = "C:\q\sandbox\cache"
$env:QINIT_CONFIG = "C:\q\sandbox\config"
```

---

## 4. Build the core node (and optional tools)

### 4C. core-lite `develop` — the node for `--runtime core`  ← the critical, non-obvious step
```powershell
git clone -b develop https://github.com/hackerby888/core-lite C:\q\core-lite
```
**You must uncomment three testnet defines in `src\qubic.cpp`.** On `develop` they ship **commented**
(they are intentionally local-only — never committed, because they'd break the repo's CI). Lines ~54–56:
```cpp
#define TESTNET
#define TESTNET_PREFILL_QUS
#define TESTNET_LITE_RAM      // <- also what activates the F73 fix (PAUSE_BEFORE_CLEAR_MEMORY -> 0)
// #define LITE_WASM_SC
// #define LONG_RUN_LOCAL_TESTNET
#define USE_SWAP              // already on; pages tick storage to disk. Comment it out to avoid disk I/O on a short run.
```
Why it matters:
- `TESTNET` + `TESTNET_PREFILL_QUS` = a local testnet with pre-funded identities.
- `TESTNET_LITE_RAM` = the ~7 GB "lite" buffers the campaign node used **and** the exact define the F73
  fix guards on: `#if ENABLED_LOGGING && !defined(LONG_RUN_LOCAL_TESTNET) && !defined(TESTNET_LITE_RAM)`.
  With it defined, `PAUSE_BEFORE_CLEAR_MEMORY` becomes 0 → no F10 operator wait at epoch transition →
  F68/F73 should be closed. Without it, you're not testing the fixed node.
- These are edits to `qubic.cpp`; **do not commit them** (memory: `qubic.cpp` also carries other local
  defines; the file is CRLF/LF-mixed — if you ever must diff it, use `diff -w`).

Build in Visual Studio: open `C:\q\core-lite\Qubic.sln`, set **x64 / Release**, Build. Output is the
Qubic node exe under the project's `x64\Release\` (e.g. `C:\q\core-lite\x64\Release\Qubic.exe`).
**[verify on Windows]** confirm the exact exe path from the `.vcxproj` output dir.

Run it through Qinit (keeps node + headers aligned):
```powershell
dist\qinit node run --runtime core --core-dir C:\q\core-lite --node-bin C:\q\core-lite\x64\Release\Qubic.exe
```
(`--core-dir` must contain `src\qpi\qpi.h`; core runtime *requires* `--node-bin`.) Run
`dist\qinit node run --help` for tick pacing on your build; for the **simulator** node the fast-tick knob
is `--tick-ms 0`. Watch specifically for the F68/F73 symptom: after `qinit epoch advance`, do
transfers/deploys/procs still get **included** (not just `ok:true`)? On the fixed node they must.

### 4D. qubic-cli + qlogging — optional, test-only
Needed only for `packages\engine\tests\integration\cli-e2e.test.ts` (peer-protocol client) and
`packages\engine\tests\logging\qlogging-integration.test.ts`. Both **skip** unless `QUBIC_CLI` /
`QLOGGING` point at a built binary. Nothing in the node runtime or the P0–P8 matrix needs them — skip
this section unless you want those two rows.

```powershell
# qubic-cli (needs the core submodule; rewrite its SSH url to HTTPS on a keyless box)
git clone https://github.com/qubic/qubic-cli C:\q\qubic-cli
cd C:\q\qubic-cli
git submodule set-url submodules/core https://github.com/qubic/core.git
git submodule update --init --recursive
cmake -B build -S . ; cmake --build build --config Release      # -> build\Release\qubic-cli.exe

# qlogging (CMake min-version is old; modern CMake needs the policy shim)
git clone https://github.com/qubic/qlogging C:\q\qlogging
cd C:\q\qlogging
cmake -B build -S . -DCMAKE_POLICY_VERSION_MINIMUM=3.5 ; cmake --build build --config Release  # -> build\Release\qlogging.exe
```
Windows caveats (all **[verify on Windows]**, each a candidate finding if it bites): the Windows binary
lives in `build\Release\<name>.exe` (Linux env vars encode `build\<name>`); qlogging sets
`COMPILE_WARNING_AS_ERROR` → MSVC `/WX`, untested here; and `cli-e2e.test.ts:48` writes a hardcoded
POSIX path `/tmp/qinit-cli-probe.bin` — on Windows that write may fail and silently keep the
signature-verify assertions skipped.

**dev-arbitrator variant** (only if you want the tick-signature-verify assertions to actually run):
the engine signs its dev committee with seed `"a"*55`; a stock qubic-cli can't verify it. Make the
"dev" binary with a **one-line edit** before building: in `defines.h` line ~18, change
`ARBITRATOR "AFZP…EPCVJ"` → `ARBITRATOR "BZBQFLLBNCXEMGLOBHUVFTLUPLVCPQUASSILFABOFFBCADQSSUPNWLZBQEXK"`.
Absent that, the tests still pass but cover less (they self-skip the verify rows).

### 4E. Environment (Git Bash form, mirrors the Linux `env.sh`)
```bash
export QINIT=/c/q/qinit/dist/qinit.exe
export QINIT_CORE=/c/q/core-lite
export QUBIC_CLI=/c/q/qubic-cli/build/Release/qubic-cli.exe    # optional
export QLOGGING=/c/q/qlogging/build/Release/qlogging.exe        # optional
# WASM_CLANG / WASI_SYSROOT: qinit setup installs the WASI SDK into the qinit cache; export them to the
# cache's clang++ / wasi-sysroot ONLY if a suite reports "skipped: WASM_CLANG not set". [verify path]
```
PowerShell equivalent uses `$env:QINIT_CORE = "C:\q\core-lite"`, etc.

---

## 5. What to test (the methodology is already in the repo)

All three live in the qinit clone — read them first, do not re-derive:

1. **`docs/testing-cli-developer-prompt.md`** — the CLI-developer role, the 7 ground rules
   (two compilers × two runtimes, same-value-two-roads, read the whole TUI frame, read core before
   calling a rule a bug, bound loops, counts-not-"passed", suspect the probe first), the loop, the probe
   families, and the full **F1–F64 known/fixed/open** list. Do not re-file those; extend them.
2. **`docs/testing-agent-prompt.md`** — the compiler/layout oracle companion (WAT diff, `parseContractIdl`
   round-trip, clang differential, negative controls).
3. **The QLaunch product lifecycle** — the campaign-6 plan (phases **P0–P8**: docs-as-oracle, test-first
   spec, users arrive, debug a planted bug, MIGRATE v2/v3, Core hand-off, second-dev/CI, families
   nobody touched, editor). Rebuild the same product (`Launch.h` launchpad + `Vault.h` share vault) and
   carry it through the phases, on Windows this time. Port the bash harness (an `env.sh` that exports the
   paths, a `lib.sh` with `run`/`runj`/`settle` helpers, a `compare.py`, an `oracle_qlaunch.py`) to Git
   Bash, paths → `/c/...`.

Run each phase across the four cells (`clang|typescript` × `simulator|core`), fresh node per cell, and
diff every quoted number against its oracle before believing it.

### Previous findings — do not re-file, extend

The full campaign ledgers (**F1–F74**, with every repro) are bundled into this clone at
**`docs/findings/TESTING-FINDINGS{,-2,-3,-4,-5,-6}.md`** — read them, they are the "already known" list.
F1–F64 are also summarised inline at the end of `docs/testing-cli-developer-prompt.md`. The campaign-6
findings (F65–F74), which no other committed doc lists, in one line each:

| # | finding | status |
|---|---|---|
| F65 | `node run` re-downloads the 119 MB / 390 MB-on-disk WASI SDK although `setup`/`doctor` accepted `WASM_CLANG`/`WASI_SYSROOT`, and nothing then uses it | **open** — high-value on Windows |
| F66 | scaffold `.gitignore` misses `tests/.qinit/` and `package.json`; `qinit.json` carries an absolute `coreDir` | **open** |
| F67 | TS backend built a struct hidden by a same-named procedure that clang + Core reject | **fixed this session** (`f10db311`) — verify it now rejects on Windows |
| F68 | `advance-epoch` on core can leave the node frozen at the epoch boundary waiting for F10; a 2nd `epoch advance` is the undocumented recovery | **open**, but the F73 fix (below) should close it — verify |
| F69 | ~~share-management rights return `INVALID_AMOUNT` on the simulator~~ | **withdrawn** — agree on both runtimes |
| F70 | ~~a plain signed transfer isn't included on the core dev node~~ | **withdrawn** — folded into F68 (the wedged node lost it) |
| F71 | simulator calendar pinned to 2024 while core returns the real date | **fixed this session** (`cf3fc4da`) — verify both read today's date |
| F72 | no command reports a contract's qu balance or its own identity | **fixed this session** (`51d41fd8`) — verify `deploy`/`call`/`state` show them |
| F73 | after `epoch advance` the core dev node keeps ticking "healthy" but permanently stops **including** any tx (reads still work) | **fixed** — core-lite `develop` `0397da15`; needs `TESTNET_LITE_RAM` (§4C) to be active |
| F74 | a generated client has no version guard → silently returns wrong values after a field reorder, while `qinit call` is protected | **open** |

For the four **fixed** ones, the Windows job is to confirm the fix holds on this platform; for the
**open** ones, extend with the Windows behaviour rather than re-filing.

---

## 6. Windows-specific watch list (most likely to diverge)

Prioritise these — they are where a platform difference is plausible:

- **Paths & the filesystem.** `qinit new`, `deploy`, `state --dump`, cache/config dirs, `.gitignore` the
  scaffold writes, `coreDir` resolution (`config.ts` has a `win32` branch — exercise it). Backslashes,
  drive letters, spaces, case-insensitivity. The "same workspace on Windows paths" row is called out as
  untouched in the prompt.
- **F71 (fixed) — dates.** `qpi.year()/month()/day()` now read the **real wall clock** on both the sim
  node and core. Confirm they agree on Windows and show today's date, not 2024.
- **F68 / F73 (fixed) — epoch node.** After `epoch advance`, confirm txs still get *included* and there
  are **0** F10-pause lines (needs `TESTNET_LITE_RAM`, §4C). If the node freezes, the fix isn't active —
  check the defines.
- **F65 — WASI SDK re-download**, **F30 — restart discards state**, **F64 — mid-upload lockout**: node/
  cache lifecycle rows, all platform-sensitive.
- **F72 (fixed) — identity + balance** now print on `deploy`/`call`/`state`. Confirm the 60-char identity
  and qu balance render on Windows (`--json` too).
- **TUIs** (`debug`, `explorer`, `dev`): Ink on the Windows console. Drive via tmux under Git Bash, or
  note if the TUI is unusable on `cmd`/PowerShell — that's a finding.
- **`--json | jq`** on every command: keys, **exit codes** (a pipe returns the pipe's status, not
  qinit's — check `$LASTEXITCODE` / `jq -e`), bigint-as-text.
- **gtest / `test`**: gated on the WASI SDK; report pass/**skip**/fail counts, never "passed".
- **Line endings**: git may check out CRLF on Windows. If a build or a byte-for-byte state dump differs
  only by `\r`, that's the cause, not a contract bug (compare with `diff -w`).

---

## 7. Reporting

New ledger: `docs/findings/TESTING-FINDINGS-7-windows.md` (alongside the bundled ones), numbering from
**F75**.
Per finding: minimal repro (contract + exact command in a fenced block); expected vs actual with the
oracle (the Linux cell, a C++/`qpi.h` rule, or a core source line); severity (silent wrong value/state >
wrong diagnostic > loud rejection of legal input > cosmetic); and a **control** — the Linux value, or
the other runtime/compiler behaving correctly. For a platform-divergence finding the control *is* the
Linux result, so record both cells' bytes. Finish each phase with the four-cell matrix and suite
pass/skip/fail counts.

Prior-session gotchas that still apply: source `env.sh` before any `cd` in Git Bash; don't `pkill`/
`pgrep` a pattern that matches your own shell; one `node run --restart` per core cell; `bun test` does
**not** typecheck — run `bun run typecheck` after touching any test file; and the real gate before
trusting a green run is `bun run build:bin`.
