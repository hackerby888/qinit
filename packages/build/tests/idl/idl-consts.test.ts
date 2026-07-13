import { CORE_PATH } from "../../../../test-utils/paths";
// constexpr array-size resolution: the qpi math helpers come in a templated form (div<uint64>(a,b)) AND a plain
// form (div(a,b)). The size evaluator only rewrote the templated form, so a contract sizing an array with the
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { extractIdl } from "../../src/idl";
import { qpiPrelude } from "../../src/prelude";

test("non-templated div() in a constexpr (chained) resolves the dependent array size", () => {
  // mirrors QThirtyFour: a const defined with the plain div() form, the array sized by the const NAME
  const SRC = `
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct M_input { Array<uint8, NVALS> a; }; struct M_output {};
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(M, 1); }
};
constexpr uint64 MAXP = 1024;
constexpr uint64 RVC = 4;
constexpr uint64 NVALS = div(MAXP, 4) * RVC;`;
  const e = Object.values(extractIdl(SRC, "S").procedures)[0];
  expect(e.in).toBe("[1024;uint8]"); // div(1024,4) * 4 = 1024
});

test("templated and plain forms both resolve (div<T>(a,b) and mod(a,b))", () => {
  const SRC = `
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct M_input { Array<uint8, A> a; Array<uint8, B> b; }; struct M_output {};
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(M, 1); }
};
constexpr uint64 N = 12;
constexpr uint64 A = div<uint64>(N, 2);
constexpr uint64 B = mod(N, 3);`;
  const e = Object.values(extractIdl(SRC, "S").procedures)[0];
  expect(e.in).toBe("[6;uint8], [0;uint8]"); // div(12,2)=6 ; mod(12,3)=0
});

const QTF = CORE_PATH + "/src/contracts/QThirtyFour.h";
test.skipIf(!existsSync(QTF))(
  "real QThirtyFour: BuyTicketsBatch array size resolves (was a leaked const name)",
  () => {
    const idl = extractIdl(readFileSync(QTF, "utf8"), "QThirtyFour", {
      prelude: qpiPrelude(CORE_PATH),
    });
    const e = Object.values({ ...idl.functions, ...idl.procedures }).find(
      (x) => x.name === "BuyTicketsBatch",
    )!;
    // QTF_BATCH_TICKET_VALUES_COUNT = div(QTF_MAX_NUMBER_OF_PLAYERS=1024, 4) * QTF_RANDOM_VALUES_COUNT=4 = 1024
    expect(e.in).toBe("[1024;uint8]");
    expect(e.in).not.toContain("QTF_"); // no constant name leaked
  },
);
