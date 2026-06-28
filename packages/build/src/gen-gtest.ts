// Scaffold a gtest-style C++ test (core-lite extensions/lite_test.h) from a contract's IDL: one TEST per
// registered procedure/function + an INITIALIZE smoke test, each opening with `ContractTest t;` (the
// fixture-construction pattern core uses, which resets the isolated node per test). The result compiles INTO
// the contract wasm (recipe.ts testSource) and runs in the engine via @qinit/engine runTests().
import type { ContractIdl, IdlEntry } from "./idl";

// A deterministic placeholder seed (55 lowercase chars, a valid Qubic seed) for derived test identities.
const SAMPLE_SEED = "a".repeat(55);

export function genGtest(idl: ContractIdl): string {
  const name = idl.name;
  const procs = Object.entries(idl.procedures);
  const funcs = Object.entries(idl.functions);

  // Some contracts declare a procedure's _input/_output struct in a protected section, so a free-function test
  // can't name `Contract::Foo_input` directly. Re-expose every registered I/O type + StateData through a derived
  // struct (a using-declaration widens protected base members to public — same types, not new ones) and run the
  // tests inside a namespace where `<Name>` resolves to that accessor. This mirrors how core's native fixtures
  // (which inherit the contract) reach those types.
  const usings = [...procs, ...funcs].flatMap(([, e]) => [`  using ::${name}::${e.name}_input;`, `  using ::${name}::${e.name}_output;`]);

  const head = [
    `// gtest-style tests for ${name} — compiled into the contract wasm and run in the qinit/IDE engine`,
    `// (no native toolchain). Each TEST constructs ContractTest, which resets a fresh, isolated genesis`,
    `// node and re-runs INITIALIZE, so tests never see each other's state or the live session.`,
    `// Run: \`qinit gtest\` (Bun) or the IDE "Run gtest" button (browser). Macros: EXPECT_EQ/NE/LT/.., ASSERT_*.`,
  ].join("\n");

  const accessor = [
    `namespace gtest_sc {`,
    `// Re-expose the contract's registered I/O types + StateData so the tests below can name them (some are`,
    `// declared protected). A using-declaration in a derived struct widens access; the types are unchanged.`,
    `struct ${name} : public ::${name} {`,
    ...usings,
    `  using ::${name}::StateData;`,
    `};`,
  ].join("\n");

  const blocks: string[] = [];
  blocks.push(
    [
      `TEST(${name}, Initialize) {`,
      `    ContractTest t;   // the ctor runs INITIALIZE on a clean genesis ledger`,
      `    // TODO: assert the initial state, e.g. EXPECT_EQ(t.state<${name}::StateData>().someField, 0ull);`,
      `}`,
    ].join("\n"),
  );
  for (const [it, e] of procs) {
    blocks.push(procTest(name, it, e));
  }
  for (const [it, e] of funcs) {
    blocks.push(funcTest(name, it, e));
  }

  return `${head}\n\n${accessor}\n\n${blocks.join("\n\n")}\n\n} // namespace gtest_sc\n`;
}

// A user PROCEDURE (state-mutating): fund + originate from a derived identity, invoke, then assert.
function procTest(name: string, it: string, e: IdlEntry): string {
  return [
    `TEST(${name}, ${e.name}) {`,
    `    ContractTest t;`,
    `    QPI::id user = t.idFromSeed("${SAMPLE_SEED}");`,
    `    t.fund(user, 1000000000);   // balance for the invocation reward / any transfer`,
    ``,
    `    ${name}::${e.name}_input in{};`,
    `    // TODO: set in.<field> = ...;`,
    `    ${name}::${e.name}_output out = t.invoke<${name}::${e.name}_output>(${it}, in, 0, user);`,
    `    (void)out;`,
    `    // TODO: EXPECT_EQ(out.<field>, ...);  and/or  EXPECT_EQ(t.state<${name}::StateData>().<field>, ...);`,
    `}`,
  ].join("\n");
}

// A user FUNCTION (read-only): call + assert on the output.
function funcTest(name: string, it: string, e: IdlEntry): string {
  return [
    `TEST(${name}, ${e.name}) {`,
    `    ContractTest t;`,
    ``,
    `    ${name}::${e.name}_input in{};`,
    `    // TODO: set in.<field> = ...;`,
    `    ${name}::${e.name}_output out = t.call<${name}::${e.name}_output>(${it}, in);`,
    `    (void)out;`,
    `    // TODO: EXPECT_EQ(out.<field>, ...);`,
    `}`,
  ].join("\n");
}
