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
