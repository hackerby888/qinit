// QPI registration rules enforced by the native macros must also be enforced by the local compiler.
import { describe, expect, test } from "bun:test";
import { compileContract, loadQpiHeader } from "../src/index";

const HEADERS = loadQpiHeader("/home/kali/Projects/core-lite");

interface RejectCase { source: string; diagnostic: RegExp }

const contract = (members: string, registration: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  ${members}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { ${registration} }
};`;

const CASES: Record<string, RejectCase> = {
  "input type zero": {
    source: contract(
      `struct P_input {}; struct P_output {}; PUBLIC_PROCEDURE(P) {}`,
      `REGISTER_USER_PROCEDURE(P, 0);`,
    ),
    diagnostic: /input.?type.*1.*65535|input.?type.*range/i,
  },
  "input type above uint16 range": {
    source: contract(
      `struct P_input {}; struct P_output {}; PUBLIC_PROCEDURE(P) {}`,
      `REGISTER_USER_PROCEDURE(P, 65536);`,
    ),
    diagnostic: /input.?type.*1.*65535|input.?type.*range/i,
  },
  "procedure registered as a function": {
    source: contract(
      `struct P_input {}; struct P_output {}; PUBLIC_PROCEDURE(P) {}`,
      `REGISTER_USER_FUNCTION(P, 1);`,
    ),
    diagnostic: /P.*procedure|procedure.*function|registration.*kind/i,
  },
  "function registered as a procedure": {
    source: contract(
      `struct F_input {}; struct F_output {}; PUBLIC_FUNCTION(F) {}`,
      `REGISTER_USER_PROCEDURE(F, 1);`,
    ),
    diagnostic: /F.*function|function.*procedure|registration.*kind/i,
  },
  "procedure input exceeds MAX_INPUT_SIZE": {
    source: contract(
      `struct P_input { uint8 bytes[1025]; }; struct P_output {}; PUBLIC_PROCEDURE(P) {}`,
      `REGISTER_USER_PROCEDURE(P, 1);`,
    ),
    diagnostic: /input.*(too large|1024|MAX_INPUT_SIZE)/i,
  },
  "entry output exceeds uint16 metadata": {
    source: contract(
      `struct F_input {}; struct F_output { uint8 bytes[65536]; }; PUBLIC_FUNCTION(F) {}`,
      `REGISTER_USER_FUNCTION(F, 1);`,
    ),
    diagnostic: /output.*(too large|65535)/i,
  },
  "entry locals exceed MAX_SIZE_OF_CONTRACT_LOCALS": {
    source: contract(
      `struct P_input {}; struct P_output {}; struct P_locals { uint8 bytes[32769]; };
       PUBLIC_PROCEDURE_WITH_LOCALS(P) {}`,
      `REGISTER_USER_PROCEDURE(P, 1);`,
    ),
    diagnostic: /locals.*(too large|32768|MAX_SIZE)/i,
  },
  "entry body has no input/output declarations": {
    source: contract(`PUBLIC_PROCEDURE(P) {}`, `REGISTER_USER_PROCEDURE(P, 1);`),
    diagnostic: /P_(input|output).*missing|unknown.*P_(input|output)|entry.*type/i,
  },
  "plain entry macro is paired with an explicit locals struct": {
    source: contract(
      `struct P_input {}; struct P_output {}; struct P_locals { uint64 value; };
       PUBLIC_PROCEDURE(P) { locals.value = 1; }`,
      `REGISTER_USER_PROCEDURE(P, 1);`,
    ),
    diagnostic: /P_locals|WITH_LOCALS|locals.*form/i,
  },
};

describe("edge audit — QPI ABI validation", () => {
  for (const [name, c] of Object.entries(CASES)) {
    test(name, async () => {
      const result = await compileContract({
        source: c.source,
        name: "AbiRejectEdge",
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
