#pragma once

// Wasm-mode replacement for core-lite's test/test_util.h. The native one pulls <iostream>, gtest, four_q and
// the whole contract_core (for m256i/DateAndTime ostream printers + etalonTick time control) — none of which
#include "wasm_contract_testing.h"

// Advance the chain by one tick. (The native version also rolls the wall clock forward by `ms`; corpora that
// rely on the exact time delta will need a host time-advance — none of the currently-built ones do.)
static inline void advanceTimeAndTick(unsigned long long /*milliseconds*/) {
    ++qubicSystemStruct.tick;
}
