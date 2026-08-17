#include "contract_testing.h"

class ContractTestingProxy : protected ContractTesting
{
public:
    ContractTestingProxy()
    {
        INIT_CONTRACT(Counter);
        INIT_CONTRACT(Proxy);
    }
};

// A gtest inside a qinit project: the contract is resolved through the project's dependency graph, and
// the receivers below are all reached through a field, which clangd answers with an empty list.
TEST(ContractProxy, Read)
{
    ContractTestingProxy test;

    Counter::Get_input gi;
    gi.history.setAll(0);
    gi.detail.rank = 0;
    gi.detail.tags.setAll(0);
}
