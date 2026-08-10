using namespace QPI;

struct Proxy : public ContractBase {
  struct Read_input {};
  struct Read_output { uint64 value; };
  struct Read_locals {
    Counter::Get_input input;
    Counter::Get_output output;
  };

  PUBLIC_FUNCTION_WITH_LOCALS(Read) {
    CALL_OTHER_CONTRACT_FUNCTION(
      Counter,
      Get,
      locals.input,
      locals.output
    );
    output.value = locals.output.value;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
  }
};
