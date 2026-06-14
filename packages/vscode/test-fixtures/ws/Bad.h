// Intentional QPI rule violations for the Tier-A diagnostics integration test:
//   `a / b`  -> qpi/no-division     (use div())
//   cells[8] -> qpi/no-brackets     (use Array<T, N>)
struct Bad : public ContractBase {
  uint64 ratio(uint64 a, uint64 b) { return a / b; }
  uint64 cells[8];
};
