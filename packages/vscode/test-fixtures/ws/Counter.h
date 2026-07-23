// Minimal, clean QPI contract used by the extension integration tests.
using namespace QPI;

struct Counter : public ContractBase {
  struct get_input {};
  struct get_output { uint64 value; };
  struct increment_input { uint64 by; };
  struct increment_output {};

  PUBLIC_FUNCTION(get) { }
  PUBLIC_PROCEDURE(increment) { }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(get, 1);
    REGISTER_USER_PROCEDURE(increment, 1);
  }
};
