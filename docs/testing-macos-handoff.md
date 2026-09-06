# macOS handoff — re-run the Qinit exploratory-testing campaigns on macOS

Goal: reproduce the Qinit CLI/compiler exploratory testing (campaigns 1–6 on Linux, campaign 7 on
Windows; the same methodology and the same QLaunch product lifecycle) on **macOS**, from a clean
machine, and report what differs. Everything below is setup + execution; the *what to test* and the
*how to report* are shared with the Windows handoff and referenced in §5 and §7 instead of copied.

**The headline finding class is platform divergence:** a value or behaviour that differs between the
macOS cell and the Linux cell (same compiler, same runtime) is a finding on its own. The Windows ledger
(`docs/findings/TESTING-FINDINGS-7-windows.md`, F75–F85) is the second control: every number it quotes
was oracle-checked. Re-verify the still-open findings here and file new ones from **F86**.

> Accuracy note: this document was written on the Windows box from the code, core-lite's CI recipe and
> the published release assets, then reviewed line by line against them — nobody has run it on a Mac
> yet. Every command whose body comes from a file or a fetched URL is cited; anything that depends on
> macOS behaviour that could not be checked from here is marked **[verify on macOS]**. If a real command
> differs, that difference is a line in the ledger. The Windows handoff shipped four wrong recipes (§0 of
> the Windows ledger); distrust any line here that has no `file:line` or URL behind it.

---

## 0. What macOS has already proved — read before deriving anything

More has run on macOS than the docs suggest. Do not spend cells re-establishing this:

| already exercised | where | what it proves |
|---|---|---|
| Node built and smoked on `macos-14` (Apple silicon) and `macos-15-intel` | core-lite `.github/workflows/dynamic-contracts.yml:30-37`, run of 2026-09-04 (`qinit-v0.0.47`) | the node builds with Xcode clang on both architectures |
| Qinit built from source on those runners and run against that node | same workflow `:486-517`; `scripts/core-compat/core-smoke.ts:92-165` | `smoke`, `node run --runtime core`, `doctor`, the TypeScript+clang × simulator/core QPI matrix ("QPI MATRIX OK"), `qinit test --runtime core --compiler clang` on `DigestProbe`, `state --digest`, `node stop` — all green; state digest identical to Linux and Windows |
| `bun test` from source on `macos-14` | qinit `.github/workflows/test.yml:78` (`lint-test`) | the unit suite passes with the same counts as Ubuntu; everything needing a WASI SDK or a node **skips** there |
| WASI SDK fetched, extracted and used on both Mac architectures | `wasi-sdk.ts:10-17`; the smoke's `doctor` line resolved to `~/.cache/qinit/wasi-sdk/wasi-sdk-29.0-<arch>-macos/bin/clang++` | the managed download and the bsdtar extraction work on both arches |

**Never run by anyone, on any Mac** (this is the new ground):

- the **shipped** `qinit-darwin-arm64` / `qinit-darwin-x64` binaries — cross-compiled on Ubuntu and
  published without being executed (`.github/workflows/release.yml:46-52`, comment: "ship unverified");
- `install.sh` end to end, `qinit setup` end to end (the 363 MB managed node download is only unit-tested),
  `qinit update`, `qinit uninstall`;
- the simulator runtime through the CLI (a compiled `qinit` re-executing itself detached, `ops/node.ts:268-297`);
- the Ink TUIs (`explorer`, `debug`, `dev`), `epoch advance`, the editor extension;
- the whole P0–P8 product lifecycle.

Also note for §4: the darwin nodes in the core-lite release (`qinit-v0.0.47`) are the binaries CI ticked,
but they **predate the F73 fix** (`0397da15`) and the 48-slot change (`1bffb1ff`); both are only on
`develop`. `git -C core-lite merge-base --is-ancestor 0397da15 qinit-v0.0.47` exits 1. So `qinit setup`
/ `node run` without `--node-bin` fetches a node that reproduces F68/F73 at the first `epoch advance`.

---

## 1. What you are testing, and with which build

| Component | Source | Why |
|---|---|---|
| **Qinit CLI** | `github.com/hackerby888/qinit` @ `main`, built locally → `dist/qinit` | the released `qinit-cli-v0.1.12` (2026-08-29) is more than 120 commits behind (`git rev-list --count qinit-cli-v0.1.12..HEAD`) and lacks the F65/F75/F76/F78/F79/F82/F84 fixes |
| **core node** (`--runtime core`) | `github.com/hackerby888/core-lite` @ `develop`, built locally (§4) | only `develop` carries the F73 fix; the release node does not |
| released `qinit-darwin-*` | `qinit-cli-v0.1.12` assets | **control rows only** (§3B): first execution ever of the shipped Mac binaries |
| qubic-cli / qlogging *(optional)* | as in the Windows handoff §4D | only two engine tests need them |

The clone must contain `d7486d1e` (the ledger commit with F84/F85; the F84 fix `b2e3700e` and the
suite fixes `2345c637` are its ancestors): `git -C ~/q/qinit merge-base --is-ancestor d7486d1e HEAD; echo $?`
must print `0`. On an older checkout, `node stop` reporting `stopped:false` is F84 and 21 compiler
differential/fuzz test failures under a WASI SDK are the pre-`2345c637` gate regression — not new findings.

The **simulator** runtime is built into the CLI. The compiler axis is `--compiler clang|typescript`;
clang comes from the WASI SDK `qinit setup` installs (§3C).

**Which Mac.** Run the deep campaign on **macOS 26 (Tahoe) on Apple silicon**, because Sonoma on arm64
is the environment CI already exercises (§0), and the newest release is where the OS policies in §6
(Gatekeeper, the application firewall, the Terminal) are most likely to have moved **[verify on macOS]**.
If a second Mac or a VM is available, keep a Sonoma cell as the control for anything that differs;
otherwise the CI smoke on `macos-14` is the partial control. Cover the **darwin-x64 artefacts** from the
same machine with a Rosetta cell (§5.1, §6.6).

---

## 2. Prerequisites (install once)

1. **Xcode Command Line Tools** — `xcode-select --install`. The node is compiled with whatever
   `xcrun -f clang` resolves (`dynamic-contracts.yml:246-247`); CI has proven AppleClang 15 (Xcode 15.4)
   and 17 (Xcode 16.4). An AppleClang from a Tahoe-era Xcode is untested **[verify on macOS]** — if the
   configure or the drogon build fails, record the compiler identification line.
2. **Homebrew**, then the CI's dependency list plus the harness tools:
   ```bash
   brew install cmake nasm jq jsoncpp fmt boost lz4 zstd lzo zlib    # dynamic-contracts.yml:164, verbatim
   brew install bash tmux python                                       # harness: bash 5 (mapfile), tmux (TUIs), python3 (oracles)
   ```
   Not `openssl`, `c-ares`, `brotli`: the testnet node speaks no TLS and the CI disables them. Not
   `libffi`: CI builds 3.4.6 from source at the deployment target (§4B); a brewed libffi would be
   found (`CMakeLists.txt:52-56`) but that path was never exercised.
3. **Bun 1.3.14 exactly** — `curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"`. It is the pin
   in `config/toolchains.json:3` and in every CI workflow; nothing in `package.json` rejects a newer Bun,
   so check `bun --version` yourself. Install it from a native shell: the installer picks the
   `darwin-aarch64` build whenever it detects Rosetta, and §5.1 does not need an x64 Bun at all.
4. **Rosetta 2** (only for the darwin-x64 cell) — `softwareupdate --install-rosetta --agree-to-license`.
5. **Git line endings** — `git config --get core.autocrlf` must print nothing or `false`. macOS is the
   control cell for F77 (a Windows checkout with `autocrlf=true` made the CLI scaffold CRLF); a CR in a
   macOS-scaffolded file means your git config converts, not the platform.

Use short POSIX paths (`~/q/...`). Temporary scratch goes to `os.tmpdir()` everywhere
(`packages/build/src/compile/clang.ts:239` and friends), which on macOS is normally `$TMPDIR`
(`/var/folders/…/T/`), not `/tmp` — run `echo $TMPDIR` in the campaign shell and look there for
`qinit-pch`, `qinit-system`, `qinit-verify-*` **[verify on macOS]**.

---

## 3. Set up the Qinit CLI

### 3A. Clone + build from source (the CLI under test)
```bash
git clone https://github.com/hackerby888/qinit ~/q/qinit && cd ~/q/qinit
git merge-base --is-ancestor d7486d1e HEAD; echo "has-campaign-7-fixes=$?"   # expect 0 (§1)
bun install && bun run build:bin && chmod +x dist/qinit     # -> dist/qinit (no suffix on macOS: scripts/release/targets.ts:9-11)
./dist/qinit smoke                                            # expect "K12 + FourQ ran and produced a valid identity", exit 0
./dist/qinit --version                                        # prints v0.0.0: source builds are unstamped (packages/cli/src/version.ts:1)
```
`dist/qinit` is the single CLI for every campaign row; do not mix in the release binary. §4C's `env.sh`
puts `dist/` first on `PATH`, so a bare `qinit` in §5–§7 means `dist/qinit`.

**Trap:** never run `dist/qinit update` without `--dry-run`. The version compare is string equality
(`ops/update.ts:129`) and `0.0.0 ≠ 0.1.12`, so it would download the release and rename it over
`dist/qinit`. Test self-update on the `install.sh` copy (§3B) instead.

`bun run typecheck` has three legs; the third resolves `@qinit/proto` against `packages/proto/dist`,
which is gitignored. On a fresh clone: `(cd packages/core && bun run build) && (cd packages/proto && bun run build) && bun run typecheck`.

### 3B. Release-binary control rows (first execution ever of the shipped Mac binaries)
Run these **before** `env.sh` (§4C) is ever sourced and finish with the `uninstall` row, so the release
copy never shadows `dist/qinit` and its `uninstall` cannot reach the sandbox cache. Each is a ledger row
on its own, because nothing has executed these artefacts before:
```bash
A=$(uname -m | sed s/x86_64/x64/)          # arm64 | x64
curl -fsSL -o ~/q/qinit-rel https://github.com/hackerby888/qinit/releases/download/qinit-cli-v0.1.12/qinit-darwin-$A
chmod +x ~/q/qinit-rel
xattr -l ~/q/qinit-rel                     # curl is expected to set no com.apple.quarantine — expect empty   [verify on macOS]
codesign -dv --verbose=2 ~/q/qinit-rel     # record: Signature=adhoc (expected from `bun build --compile`) or "not signed at all"
spctl --assess --type execute ~/q/qinit-rel; echo "spctl=$?"
~/q/qinit-rel smoke; echo "exit=$?"        # "Killed: 9" or a Gatekeeper dialog here is a finding (release.yml never signs or notarises)
~/q/qinit-rel version
```
Then the documented installer, as a second row:
```bash
curl -fsSL https://raw.githubusercontent.com/hackerby888/qinit/main/install.sh | sh
# installs to ${QINIT_BIN:-~/.local/bin}/qinit (install.sh:6), verifies SHA256SUMS with shasum -a 256 (:80),
# then runs `qinit setup` with a non-TTY stdin: on an empty ~/.cache/qinit expect the four step rows to fetch
# (headers, the 363 MB node, the 111 MB SDK, the verifier) and "✓ setup complete", exit 0 (setup.tsx:420-425).
# The "updates skipped · run `qinit setup --force`" line (setup.tsx:311,414) appears only on a rerun over an
# older cache. Then `qinit version` prints 0.1.12.
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc     # ~/.local/bin is not on the default PATH [verify on macOS]
```
The release binary predates `0b75d9c4`: its `setup` fetches the 363 MB node and the 111 MB SDK in single
buffered requests with no retry and no resume. A "socket connection was closed" there extends **F75**
(shipped binary) rather than opening a new number; the resumable path exists only in `dist/qinit`.

The browser road is the Gatekeeper row: download `qinit-darwin-<arch>` with Safari, `xattr -l` it
(expect `com.apple.quarantine`), `chmod +x`, run `version`. On macOS 15+ an unsigned quarantined
binary is refused and the allow lives in System Settings › Privacy & Security, not in the dialog
**[verify on macOS]**. Expected friction on the browser road; a refusal on the curl road is a finding.

After the rows, on the installed copy only:
```bash
~/.local/bin/qinit update --dry-run                 # prints the tag, the current version and the asset URL
~/.local/bin/qinit update; echo "exit=$?"           # expect "already on the latest": the copy is v0.1.12 and latest.txt resolves to it (update.ts:129-131)
~/.local/bin/qinit update --force                   # exercises the real path: <exe>.new, chmod 0755, rename over the binary (update.ts:65-72, :95-101)
~/.local/bin/qinit version                          # still 0.1.12
~/.local/bin/qinit uninstall --dry-run
env -u QINIT_CACHE ~/.local/bin/qinit uninstall      # uninstall wipes cacheRoot() = $QINIT_CACHE when exported (cache.ts:44,78); keep it off the sandbox
```
`QINIT_NO_UPDATE` only silences the verifier auto-update (`verify-tool.ts:42-46`); it does not gate `qinit update`.

### 3C. `qinit setup` and the sandbox
Point the cache and config at a sandbox before every campaign. The variables the code reads on macOS
(`packages/core/src/cache/paths.ts:8-10`, `packages/cli/src/config.ts:17-30`):
```bash
export QINIT_CACHE="$HOME/q/sandbox/cache"          # default would be ~/.cache/qinit — there is no ~/Library/Caches branch
export XDG_CONFIG_HOME="$HOME/q/sandbox/config"     # config dir = $XDG_CONFIG_HOME/qinit; default ~/.config/qinit
# QINIT_CONFIG is read by no code path — the Windows handoff's `$env:QINIT_CONFIG` was dead.
```
```bash
~/q/qinit/dist/qinit setup
```
Four steps (`setup.tsx:22-27`) and what each fetches on a Mac:

| step | asset | size | lands in |
|---|---|---|---|
| core headers | `core-headers.tar.gz` from core-lite `releases/latest` (`qinit-v0.0.47`) | 535 KB | `<cache>/<version>/core-headers` (single buffered fetch) |
| node binary | `Qubic-darwin-arm64` / `Qubic-darwin-x64` | 363 MB / 360 MB | `<cache>/<version>/node/Qubic`, `chmod +x` (`ops/node.ts:141-146`); resumes from `<cache>/<version>/node/Qubic.part` — **lacks the F73 fix**, see §4 |
| WASI SDK | `wasi-sdk-29.0-arm64-macos.tar.gz` / `x86_64-macos` (`wasi-sdk.ts:10-17`) | 111 MB / 113 MB (the Windows one was 535 MB) | `<cache>/wasi-sdk/`; resumes from `<cache>/downloads/<asset>.tar.gz.part` |
| verifier | `contractverify-darwin-universal2-…` (one binary for both arches, `verify-tool.ts:54-57`) | 1.9 MB | `<cache>/tools/contractverify` (single buffered fetch) |

Record the wall time and whether any step needs a retry. The SDK archive has no `.sha256` sidecar
upstream (404 for both macOS assets), so its integrity is HTTPS-only — that is a fact, not a finding.
F75's fix is in this build: kill `setup` during the node step and again during the SDK step, rerun each
time, and confirm the resume from the `.part` file named in the table (two rows). If the SDK step still
fails, the manual road below works on every platform; note that CI's `doctor` resolved to the **managed**
SDK (`~/.cache/qinit/wasi-sdk/wasi-sdk-29.0-<arch>-macos/bin/clang++`), so the managed download and
extraction are already proven on both Mac arches and only this env-override road is new:
```bash
ARCH=$(uname -m)   # arm64 | x86_64
curl -fL --retry 8 -C - -o ~/q/wasi-sdk.tar.gz https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-29/wasi-sdk-29.0-$ARCH-macos.tar.gz
mkdir -p ~/q/wasi-sdk && tar xzf ~/q/wasi-sdk.tar.gz -C ~/q/wasi-sdk
export WASM_CLANG="$HOME/q/wasi-sdk/wasi-sdk-29.0-$ARCH-macos/bin/clang++"
export WASI_SYSROOT="$HOME/q/wasi-sdk/wasi-sdk-29.0-$ARCH-macos/share/wasi-sysroot"
"$WASM_CLANG" --version; echo "exit=$?"     # "Killed: 9" or a Gatekeeper prompt for the SDK's clang++ is a finding
```
Then `qinit doctor --json` (all **three** checks `ok:true` — wasi-sdk, core-lite headers, contract-verify
tool; `doctor` has no node row, `doctor.tsx:22,41,49`), `ls -l "$XDG_CONFIG_HOME/qinit/seed"` after the
first `seed` (expect `-rw-------`, `config.ts:49`), and `xattr -lr "$QINIT_CACHE/wasi-sdk" | head` (any
`com.apple.quarantine` on the managed path is a finding; bsdtar is expected to propagate it only from a
quarantined archive **[verify on macOS]**).

---

## 4. Build the core node

### 4A. Why you must build it
`qinit setup` gives you the `qinit-v0.0.47` node, which ticks (CI proved it) but stops including
transactions after the first `epoch advance` (F68/F73). The fix is `develop`'s head:
```bash
git clone -b develop https://github.com/hackerby888/core-lite ~/q/core-lite
git -C ~/q/core-lite merge-base --is-ancestor 0397da15 HEAD; echo "has-F73-fix=$?"     # expect 0
```
Keep the checkout at or after `0397da15` (2026-09-05); the ledger's core numbers were taken at that commit.

### 4B. The recipe — adapted from core-lite's own macOS CI job
This is the job that produced the release's darwin binaries; the workflow file is byte-identical between
the `qinit-v0.0.47` tag and `develop`. Every command body below comes from
`core-lite/.github/workflows/dynamic-contracts.yml` (line numbers in comments); only the paths and the
libffi prefix (`$RUNNER_TEMP` in CI) are local. **Do not** edit `src/qubic.cpp` (the six switches are
CMake options; the Windows handoff's define-editing recipe was wrong on every platform), and **do not**
follow `README_CLANG.md` (it says "OSX might work but is not properly tested" and documents `apt`).
```bash
cd ~/q
if [ "$(uname -m)" = arm64 ]; then MACOS_DEPLOYMENT_TARGET=11.0; else MACOS_DEPLOYMENT_TARGET=10.15; fi   # :166-175
LIBFFI_VERSION=3.4.6; LIBFFI_PREFIX=$HOME/q/libffi-prefix                                                 # :176-177

# libffi, static, at the deployment target (:189-216) — the toolchain clang needs SDKROOT spelled out
curl -fsSL -o libffi.tar.gz "https://github.com/libffi/libffi/releases/download/v$LIBFFI_VERSION/libffi-$LIBFFI_VERSION.tar.gz"
tar xzf libffi.tar.gz && cd "libffi-$LIBFFI_VERSION"
export MACOSX_DEPLOYMENT_TARGET="$MACOS_DEPLOYMENT_TARGET"; export SDKROOT="$(xcrun --show-sdk-path)"
./configure --prefix="$LIBFFI_PREFIX" --enable-static --disable-shared --disable-docs CC="$(xcrun -f clang)" CFLAGS="-mmacosx-version-min=$MACOS_DEPLOYMENT_TARGET"
make -j"$(getconf _NPROCESSORS_ONLN)" && make install
cd ~/q/core-lite

# configure (:239-270)
CC=$(xcrun -f clang); CXX=$(xcrun -f clang++)
cmake -S . -B build-node \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER="$CC" -DCMAKE_CXX_COMPILER="$CXX" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOS_DEPLOYMENT_TARGET" \
  -DCMAKE_PREFIX_PATH="$LIBFFI_PREFIX" -DLibFFI_INCLUDE_DIR="$LIBFFI_PREFIX/include" -DLibFFI_LIBRARY="$LIBFFI_PREFIX/lib/libffi.a" \
  -DBUILD_BROTLI=OFF -DBUILD_C-ARES=OFF -DCMAKE_DISABLE_FIND_PACKAGE_OpenSSL=ON \
  -DBUILD_BINARY=ON -DBUILD_TESTS=OFF -DENABLE_AVX512=OFF -DUSE_SANITIZER=OFF \
  -DTESTNET=ON -DTESTNET_LITE_RAM=ON -DTESTNET_PREFILL_QUS=ON -DLITE_WASM_SC=ON -DCMAKE_NO_USE_SWAP=ON -DADDON_TX_STATUS_REQUEST=ON \
  -DONLY_LOGGING=OFF

# two patches on the fetched drogon sources, after configure and before build (:272-293).
# The count checks abort loudly, as in CI: a future drogon bump must become a named error, never a silent no-op.
binder=build-node/_deps/drogon-src/orm_lib/src/SqlBinder.cc; guard='#if defined(__cpp_lib_format)'
test "$(grep -c "$guard" "$binder")" -eq 2 || { echo "expected 2 __cpp_lib_format guards in SqlBinder.cc"; exit 1; }
sed -i '' "s|$guard|#if 0|" "$binder"
sha1=build-node/_deps/drogon-src/trantor/trantor/utils/crypto/sha1.cc
test "$(grep -c 'defined(__i386__)' "$sha1")" -eq 1 || { echo "expected 1 __i386__ guard in sha1.cc"; exit 1; }
sed -i '' 's|defined(__i386__)|defined(__i386__) \|\| defined(__x86_64__)|' "$sha1"

# build (:295-305); CI fails the job on "was built for newer" — an object compiled for a newer macOS raises the binary's real floor
cmake --build build-node -- -j"$(getconf _NPROCESSORS_ONLN)" Qubic 2>&1 | tee ~/q/node-build.log
if grep -q "was built for newer" ~/q/node-build.log; then grep "was built for newer" ~/q/node-build.log | head; echo "ERROR: objects built for a newer macOS than $MACOS_DEPLOYMENT_TARGET"; exit 1; fi

# the CI's gates on the result (:428-434, :454-482)
NODE_BIN=$HOME/q/core-lite/build-node/src/Qubic
file "$NODE_BIN"; lipo -archs "$NODE_BIN"; otool -L "$NODE_BIN"      # expect only /usr/lib/libz.1, libSystem.B, libc++.1
otool -l "$NODE_BIN" | grep -A3 LC_BUILD_VERSION | grep minos        # 11.0 (arm64) / 10.15 (x86_64)
```
Why the pieces are there: `LITE_WASM_SC` hard-requires `TESTNET=ON` and `TESTNET_LITE_RAM=ON`
(`CMakeLists.txt:73-75`) and is what makes the node able to run wasm contracts; `TESTNET_LITE_RAM` is
also the define the F73 fix is guarded on. The SqlBinder patch keeps the binary off `std::format` (a
13.3 floor); on a Tahoe-only local build it is harmless either way **[verify on macOS]**. The sha1
patch is required on x86_64 whenever OpenSSL is disabled. CI timings: configure+build ≈ 2 min on the
M1 runner, ≈ 5 min on the Intel one. On Apple silicon the x86 intrinsics go through SIMDe; on Intel the
node is built with AVX/AVX2 and `-Wl,-no_fixup_chains` (`cmake/CompilerSetup.cmake`, `src/CMakeLists.txt:343-348`).

### 4C. Environment — `~/q/work/bin/env.sh`
Save this as `~/q/work/bin/env.sh` (the path the ported harness scripts source, §5.2) and source it in
every campaign shell before any `cd`. It defines everything §4D and §5–§7 use:
```bash
# macOS campaign environment — source before any cd.
Q="$HOME/q"; ARCH=$(uname -m)                                   # arm64 | x86_64 (x86_64 inside an `arch -x86_64` shell [verify on macOS]); picks the SDK below
export PATH="$(brew --prefix)/bin:$PATH"                        # brew bash 5 first: the scripts need mapfile
export QINIT_SRC="$Q/qinit"
export PATH="$QINIT_SRC/dist:$PATH"                             # bare `qinit` = dist/qinit, never the ~/.local/bin release copy
# The Rosetta cell (§5.1): inside an `arch -x86_64` shell on Apple silicon sysctl.proc_translated is 1 (the check
# bun's installer uses); the cell then gets the cross-compiled x64 CLI and its own cache and config.
if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then CELL="-x64"; export QINIT="$QINIT_SRC/dist/qinit-darwin-x64"; else CELL=""; export QINIT="$QINIT_SRC/dist/qinit"; fi
export QINIT_CORE="$Q/core-lite";   export NODE_BIN="$Q/core-lite/build-node/src/Qubic"
export QINIT_CACHE="$Q/sandbox/cache$CELL"; export XDG_CONFIG_HOME="$Q/sandbox/config$CELL"
export WORK="$Q/work"
# WASI SDK: the managed road (§3C `qinit setup`) first, the manual road second. The env pair replaces the cached
# SDK outright (wasi-sdk.ts:62-70), so a wrong path here fails every clang build and makes `doctor` say "not cached".
SDK="$QINIT_CACHE/wasi-sdk/wasi-sdk-29.0-$ARCH-macos"; [ -x "$SDK/bin/clang++" ] || SDK="$Q/wasi-sdk/wasi-sdk-29.0-$ARCH-macos"
export WASM_CLANG="$SDK/bin/clang++"; export WASI_SYSROOT="$SDK/share/wasi-sysroot"
export QUBIC_CLI="$Q/qubic-cli/build/qubic-cli"; export QLOGGING="$Q/qlogging/build/qlogging"   # optional (§4E)
```

### 4D. Run the node through Qinit
```bash
source ~/q/work/bin/env.sh
qinit node run --runtime core --core-dir "$QINIT_CORE" --node-bin "$NODE_BIN" --restart --wait 150 --json
```
What that does (`ops/node.ts:213-238`, `:303-336`): spawns `Qubic --peers 127.0.0.1 --node-mode 3 --ticking-delay 1000`
detached from `$QINIT_CACHE/run` (log `run/node.log`, pid `run/node.pid`), then polls `/live/v1/tick-info`
until two successive tick advances. CI's restarts reached "ticking" in 7.8 s (M1) and 9.2 s (Intel);
Windows took 11.8 s. `--core-dir` must contain `src/qpi/qpi.h`; the core runtime requires `--node-bin`
(an empty one fetches the release node, `ops/node.ts:141`). Every later start gets `--offline`.
```bash
curl -s http://127.0.0.1:41841/live/v1/tick-info | jq .tickInfo; curl -s http://127.0.0.1:41841/live/v1/whoami
ps -o rss=,vsz=,comm= -p "$(cat "$QINIT_CACHE/run/node.pid")"      # Windows saw ~3.5 GB RSS; no Mac figure exists — record it
qinit node stop --json; echo "exit=$?"; pgrep -x Qubic || echo "no Qubic process"   # F84 is fixed in b2e3700e; stopped:false here is a regression
```
Watch specifically for the F68/F73 symptom: after `qinit epoch advance`, do transfers/deploys/procs still
get **included** (not just `ok:true`)? On the `develop` node they must; on the release node they will not.

### 4E. qubic-cli + qlogging — optional, test-only
Same two tests and the same reason as the Windows handoff §4D. On macOS the CMake single-config
generator puts the binaries at `build/qubic-cli` and `build/qlogging` (no `Release/`, no `.exe`), and the
`/tmp/qinit-cli-probe.bin` path that worried the Windows doc exists here **[verify on macOS]**.

---

## 5. What to test — shared with the Windows handoff

Read `docs/testing-windows-handoff.md` **§5** (the two prompt docs, the seven ground rules, the P0–P8
QLaunch lifecycle, four cells × fresh node, diff every number against its oracle) and **§7** (report
shape). They apply unchanged. Four macOS additions:

1. **A fifth cell, Rosetta — clang × core, everything x86_64.** Build the x64 CLI from the same source on
   the arm64 Mac by cross-compiling, exactly as `release.yml` does on Ubuntu (`scripts/release/build-matrix.ts:7`);
   a Rosetta-installed Bun is not needed and `bun.sh/install` would hand you an arm64 Bun anyway:
   ```bash
   cd ~/q/qinit && bun build packages/cli/src/index.tsx --compile --minify --target=bun-darwin-x64 --outfile dist/qinit-darwin-x64
   file dist/qinit-darwin-x64                                   # must say x86_64
   arch -x86_64 /bin/bash -l                                    # a Rosetta shell: sysctl -n sysctl.proc_translated prints 1 [verify on macOS]
   source ~/q/work/bin/env.sh                                   # env.sh detects the Rosetta shell: $QINIT = dist/qinit-darwin-x64, cache/config get a -x64 suffix, ARCH = x86_64
   "$QINIT" smoke
   "$QINIT" setup                                               # expect Qubic-darwin-x64 and wasi-sdk-29.0-x86_64-macos in the x64 cache
   ```
   Use `"$QINIT"` for the cell's rows, as the harness scripts do: a bare `qinit` in that shell is still the
   arm64 `dist/qinit`. The x64 node for this cell is either the managed `Qubic-darwin-x64` (F73-broken,
   fine for rows that never cross an epoch) or a `develop` build made on an Intel Mac; building `develop`
   for x86_64 on Apple silicon (`-DCMAKE_OSX_ARCHITECTURES=x86_64`) is untested — CI builds the x64 node
   only on Intel runners **[verify on macOS]**. The arm64 cell is the control for every value. The released
   `qinit-darwin-x64` is a §3B-style control row only, not this cell's CLI.
2. **Get the campaign files.** The repo bundles none of them: the harness (`work/bin`, 26 files), the
   product repo (`Launch` with `contracts/Launch.h`, `contracts/Vault.h`, `tests/Launch.test.ts`,
   `qinit.json`), the probe headers (`work/p2/probes/*.h`), the planted bugs (`work/p3/Launch-bug{A,B,C}.h`)
   and the upgrade versions (`work/p4/Launch-v{2,3}.h`) live on the Windows box. They were packed there as
   `C:\q\campaign7-macos.tgz` (also carries `Launch-qpi.patch`, the uncommitted `QPI::` edit to `Launch.h`,
   and the `qinit gen` output `work/p1/gen`): hand that archive over with this document, then
   `mkdir -p ~/q && tar xzf campaign7-macos.tgz -C ~/q`. Without it, rebuild the product from the campaign-6
   plan as the Windows run did, and drop every line-numbered instruction in this section and in §6.9.
3. **The harness port.** The Windows scripts (mirrored from the Linux `bin/`) run on macOS after these
   mechanical changes — every one was verified by reading the scripts:
   - strip CR from every copied file first (all 26 scripts and the product repo are CRLF on the Windows box; bash refuses a CRLF shebang): `cd ~/q && perl -pi -e 's/\r\n/\n/' work/bin/*.sh work/bin/*.py work/bin/*.ts Launch/contracts/*.h Launch/tests/*.ts Launch/qinit.json Launch/package.json work/p2/probes/*.h work/p3/*.h work/p4/*.h`;
   - `mapfile -t` (five scripts) needs bash ≥ 4 → brew bash first on PATH (`env.sh` does it), or a `while read` loop;
   - `py -3` (five sites) → `python3`; `sha256sum` (phase-P2.sh:96) → `shasum -a 256`; `cmp -n` (phase-P4.sh:44) → compare `head -c` prefixes; GNU-BRE `\|` in greps → `grep -E`;
   - `lib.sh:2` `sed 's/\x1b…'` is a silent no-op under BSD sed → `perl -pe 's/\e\[[0-9;]*[mGKHAJ]//g'`;
   - `taskkill //F //IM qinit.exe` (f64.sh:10) → `kill -KILL $!` on the background job's pid (never by name: it takes the harness's own in-flight command with it — ledger §Friction);
   - every `C:/q` and `/c/q` → `$HOME/q` (`sed -i '' -e "s#C:/q#$HOME/q#g" -e "s#/c/q#$HOME/q#g" work/bin/*.sh work/bin/*.py work/bin/*.ts`); `dist/qinit.exe` → `dist/qinit`; `Qubic.exe` → `build-node/src/Qubic`; `id.ts`/`k12.ts` import `C:/q/work/p1/gen/runtime.ts` → `../p1/gen/runtime.ts`, and regenerate that `qinit gen` output on the Mac before any P2 script;
   - the product repo's `qinit.json` carries an absolute `coreDir` (F66) that outranks `QINIT_CORE` — `sed -i '' "s#C:/q/core-lite#$HOME/q/core-lite#" ~/q/Launch/qinit.json`;
   - `phase-P3.sh:48` is the one `tui.py` call (a ConPTY driver, not portable) — replace it with tmux, as the Linux campaigns drove the Ink TUIs (`docs/testing-cli-developer-prompt.md` ground rule 3): `tmux -u new -d -s dbg -x 120 -y 34 "$QINIT debug Launch"; sleep 5; tmux send-keys -t dbg Down; sleep 2; tmux capture-pane -p -t dbg > "$ROWS/debug-tui.txt"; tmux kill-session -t dbg`.
4. **Order.** Release rows (§3B) first, then `env.sh`, then P0. Never touch the release copy again after its `uninstall`.

### Previous findings — do not re-file, extend
The ledgers are bundled at `docs/findings/TESTING-FINDINGS{,-2,-3,-4,-5,-6}.md` (F1–F74, Linux) and
`docs/findings/TESTING-FINDINGS-7-windows.md` (F75–F85). The campaign-6 and campaign-7 findings, one
line each, with the status the Windows run and the fixes after it left them in:

| # | finding | status |
|---|---|---|
| F65 | `node run` re-fetched the WASI SDK although `WASM_CLANG`/`WASI_SYSROOT` were set | **fixed** `0b75d9c4` — verify no download on a first `node run` with the env set |
| F66 | scaffold `.gitignore` misses `tests/.qinit/`, `package.json`; absolute `coreDir` in `qinit.json` | **open**; Windows extension: with `coreDir` gone and `QINIT_CORE` unset the build silently uses the cache's release headers |
| F67 | TS backend built a struct hidden by a same-named procedure | **fixed** `f10db311`, verified on Windows |
| F68 | node waits for F10 at the epoch boundary | **fixed** by core-lite `0397da15` (needs `TESTNET_LITE_RAM`), verified on Windows |
| F69 / F70 | withdrawn (F69's product-level shape came back as F82) | withdrawn |
| F71 | simulator calendar pinned to 2024 | **fixed** `cf3fc4da`, verified: real UTC date on all four cells |
| F72 | no contract identity or balance | **fixed** `51d41fd8` for `deploy`/`call`/`state`; `ls` still lacks both |
| F73 | inclusion dies after `epoch advance` | **fixed** `0397da15`, verified on both core cells — **only with a `develop` node** |
| F74 | generated client has no version guard, returns wrong values after a field reorder | **open**, reproduced on core too |
| F75 | `setup` could not download the 535 MB Windows SDK (no retry, no resume) | **fixed** `0b75d9c4` (resumable `.part`, three attempts) — the resume rows in §3C; the shipped v0.1.12 still has the old path |
| F76 | bare `div(`/`mod(` passed every gate but MSVC rejects it at Core hand-off | **fixed** `0b75d9c4`: build-rule gate on both compilers, `verify`, `integrate`; system contracts exempt; `--no-build-rules` — the gate must fire on macOS too (§6.9) |
| F77 | a Windows-built CLI scaffolds CRLF; the release scaffolds LF | **open** — macOS is the control (§6.8) |
| F78 | false "headers/node version drift", exit 1, for a `--node-bin` node | **fixed** `0b75d9c4` |
| F79 | `epoch advance` reported "node unreachable" when one 10 s request outlived the sprint | **fixed** `0b75d9c4` (15 s / 30 s budgets, poll after a timeout) |
| F80 | `clean` reports `killed:true` for a node it never tracked (image-name fallback) | **open**; on macOS the fallback is `pgrep -x Qubic` — probe it (§6.3) |
| F81 | `ext install` targets a marketplace id that does not exist; `--json` has no `error` | **open**, parked until the extension is published; `--vsix` works |
| F82 | simulator fired the share-rights callbacks with zero originator/invocator | **fixed** `0b75d9c4`; P1 spec 8/0/64 on all four cells after it |
| F83 | six repo CLI tests timed out on Windows | **fixed** `0b75d9c4` (`test-utils/cli.ts`) |
| F84 | `node stop` reported "still alive" for a node it had stopped | **fixed** `b2e3700e` — re-check on the `pgrep` branch (§4D) |
| F85 | the full `bun test` needs ~19 GB private memory at one file | **open**; the macOS peak is unknown — record it (§6.10) |

Still open from earlier campaigns and unchanged on Windows: F22, F30, F57, F62; F64 stayed inconclusive
twice (the kill landed before the upload window). F7 is by design but costs harness rows (`jq .out.shares`
fails on a one-field output).

---

## 6. macOS-specific watch list (most likely to diverge)

1. **The RPC port binds every interface.** The simulator's `Bun.serve` has no `hostname`
   (`packages/engine/src/server.ts:420-447`; Bun's default is `0.0.0.0`) and the core node's HTTP
   controller does the same (`core-lite/src/extensions/http/http.h:74`), while the peer port pins
   `127.0.0.1` (`peer-server.ts:50-52`) and the CLI prints `rpc http://127.0.0.1:41841`. No Linux or
   Windows row ever recorded this. Expect the application-firewall dialog for an unsigned binary
   **[verify on macOS]** and LAN reachability:
   ```bash
   qinit node run --runtime simulator --json
   lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(41841|31841) '            # finding if 41841 is `*:` while 31841 is 127.0.0.1
   LAN=$(ipconfig getifaddr en0); qinit tick --json --rpc "http://$LAN:41841"   # answers → the printed URL misstates the exposure
   ```
   Also record whether the node starts while the firewall dialog is pending (a `--wait` timeout there is a finding).
2. **Gatekeeper and quarantine.** Nothing is signed or notarised: not the CLI (`release.yml`), not the node
   (core-lite CI), not the SDK. The curl and Bun-fetch roads are expected to set no quarantine attribute
   and the browser road to set it **[verify on macOS]** — §3B records both. Decisive commands:
   `codesign -dv --verbose=2`, `spctl --assess --type execute`, `xattr -l`. An arm64 binary with no
   signature at all is expected to be killed at exec regardless of quarantine **[verify on macOS]**, so
   the `codesign` line on each artefact is the fact to record.
3. **Process lifecycle.** The node is spawned detached and unref'd (`ops/node.ts:213-239`); close the
   Terminal window that launched it, reopen, `qinit node status --json` — a dead node is a finding. With
   no pid file, `nodeAlive()` falls back to `pgrep -x Qubic` (`:116`): the managed node and a CI-recipe
   build are both named `Qubic`, but a hand-named `--node-bin ~/Downloads/Qubic-darwin-arm64` is not,
   and the simulator's process is `qinit`. Probe, in three rows after `rm "$QINIT_CACHE/run/node.pid"` on a
   running core node: (a) `qinit node run --runtime simulator --json` → expect "`http://127.0.0.1:41841`
   is served by an untracked core node; stop it or choose another --rpc" (`node-run.tsx:162-164`, only
   fires on a runtime mismatch); (b) `qinit node run --runtime core --node-bin "$NODE_BIN" --offline --json`
   without `--restart` → expect "reused, ticking at N" (`:147-150`); (c) the same with `--restart` →
   `killNode()` has nothing to kill (`node.ts:73-77`) and a second `Qubic` is launched against the occupied
   ports — record what happens to it, its `node.log`, and which pid the new `node.pid` holds; that is the
   F80-shaped row.
4. **Paths.** `~/.cache/qinit` and `~/.config/qinit` (no `~/Library` anywhere; `uninstall` assumes
   `~/.local/bin`); scratch under `os.tmpdir()`; `/tmp` and `/var` are symlinks into `/private`
   **[verify on macOS]** — Qinit never calls `realpath`, so watch the strings it stores (`qinit.json`
   `coreDir`) for `/private` forms when a project lives under `$TMPDIR`. Case-insensitive APFS:
   `qinit new Tcase && cd Tcase && cp contracts/Tcase.h contracts/TCASE.h; ls contracts` — expect `cp` to
   refuse or `ls` to show one file **[verify on macOS]**; the row is a `TCASE.h` reference in `qinit.json`
   building here and failing on the Linux control. Spaces: repeat the Windows `Dev Two` row once
   (`~/Dev Two/qlaunch`).
5. **TTY and the TUIs.** In tmux every picker sees a TTY, as on Linux. Outside it: `explorer` refuses
   without a TTY (`explorer/index.tsx:40-42`), `debug` renders static frames and never exits (F25),
   `setup` skips its prompt. Terminal.app (256 colours) and iTerm2 (truecolor) may emit different escape
   sequences for the same frame — not a finding; missing glyphs are cosmetic. Tahoe's Terminal is the
   console to record frames from **[verify on macOS]**; inside tmux use `-u` and a UTF-8 `LANG`.
6. **Architecture.** `dist/qinit` loads no native addon (`find node_modules -name '*.node'` finds only
   `keytar.node`, an optional dependency of `@vscode/vsce` for `packages/vscode` that the CLI never loads)
   and every asset table has both darwin keys. The Rosetta cell (§5.1) runs an entire x86_64 toolchain
   emulated: the darwin-x64 node is built with `-mrdrnd -mbmi -mlzcnt` and, on Intel runners, AVX/AVX2 —
   an `Illegal instruction`/SIGILL from the x64 node or the x86_64 `clang++` under Rosetta is a finding
   **[verify on macOS]**, and any value that differs between the arm64 and Rosetta cells is a divergence
   row. Mixed-arch probe: the arm64 `qinit` with `--node-bin` pointing at the x64 node (spawn runs it under
   Rosetta transparently), then `time qinit epoch advance --json` against the arm64-node figure.
7. **`--json | jq` exit codes in zsh.** `pipefail` is off by default in zsh too, and the per-command
   statuses are `$pipestatus` (lowercase, 1-indexed), so a copied `${PIPESTATUS[0]}` line prints nothing.
   Run the jq rows in bash 5, or use the harness's file-based `runj` (redirect first, `jq` the file after).
8. **Line endings — the F77 control.** With `core.autocrlf` unset, `git ls-files --eol packages/build/src/assets/templates/counter.h`
   must show `i/lf w/lf`, and `qinit new Tcounter && LC_ALL=C grep -c $'\r' Tcounter/contracts/Tcounter.h`
   must print 0. Fresh `qinit new` here is byte-identical to Linux and to the release; any CR is a finding.
9. **The F76 gate on clang.** MSVC's `div` rejection cannot reproduce on a Mac, but the gate must still
   fire on both compilers, `verify` and `integrate`. The bare spelling is the product repo's committed
   HEAD (the `QPI::` edit is the uncommitted `Launch-qpi.patch` in the archive):
   `git -C ~/q/Launch show HEAD:contracts/Launch.h > ~/q/Launch/contracts/Launch-bare.h`, then
   `qinit verify contracts/Launch-bare.h; echo exit=$?` and `qinit build contracts/Launch-bare.h --compiler clang`
   must fail at lines 281/284/296 with the `QPI::div(…)` / `QPI::mod(…)` message, and
   `QINIT_BUILD_RULES=off` (or `--no-build-rules`) must let it build.
10. **Downloads and memory.** The 363 MB node and the resumable SDK (§3C) are the download rows. For the
    repo suite: run `bun test` alone on the box and sample the bun process's memory once a minute; the
    Windows peak was 18.8 GB private at `packages/compiler/tests/gtest/contract-testing.test.ts` (F85).
    On a 16 GB Mac run `bun test packages/compiler/tests/gtest` as its own invocation and record the peak
    and whether the OS swaps. `bun test` does **not** typecheck; the real gate before trusting a green run
    is `bun run build:bin` plus `./dist/qinit smoke`.

---

## 7. Reporting

New ledger: `docs/findings/TESTING-FINDINGS-8-macos.md`, numbering from **F86**, in the shape the Windows
handoff §7 fixes: minimal repro in a fenced block, expected vs actual with the oracle, severity (silent
wrong value/state > wrong diagnostic > loud rejection of legal input > cosmetic), and a **control** —
for a divergence the Linux cell (campaign 6) or the Windows ledger's recorded bytes. Record the macOS
version, the architecture and the cell (native / Rosetta) on every row; finish each phase with the
five-cell matrix and suite pass/skip/fail counts. Open with a Step 0 table like the Windows ledger's:
what this document got wrong is the first thing the next tester needs.

Gotchas that carried from Linux through Windows and still apply: check `node run`'s exit before the
first deploy (one node per port — an orphan on 41841 makes every later `--restart` refuse and every
later row run against the wrong node); never kill by a pattern that matches your own shell; one
`node run --restart` per core cell; `--offline` after the first start; chain long runs on a unique final
marker, not on `exit=`; run node-bound chains one at a time; asset names are packed
`sum(ord(c) << 8*i)` and a lowercase byte silently yields 0 from `issueAsset`; source `env.sh` before any `cd`.
