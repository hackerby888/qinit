#include "contract_testing.h"

class ContractTestingCounter : protected ContractTesting
{
public:
    ContractTestingCounter()
    {
        INIT_CONTRACT(Counter);
    }
};

TEST(Counter, Initialize)
{
    ContractTestingCounter test;
    Counter::get_input input;
    input.history.setAll(0);
}
