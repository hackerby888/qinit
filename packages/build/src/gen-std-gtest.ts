// Scaffold a STANDARD gtest (core-lite `contract_testing.h`) from a contract's IDL — the real Qubic SC-test
// format (a `ContractTesting<Name>` fixture over the `ContractTesting` base, one TEST per procedure/function).
import type { ContractIdl, IdlEntry } from "./idl";

const SAMPLE_SEED_ID = "id::randomValue()";

export function genStdGtest(idl: ContractIdl, name: string, stateType: string = name): string {
  const T = stateType; // the C++ contract struct type (== name for user contracts)
  const procs = Object.entries(idl.procedures); // [index, IdlEntry]
  const funcs = Object.entries(idl.functions);

  const head = [
    `// Standard gtest for ${name} (core-lite contract_testing.h) — the real Qubic SC-test format.`,
    `// Run: \`qinit gtest\` (native clang) or \`qinit gtest --local\` (our TS compiler). Each TEST builds a fresh`,
    `// ContractTesting${name}, whose ctor resets an isolated genesis ledger and re-runs INITIALIZE.`,
    `#define NO_UEFI`,
    ``,
    `#include "contract_testing.h"`,
  ].join("\n");

  // A wrapper method per registered entry (mirrors how core's fixtures expose the contract): default-init the
  // input, drive it through the harness, return the output.
  const wrapper = (it: string, e: IdlEntry, kind: "proc" | "func"): string => {
    const call = kind === "proc"
      ? `        invokeUserProcedure(${T}_CONTRACT_INDEX, ${it}, in, out, user, amount);`
      : `        callFunction(${T}_CONTRACT_INDEX, ${it}, in, out);`;
    const sig = kind === "proc"
      ? `    ${T}::${e.name}_output ${lc(e.name)}(const id& user, sint64 amount = 0)`
      : `    ${T}::${e.name}_output ${lc(e.name)}() const`;
    return [
      sig,
      `    {`,
      `        ${T}::${e.name}_input in{};`,
      `        // TODO: set in.<field> = ...;`,
      `        ${T}::${e.name}_output out{};`,
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
    `        INIT_CONTRACT(${T});`,
    `        callSystemProcedure(${T}_CONTRACT_INDEX, INITIALIZE);`,
    `    }`,
    ``,
    `    void fund(const id& account, uint64 amount) { increaseEnergy(account, amount); }`,
    `    uint64 balanceOf(const id& account) const { return static_cast<uint64>(getBalance(account)); }`,
    ...procs.flatMap(([it, e]) => ["", wrapper(it, e, "proc")]),
    ...funcs.flatMap(([it, e]) => ["", wrapper(it, e, "func")]),
    `};`,
  ].join("\n");

  const initTest = [
    `TEST(${name}, Initialize)`,
    `{`,
    `    ContractTesting${name} t;   // ctor ran INITIALIZE on a clean genesis ledger`,
    `    // TODO: assert the initial state via a checker over contractStates[${T}_CONTRACT_INDEX].`,
    `}`,
  ].join("\n");

  const procTest = (e: IdlEntry): string => [
    `TEST(${name}, ${e.name})`,
    `{`,
    `    ContractTesting${name} t;`,
    `    const id user = ${SAMPLE_SEED_ID};`,
    `    t.fund(user, 1000000000);   // balance for the invocation reward / any transfer`,
    ``,
    `    ${T}::${e.name}_output out = t.${lc(e.name)}(user);`,
    `    (void)out;`,
    `    // TODO: EXPECT_EQ(out.<field>, ...);`,
    `}`,
  ].join("\n");

  const funcTest = (e: IdlEntry): string => [
    `TEST(${name}, ${e.name})`,
    `{`,
    `    ContractTesting${name} t;`,
    ``,
    `    ${T}::${e.name}_output out = t.${lc(e.name)}();`,
    `    (void)out;`,
    `    // TODO: EXPECT_EQ(out.<field>, ...);`,
    `}`,
  ].join("\n");

  const tests = [
    initTest,
    ...procs.map(([, e]) => procTest(e)),
    ...funcs.map(([, e]) => funcTest(e)),
  ].join("\n\n");

  return `${head}\n\n${fixture}\n\n${tests}\n`;
}

function lc(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
