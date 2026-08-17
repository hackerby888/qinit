using namespace QPI;

struct Counter : public ContractBase {
  struct StateData { uint64 value; };
  // `Detail` is spelled bare here but registered qualified, and both structs carry a template member —
  // the shape the clangd field-completion bug answers with an empty list.
  struct Detail {
    Array<uint64, 4> tags;
    sint16 rank;
  };
  struct Get_input {
    Array<uint64, 8> history;
    sint16 offset;
    Detail detail;
  };
  struct Get_output { uint64 value; };

  PUBLIC_FUNCTION(Get) {
    output.value = state.get().value;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Get, 1);
  }
};
