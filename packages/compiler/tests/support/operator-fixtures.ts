// Fixtures shared by the operator suites: the fast one asserts what each body should compute, the
// differential one asserts Clang computes the same thing from the same source.

/** One probe contract: declarations, procedure locals, and a body that writes StateData.result. */
export const wrapOperatorFixture = (declarations: string, locals: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  ${declarations}
  struct StateData { uint64 result; };
  struct Go_input {}; struct Go_output {};
  struct Go_locals { ${locals} };
  PUBLIC_PROCEDURE_WITH_LOCALS(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

// operator== deliberately ignores `b`, so {1,2} and {1,99} are equal to the operator and different to
// memcmp. Every assertion on it turns on that disagreement.
export const HALF_KEY = `struct HalfKey {
    uint64 a;
    uint64 b;
    bit operator==(const HalfKey& other) const { return a == other.a; }
  };`;

// The constructor scales, so a field-wise fallback that skipped it stores 5 where the body stores 51.
export const FEE_AMOUNT = `struct FeeAmount {
    uint64 qus;
    FeeAmount() { qus = 0; }
    FeeAmount(uint64 value) { qus = value * 10 + 1; }
    bit operator==(const FeeAmount& other) const { return qus == other.qus; }
  };`;

// operator+ returns the class, so a comparison against its result has no addressable operand.
export const MONEY = `struct Money {
    uint64 qus;
    Money() { qus = 0; }
    Money(uint64 value) { qus = value * 10 + 1; }
    Money operator+(const Money& other) const { return Money((qus + other.qus - 2) / 10); }
    bit operator==(const Money& other) const { return qus == other.qus; }
  };`;

// Both bodies compute something a memberwise copy would not.
export const ASSIGNING = `struct Box {
    uint64 v;
    Box& operator=(const Box& other) { v = other.v * 2; return *this; }
    Box& operator+=(const Box& other) { v = v + other.v + 100; return *this; }
  };`;

// A helper returns the class by value, so a comparison's left operand is a call with no home.
export const HELPER_MONEY = `struct Money {
    uint64 qus;
    Money() { qus = 0; }
    Money(uint64 value) { qus = value; }
    bit operator==(const Money& other) const { return qus == other.qus; }
  };
  static Money makeMoney(uint64 value) { Money m; m.qus = value; return m; }`;
