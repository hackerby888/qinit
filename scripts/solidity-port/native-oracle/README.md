# A third oracle for the arithmetic findings

The whole campaign compares two Qubic backends against each other, so "they agreed" has never meant
"they were right" — both share one build gate, one `qpi.h` and one simulator. This directory holds the
smallest thing that breaks out of that: core-lite's own QPI headers compiled **natively for x86-64 by
g++**, a different compiler and a different target from either backend under test.

```sh
g++ -std=c++20 -w -O2 \
    -I"$QINIT_CORE" -I"$QINIT_CORE/src" -I"$QINIT_CORE/lib/platform_common" \
    scripts/solidity-port/native-oracle/arithmetic-probe.cpp -o /tmp/arithmetic-probe
/tmp/arithmetic-probe
```

Output on wasi-sdk-29 / g++ 12, x86-64:

```
div<sint32>(INT32_MIN, -1)         = SIGFPE (hardware trap)
mod<sint32>(INT32_MIN, -1)         = SIGFPE (hardware trap)
div<sint64>(INT64_MIN, -1)         = SIGFPE (hardware trap)
div<sint32>(-128, -1) control      = 128
div<sint32>(7, 0) guard            = 0
1ULL << 62 runtime                 = 4611686018427387904
1ULL << 64 runtime                 = 1
1ULL << 62 constant-folded         = 4611686018427387904
```

What it settles:

- **F200.** `QPI::div(INT32_MIN, -1)` faults on native x86 exactly as it traps under clang/wasm. The
  TypeScript backend's answer — `INT32_MIN`, execution continuing — is the outlier, not clang's trap.
  The zero-divisor guard (`b ? a / b : 0`) works as intended, and the `sint8`-range control returns 128
  because the operands promote to `int` first, which is the same reason F200 is width-specific.
- **F204, partially.** On x86 a shift count is masked to six bits, so `1ULL << 64` is `1` rather than a
  trap or a zero. That is one more data point for "the answer past the operand width is whatever the
  target does", and it is *not* the same answer as either backend gives for the folded constexpr case —
  which is the finding.

What it does not settle: the probe evaluates the `div`/`mod` definitions copied verbatim from
`core-lite/src/qpi/qpi.h:54`, and core's own typedefs from `qpi_types.h`, but it does **not** run a
contract. Nothing here confirms a state digest, a container, or a host call. Doing that natively needs
core's `contract_testing.h`, which needs gtest and a registered contract index; that remains undone.
