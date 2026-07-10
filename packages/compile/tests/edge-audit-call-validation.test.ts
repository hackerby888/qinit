// Calls to compiler-known QPI/container APIs need the same arity/reference checks as native C++.
// Silently supplying zero for missing operands or dropping extras changes contract behavior.
import { describe, expect, test } from "bun:test";
import { compileContract, loadQpiHeader } from "../src/index";

const HEADERS = loadQpiHeader("/home/kali/Projects/core-lite");

const wrap = (members: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { Array<uint64, 4> values; uint64 result; };
  ${members}
  struct Go_input {}; struct Go_output { sint64 result; };
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

interface RejectCase { source: string; diagnostic: RegExp }

const CASES: Record<string, RejectCase> = {
  "qpi host call is missing an argument": {
    source: wrap("", `output.result = qpi.transfer(SELF);`),
    diagnostic: /transfer.*argument|argument.*transfer|expects.*2|arity/i,
  },
  "qpi host call has an extra argument": {
    source: wrap("", `output.result = qpi.transfer(SELF, 1, 2);`),
    diagnostic: /transfer.*argument|argument.*transfer|expects.*2|arity/i,
  },
  "zero-argument qpi getter is called with an argument": {
    source: wrap("", `state.mut().result = qpi.tick(1);`),
    diagnostic: /tick.*argument|argument.*tick|expects.*0|arity/i,
  },
  "Array.set is missing its value": {
    source: wrap("", `state.mut().values.set(1);`),
    diagnostic: /set.*argument|argument.*set|expects.*2|arity/i,
  },
  "Array.get has an extra index": {
    source: wrap("", `state.mut().result = state.get().values.get(1, 2);`),
    diagnostic: /get.*argument|argument.*get|expects.*1|arity/i,
  },
  "non-const reference binds to a literal": {
    source: wrap(`static void bump(uint64& value) { value += 1; }`, `bump(1);`),
    diagnostic: /reference.*(lvalue|literal)|cannot.*bind|argument.*reference/i,
  },
  "non-const reference binds to a const local": {
    source: wrap(
      `static void bump(uint64& value) { value += 1; }`,
      `const uint64 value = 1; bump(value);`,
    ),
    diagnostic: /reference.*const|cannot.*bind|const.*reference/i,
  },
};

describe("edge audit — call validation", () => {
  for (const [name, c] of Object.entries(CASES)) {
    test(name, async () => {
      const result = await compileContract({
        source: c.source,
        name: "CallRejectEdge",
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
