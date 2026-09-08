#!/usr/bin/env bash
# Build core's WAMR contract-test binary — the third oracle this campaign uses to check a contract
# against the runtime core actually runs, rather than against the other backend.
#
# This exists because the binary is NOT part of any repo and does not survive a container restart,
# and because none of the four flags it needs are defaults. Round 6 lost an afternoon rediscovering
# them; this script is so the next restart does not.
#
#   nasm            CompilerSetup.cmake requires it even with BUILD_BINARY=OFF
#   LITE_WASM_SC    the target only exists under it
#   TESTNET         + TESTNET_LITE_RAM — LITE_WASM_SC refuses to configure without both
#
# Idempotent: if the binary is already there, it says so and exits 0.
#
# Usage:  QINIT_CORE=/path/to/core-lite scripts/solidity-port/build-wamr-oracle.sh
# Then:   export QINIT_WAMR_GTEST=$(QINIT_CORE=... scripts/solidity-port/build-wamr-oracle.sh --path)
set -euo pipefail

CORE="${QINIT_CORE:-/home/user/core-lite}"
BINARY="$CORE/build-wasm/test/qubic_wasm_tests"

if [[ "${1:-}" == "--path" ]]; then
    echo "$BINARY"
    exit 0
fi

if [[ -x "$BINARY" ]]; then
    echo "wamr oracle already built: $BINARY"
    exit 0
fi

if [[ ! -d "$CORE" ]]; then
    echo "error: core-lite not found at $CORE — set QINIT_CORE" >&2
    exit 1
fi

if ! command -v nasm >/dev/null 2>&1; then
    echo "error: nasm is required (cmake/CompilerSetup.cmake looks for it even with BUILD_BINARY=OFF)" >&2
    echo "       apt-get install -y nasm" >&2
    exit 1
fi

echo "configuring $CORE/build-wasm ..."
cmake -S "$CORE" -B "$CORE/build-wasm" -G Ninja \
    -DBUILD_TESTS=ON \
    -DLITE_WASM_SC=ON \
    -DTESTNET=ON \
    -DTESTNET_LITE_RAM=ON \
    -DBUILD_BINARY=OFF \
    -DUSE_SANITIZER=OFF \
    -DANT_WALKER=OFF \
    -DCMAKE_BUILD_TYPE=Release

echo "building qubic_wasm_tests (fetches WAMR at its pinned SHA on a cold build) ..."
cmake --build "$CORE/build-wasm" --target qubic_wasm_tests -j"$(nproc)"

if [[ ! -x "$BINARY" ]]; then
    echo "error: build reported success but $BINARY is missing" >&2
    exit 1
fi

echo
echo "wamr oracle built: $BINARY"
echo "export QINIT_WAMR_GTEST=$BINARY"
echo
echo "Calibrate it before trusting any result — an oracle that has not been checked against a known"
echo "answer is not an oracle:"
echo "  bun test packages/cli/tests/integration/cross-host.test.ts    # expect 8 pass"
