// Standard core-lite ContractTesting fixture used by compiler differential tests. The convenience methods
// are ordinary fixture members, so the emitted source also builds with core-lite's native gtest harness.
export function coreGtest(contractType: string, tests: string): string {
  return `#define NO_UEFI
#include "contract_testing.h"

class ContractTestingHarness : protected ContractTesting
{
public:
    ContractTestingHarness()
    {
        initEmptySpectrum();
        initEmptyUniverse();
        INIT_CONTRACT(${contractType});
        callSystemProcedure(${contractType}_CONTRACT_INDEX, INITIALIZE);
    }

    template <typename Out, typename In>
    Out invoke(unsigned int inputType, const In& input, sint64 amount, const id& user)
    {
        Out output{};
        invokeUserProcedure(${contractType}_CONTRACT_INDEX, inputType, input, output, user, amount);
        return output;
    }

    template <typename Out, typename In>
    Out call(unsigned int inputType, const In& input) const
    {
        Out output{};
        callFunction(${contractType}_CONTRACT_INDEX, inputType, input, output);
        return output;
    }

    template <typename StateData>
    const StateData& state() const
    {
        return *(const StateData*)contractStates[${contractType}_CONTRACT_INDEX];
    }

    id idFromSeed(const char*) const { return id::randomValue(); }
    void fund(const id& account, sint64 amount) { increaseEnergy(account, amount); }
    sint64 balance(const id& account) const { return getBalance(account); }
    void endEpoch() { callSystemProcedure(${contractType}_CONTRACT_INDEX, END_EPOCH); }
};

${tests}`;
}
