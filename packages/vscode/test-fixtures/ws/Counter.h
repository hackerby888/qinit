// Minimal, clean QPI contract used by the extension integration tests.
using namespace QPI;

struct Counter : public ContractBase {
  // The Array member arms the clangd field-completion bug the extension's clang fallback covers.
  struct get_input { Array<uint64, 8> history; };
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
