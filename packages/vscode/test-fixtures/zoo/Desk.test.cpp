#include "contract_testing.h"

class ContractTestingDesk : protected ContractTesting
{
public:
    ContractTestingDesk()
    {
        INIT_CONTRACT(Vault);
        INIT_CONTRACT(Desk);
    }
};

// The A/B control for the contract-document case: the identical receiver shape, reached from a gtest.
TEST(ContractDesk, Read)
{
    ContractTestingDesk test;

    Vault::Get_input gi;
    gi.history.setAll(0);
    gi.detail.rank = 0;
    gi.detail.bits.setAll(0);
}

// A gtest builds calls against the contract under test, so the index and payload the IDL hover reports
// are exactly what a developer reads here. Round 19 measures whether they are available on this surface.
TEST(ContractDesk, Invoke)
{
    ContractTestingDesk test;

    Desk::Read_input input;
    Desk::Read_output output;
    output.value = 0;
}
