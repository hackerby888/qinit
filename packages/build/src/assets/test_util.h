#pragma once

// Wasm replacement for test_util.h without native-only gtest, FourQ, or stream dependencies.
#include "wasm_contract_testing.h"

// Advance the chain by one tick. (The native version also rolls the wall clock forward by `ms`; corpora that
// rely on the exact time delta will need a host time-advance — none of the currently-built ones do.)
static inline void advanceTimeAndTick(unsigned long long /*milliseconds*/) {
    ++qubicSystemStruct.tick;
}
