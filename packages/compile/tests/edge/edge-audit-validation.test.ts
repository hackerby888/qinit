import { CORE_PATH } from "../../../../test-utils/paths";
// Regression inventory: invalid QPI/C++ that the compiler currently accepts silently.
import { describe, expect, test } from "bun:test";
import { compileContract, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const wrap = (
  members: string,
  body: string,
  registration = "REGISTER_USER_PROCEDURE(Go, 1);",
) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 a; };
  ${members}
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { ${registration} }
};`;

interface RejectCase {
  source: string;
  diagnostic: RegExp;
}

const CASES: Record<string, RejectCase> = {
  "duplicate default label": {
    source: wrap("", `switch (state.get().a) { default: break; default: break; }`),
    diagnostic: /duplicate.*default|default.*duplicate/i,
  },
  "runtime variable used as a case label": {
    source: wrap("", `uint64 label = 1; switch (state.get().a) { case label: break; }`),
    diagnostic: /case.*constant|constant.*case/i,
  },
  "duplicate case labels after constant folding": {
    source: wrap("", `switch (state.get().a) { case 2: break; case 1 + 1: break; }`),
    diagnostic: /duplicate.*case|case.*duplicate/i,
  },
  "continue in a switch without an enclosing loop": {
    source: wrap("", `switch (state.get().a) { default: continue; }`),
    diagnostic: /continue.*loop|outside.*loop/i,
  },
  "duplicate enumerator name": {
    source: wrap(`enum E { A = 1, A = 2 };`, ``),
    diagnostic: /duplicate.*enumerator|enumerator.*duplicate|already.*defined/i,
  },
  "duplicate struct definition": {
    source: wrap(`struct P { uint64 a; }; struct P { uint64 b; };`, ``),
    diagnostic: /duplicate.*struct|struct.*duplicate|redefinition|already.*defined/i,
  },
  "assignment between unrelated aggregate types": {
    source: wrap(
      `struct P { uint64 a; }; struct Q { uint64 b; };`,
      `P p{}; Q q{}; q.b = 9; p = q; state.mut().a = p.a;`,
    ),
    diagnostic: /incompatible|cannot.*assign|type.*mismatch|conversion/i,
  },
  "unrelated aggregate passed to a helper": {
    source: wrap(
      `struct P { uint64 a; }; struct Q { uint64 b; }; static uint64 read(P p) { return p.a; }`,
      `Q q{}; q.b = 9; state.mut().a = read(q);`,
    ),
    diagnostic: /argument.*type|incompatible|no matching|conversion/i,
  },
  "scalar returned from an aggregate helper": {
    source: wrap(
      `struct P { uint64 a; }; static P make() { return 7; }`,
      `P p = make(); state.mut().a = p.a;`,
    ),
    diagnostic: /return.*type|incompatible|cannot.*convert|conversion/i,
  },
  "non-void helper has a reachable fallthrough path": {
    source: wrap(`static uint64 maybe(uint64 x) { if (x) return 7; }`, `state.mut().a = maybe(0);`),
    diagnostic: /return|fall.*through/i,
  },
  "registered procedure has no implementation body": {
    source: `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct Missing_input {}; struct Missing_output {};
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Missing, 1); }
};`,
    diagnostic: /Missing.*(body|defined|implementation)|missing.*procedure/i,
  },
  "public function mutates persistent state": {
    source: `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 a; };
  struct Get_input {}; struct Get_output { uint64 a; };
  PUBLIC_FUNCTION(Get) { state.mut().a = 7; output.a = state.get().a; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
};`,
    diagnostic: /function.*(read.only|state|mut)|mut\(\).*function/i,
  },
  "public function calls a procedure-only QPI API": {
    source: `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct Get_input {}; struct Get_output { sint64 result; };
  PUBLIC_FUNCTION(Get) { output.result = qpi.transfer(SELF, 1); }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
};`,
    diagnostic: /transfer.*(function|procedure|unavailable)|function.*transfer/i,
  },
};

describe("edge audit — semantic rejection gaps", () => {
  for (const [name, c] of Object.entries(CASES)) {
    test(name, async () => {
      const result = await compileContract({
        source: c.source,
        name: "RejectEdge",
        slot: 27,
        qpiHeader: HEADERS,
        arenaSz: 1 << 20,
      });
      const errors = result.diagnostics.filter((d) => d.severity === "error");

      expect(errors.some((d) => c.diagnostic.test(d.message))).toBe(true);
      expect(result.wasm).toHaveLength(0);
    });
  }
});
