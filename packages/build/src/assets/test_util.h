#pragma once

// Wasm replacement for test_util.h without native-only gtest, FourQ, or stream dependencies.
// advanceTimeAndTick lives in wasm_contract_testing.h, since core's contract_testing.h reaches it too.
#include "wasm_contract_testing.h"
