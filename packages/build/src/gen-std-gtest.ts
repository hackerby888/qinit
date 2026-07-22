// Scaffold a STANDARD gtest (core-lite `contract_testing.h`) from a contract's IDL — the real Qubic SC-test
// format (a `ContractTesting<Name>` fixture over the `ContractTesting` base, one TEST per procedure/function).
import type { ContractIdl, IdlEntry } from "./idl";

const SAMPLE_SEED_ID = "id::randomValue()";

export function genStdGtest(idl: ContractIdl, name: string, stateType: string = name): string {
  const contractType = stateType;
  const procedures = Object.entries(idl.procedures);
  const functions = Object.entries(idl.functions);

  const head = [
    `// Standard gtest for ${name} (core-lite contract_testing.h) — the real Qubic SC-test format.`,
    `// Run: \`qinit gtest\` (native clang) or \`qinit gtest --local\` (our TS compiler). Each TEST builds a fresh`,
    `// ContractTesting${name}, whose ctor resets an isolated genesis ledger and re-runs INITIALIZE.`,
    `#define NO_UEFI`,
    ``,
    `#include "contract_testing.h"`,
  ].join("\n");

  // Each registered entry gets a wrapper that initializes input, invokes the harness, and returns output.
  const wrapper = (inputTypeId: string, entry: IdlEntry, kind: "proc" | "func"): string => {
    const call = kind === "proc"
      ? `        invokeUserProcedure(${contractType}_CONTRACT_INDEX, ${inputTypeId}, in, out, user, amount);`
      : `        callFunction(${contractType}_CONTRACT_INDEX, ${inputTypeId}, in, out);`;
    const sig = kind === "proc"
      ? `    ${contractType}::${entry.name}_output ${lowercaseFirst(entry.name)}(const id& user, sint64 amount = 0)`
      : `    ${contractType}::${entry.name}_output ${lowercaseFirst(entry.name)}() const`;
    return [
      sig,
      `    {`,
      `        ${contractType}::${entry.name}_input in{};`,
      `        // TODO: set in.<field> = ...;`,
      `        ${contractType}::${entry.name}_output out{};`,
      call,
      `        return out;`,
      `    }`,
    ].join("\n");
  };

  const fixture = [
    `class ContractTesting${name} : protected ContractTesting`,
    `{`,
    `public:`,
    `    ContractTesting${name}()`,
    `    {`,
    `        initEmptySpectrum();`,
    `        initEmptyUniverse();`,
    `        INIT_CONTRACT(${contractType});`,
    `        callSystemProcedure(${contractType}_CONTRACT_INDEX, INITIALIZE);`,
    `    }`,
    ``,
    `    void fund(const id& account, uint64 amount) { increaseEnergy(account, amount); }`,
    `    uint64 balanceOf(const id& account) const { return static_cast<uint64>(getBalance(account)); }`,
    ...procedures.flatMap(([inputType, entry]) => ["", wrapper(inputType, entry, "proc")]),
    ...functions.flatMap(([inputType, entry]) => ["", wrapper(inputType, entry, "func")]),
    `};`,
  ].join("\n");

  const initTest = [
    `TEST(${name}, Initialize)`,
    `{`,
    `    ContractTesting${name} t;   // ctor ran INITIALIZE on a clean genesis ledger`,
    `    // TODO: assert the initial state via a checker over contractStates[${contractType}_CONTRACT_INDEX].`,
    `}`,
  ].join("\n");

  const procTest = (e: IdlEntry): string => [
    `TEST(${name}, ${e.name})`,
    `{`,
    `    ContractTesting${name} t;`,
    `    const id user = ${SAMPLE_SEED_ID};`,
    `    t.fund(user, 1000000000);   // balance for the invocation reward / any transfer`,
    ``,
    `    ${contractType}::${e.name}_output out = t.${lowercaseFirst(e.name)}(user);`,
    `    (void)out;`,
    `    // TODO: EXPECT_EQ(out.<field>, ...);`,
    `}`,
  ].join("\n");

  const funcTest = (e: IdlEntry): string => [
    `TEST(${name}, ${e.name})`,
    `{`,
    `    ContractTesting${name} t;`,
    ``,
    `    ${contractType}::${e.name}_output out = t.${lowercaseFirst(e.name)}();`,
    `    (void)out;`,
    `    // TODO: EXPECT_EQ(out.<field>, ...);`,
    `}`,
  ].join("\n");

  const tests = [
    initTest,
    ...procedures.map(([, entry]) => procTest(entry)),
    ...functions.map(([, entry]) => funcTest(entry)),
  ].join("\n\n");

  return `${head}\n\n${fixture}\n\n${tests}\n`;
}

function lowercaseFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
