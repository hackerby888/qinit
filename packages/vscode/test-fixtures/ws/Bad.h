// Intentional QPI rule violations for the integration test.
struct Bad : public ContractBase {
  uint64 ratio(uint64 a, uint64 b) { return a / b; }
  void mutate() { const uint64 value = 1; value = 2; }
  uint64 cells[8];
};
