// Third oracle for the arithmetic findings: core-lite's own QPI headers, compiled for x86-64 by g++
// rather than to wasm by clang, so the answer comes from a different compiler and a different target
// than either backend under test. `__markContractStateDirty` is the node's own hook, stubbed here
// because this probe evaluates arithmetic and never touches contract state.
#include <cstdio>
#include <csignal>
#include <csetjmp>
#include <cstdint>

static void __markContractStateDirty(unsigned int) {}

#include "qpi/qpi_types.h"

using QPI::sint32;
using QPI::sint64;
using QPI::uint32;
using QPI::uint64;

// Copied verbatim from core-lite/src/qpi/qpi.h:54 — the definition both backends compile.
template <typename T>
static inline constexpr T qpiDiv(T a, T b)
{
    return b ? (a / b) : T(0);
}

template <typename T>
static inline constexpr T qpiMod(T a, T b)
{
    return b ? (a % b) : 0;
}

static sigjmp_buf jump;
static void onFault(int) { siglongjmp(jump, 1); }

#define TRY_PRINT(label, expr)                                    \
    do {                                                          \
        if (sigsetjmp(jump, 1) == 0) {                            \
            printf("%-34s = %lld\n", label, (long long)(expr));   \
        } else {                                                  \
            printf("%-34s = SIGFPE (hardware trap)\n", label);    \
        }                                                         \
    } while (0)

int main()
{
    signal(SIGFPE, onFault);

    // volatile so the operands reach the divide instruction instead of the constant folder.
    volatile sint32 a32 = INT32_MIN, b32 = -1;
    volatile sint64 a64 = INT64_MIN, b64 = -1;
    volatile sint32 a8 = -128, b8 = -1;

    TRY_PRINT("div<sint32>(INT32_MIN, -1)", qpiDiv<sint32>(a32, b32));
    TRY_PRINT("mod<sint32>(INT32_MIN, -1)", qpiMod<sint32>(a32, b32));
    TRY_PRINT("div<sint64>(INT64_MIN, -1)", qpiDiv<sint64>(a64, b64));
    TRY_PRINT("div<sint32>(-128, -1) control", qpiDiv<sint32>(a8, b8));
    TRY_PRINT("div<sint32>(7, 0) guard", qpiDiv<sint32>((sint32)7, (sint32)0));

    // F204: a shift count at or past the operand width, folded versus at runtime.
    volatile uint64 one = 1, count = 62;
    printf("%-34s = %llu\n", "1ULL << 62 runtime", (unsigned long long)(one << count));
    count = 64;
    printf("%-34s = %llu\n", "1ULL << 64 runtime", (unsigned long long)(one << count));
    constexpr uint64 folded = (uint64)1 << 62;
    printf("%-34s = %llu\n", "1ULL << 62 constant-folded", (unsigned long long)folded);
    return 0;
}
