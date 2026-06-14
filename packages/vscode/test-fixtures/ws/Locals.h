// Integration fixture exercising the locals diagnostics + the qpi.h-include exception.
// Line 1 below is the sanctioned dev-include — it must produce NO QPI diagnostic.
#include "contracts/qpi.h"
using namespace QPI;

struct Locals : public ContractBase {
  struct Tally_locals { uint64 sum; };

  // Plain PUBLIC_PROCEDURE that has a _locals struct AND uses `locals` -> qpi/needs-with-locals,
  // and declares a raw stack local `tmp` -> qpi/stack-local.
  PUBLIC_PROCEDURE(Tally)
  {
    uint64 tmp;
    locals.sum = tmp;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
  {
    REGISTER_USER_PROCEDURE(Tally, 1);
  }
};
