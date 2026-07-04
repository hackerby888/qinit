// Minimal counter contract: a single uint64 of state, a read function, and an increment procedure.
using namespace QPI;

struct CONTRACT_STATE2_TYPE {};

struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    uint64 count;
  };

  struct Get_input {};
  struct Get_output {
    uint64 value;
  };
  struct Get_locals {};

  struct Increment_input {
    uint64 by;
  };
  struct Increment_output {};
  struct Increment_locals {};

  PUBLIC_FUNCTION(Get)
  {
    output.value = state.get().count;
  }

  PUBLIC_PROCEDURE(Increment)
  {
    state.mut().count += input.by;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
  {
    REGISTER_USER_FUNCTION(Get, 1);
    REGISTER_USER_PROCEDURE(Increment, 1);
  }
};
