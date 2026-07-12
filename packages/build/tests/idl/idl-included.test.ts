import { CORE_PATH } from "../../../../test-utils/paths";
// Resolving types a contract references but doesn't define in its own .h: (1) the comment-blanking fix, so a
// `// ... struct ...` comment before a real `struct` no longer hides it (QtryGOV); (2) the `prelude` merge, so
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { extractIdl } from "../../src/idl";
import { qpiPrelude } from "../../src/prelude";

const CORE = CORE_PATH;
const have = (c: string) => existsSync(`${CORE}/src/contracts/${c}.h`);
const haveCore = existsSync(`${CORE}/src/contracts/qpi.h`);
const prelude = () => qpiPrelude(CORE);
const idlOf = (c: string, withPrelude = false) =>
  extractIdl(readFileSync(`${CORE}/src/contracts/${c}.h`, "utf8"), c, withPrelude ? { prelude: prelude() } : undefined);

// codec tokens the format string is allowed to contain; anything else alphabetic is an unresolved type name.
const CODEC = new Set(["uint8", "uint16", "uint32", "uint64", "sint8", "sint16", "sint32", "sint64", "bit", "id", "m256i", "uint128", "sint128"]);
const fmts = (idl: ReturnType<typeof extractIdl>) =>
  Object.values({ ...idl.functions, ...idl.procedures }).flatMap((e) => [e.in, e.out].filter(Boolean) as string[]);
function unresolved(idl: ReturnType<typeof extractIdl>): string[] {
  const out = new Set<string>();
  for (const f of fmts(idl)) for (const tok of f.split(/[\s,{}\[\];]+/)) {
    if (/^[A-Za-z_]/.test(tok) && !CODEC.has(tok)) out.add(tok);
  }
  return [...out];
}

test("comment containing a keyword no longer hides the struct that follows", () => {
  const SRC = `
struct CONTRACT_STATE_TYPE : public ContractBase {
  // gov struct
  struct Gov { uint64 fee; id who; };
  struct Set_input { Gov g; }; struct Set_output {};
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Set, 1); }
};`;
  const e = Object.values(extractIdl(SRC, "S").procedures)[0];
  expect(e.in).toBe("{ uint64, id }"); // Gov resolved to its fields, not left as the token "Gov"
  expect(e.inFields[0].struct?.map((f) => f.name)).toEqual(["fee", "who"]);
});

test.skipIf(!have("Quottery"))("Quottery: a struct preceded by a `// gov struct` comment resolves (QtryGOV)", () => {
  const idl = idlOf("Quottery");
  const pv = Object.values({ ...idl.functions, ...idl.procedures }).find((e) => e.name === "ProposalVote")!;
  expect(pv.in).not.toContain("QtryGOV");
  expect(pv.in).toBe("{ uint64, uint64, uint64, sint64, sint64, id }");
});

test.skipIf(!haveCore)("prelude resolves the ambient qpi proposal-voting types (ProposalDataYesNo et al.)", () => {
  // ComputorControlledFund references ProposalDataYesNo / ProposalSingleVoteDataV1 / ProposalSummarizedVotingDataV1
  expect(unresolved(idlOf("ComputorControlledFund"))).toContain("ProposalDataYesNo"); // unresolved WITHOUT prelude
  const withP = unresolved(idlOf("ComputorControlledFund", true));
  expect(withP).not.toContain("ProposalDataYesNo");
  expect(withP).not.toContain("ProposalSingleVoteDataV1");
  expect(withP).not.toContain("ProposalSummarizedVotingDataV1");
});

test.skipIf(!haveCore)("prelude clears every Proposal* type across the governance contracts", () => {
  for (const c of ["ComputorControlledFund", "GeneralQuorumProposal", "TestExampleA", "TestExampleB"].filter(have)) {
    const left = unresolved(idlOf(c, true)).filter((t) => t.startsWith("Proposal"));
    expect(left).toEqual([]);
  }
});

test.skipIf(!haveCore)("SetProposal input expands ProposalDataYesNo to a concrete struct layout", () => {
  const ccf = idlOf("ComputorControlledFund", true);
  const sp = Object.values({ ...ccf.functions, ...ccf.procedures }).find((e) => e.name === "SetProposal")!;
  // the nested proposal struct is now a brace group of concrete codec tokens (no type name leaks)
  expect(sp.in.startsWith("{ ")).toBe(true);
  expect(unresolved({ functions: {}, procedures: { 0: sp } } as any).filter((t) => t.startsWith("Proposal"))).toEqual([]);
});

test("namespace-qualified type resolves to the right interface (suffix match, not bare collision)", () => {
  // two interfaces under namespace OI, each with its OWN nested OracleQuery — a bare-name match would collide
  const prelude = `
namespace OI {
  struct Price { struct OracleQuery { id oracle; uint64 ts; }; };
  struct Mock  { struct OracleQuery { uint64 value; }; };
}`;
  const SRC = `
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Ask_input { OI::Price::OracleQuery p; OI::Mock::OracleQuery m; }; struct Ask_output {};
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Ask, 1); }
};`;
  const e = Object.values(extractIdl(SRC, "S", { prelude }).procedures)[0];
  expect(e.in).toBe("{ id, uint64 }, { uint64 }"); // p -> Price's, m -> Mock's (each its own interface)
  expect(e.inFields[0].struct?.map((f) => f.name)).toEqual(["oracle", "ts"]);
  expect(e.inFields[1].struct?.map((f) => f.name)).toEqual(["value"]);
});

test.skipIf(!have("QUtil"))("prelude include-expansion resolves OI::Price::OracleQuery from the per-interface header", () => {
  const qu = idlOf("QUtil", true);
  const byName = Object.values({ ...qu.functions, ...qu.procedures });
  // OracleQuery = { id oracle; DateAndTime timestamp; id currency1; id currency2 } -> { id, uint64, id, id }
  expect(byName.find((e) => e.name === "QueryPriceOracle")!.in).toBe("{ id, uint64, id, id }, uint32");
  expect(unresolved(idlOf("QUtil", true))).toEqual([]); // QUtil now fully resolved
});

test.skipIf(!haveCore)("a missing prelude degrades gracefully (types stay unknown, no throw)", () => {
  // qpiPrelude over a path without the headers returns "" -> extractIdl still succeeds, types just stay unresolved
  const empty = qpiPrelude("/nonexistent-core-xyz");
  expect(empty.trim()).toBe(""); // no headers found -> no definitions merged
  const idl = extractIdl(readFileSync(`${CORE}/src/contracts/ComputorControlledFund.h`, "utf8"), "CCF", { prelude: empty });
  expect(Object.keys(idl.functions).length + Object.keys(idl.procedures).length).toBeGreaterThan(0);
});
