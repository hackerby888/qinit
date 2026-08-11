using namespace QPI;

struct Counter : public ContractBase {
  struct StateData { uint64 value; };
  // The Array member arms the clangd field-completion bug the extension's clang fallback covers.
  struct Get_input {
    Array<uint64, 8> history;
    sint16 offset;
  };
  struct Get_output { uint64 value; };

  PUBLIC_FUNCTION(Get) {
    output.value = state.get().value;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Get, 1);
  }
};
