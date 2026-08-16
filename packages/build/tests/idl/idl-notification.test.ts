// REGISTER_USER_PROCEDURE_NOTIFICATION ids are (CONTRACT_INDEX << 22) | __LINE__ truncated to 16 bits, where
// __LINE__ is the raw-source line of the procedure's macro. Preprocessing shifts spans, so this pins the
// value the node's registry actually reports — a mismatch silently unnames the entry everywhere.
import { expect, test } from "bun:test";
import { extractIdl } from "../../src/compile/idl";

const HEAD = `
using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 counter; };
`;

const TAIL = `
  typedef OracleNotificationInput<OI::Price> Notify_input;
  typedef NoData Notify_output;
  struct Notify_locals { uint64 pad; };
  PRIVATE_PROCEDURE_WITH_LOCALS(Notify)
  {
    state.mut().counter = 1;
  }

  typedef uint64 Bump_input;
  typedef NoData Bump_output;
  PUBLIC_PROCEDURE(Bump)
  {
    state.mut().counter = input;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Bump, 1);
    REGISTER_USER_PROCEDURE_NOTIFICATION(Notify);
  }
};
`;

// Pad between the head and the declarations so the notification's source line is unmistakably not the
// preprocessed one — without padding the two can coincide and the regression hides.
const source = (padLines: number) => HEAD + "\n".repeat(padLines) + TAIL;

const notifyLine = (text: string) => text.split("\n").findIndex((line) => line.includes("PRIVATE_PROCEDURE_WITH_LOCALS(Notify)")) + 1;

test("a notification procedure's inputType is its raw-source line", () => {
    for (const padLines of [0, 40, 137]) {
        const text = source(padLines);
        const idl = extractIdl(text, "Contract", { slot: 4 });
        const notify = idl.procedures.find((entry) => entry.name === "Notify");

        expect(notify).toBeDefined();
        expect(notify!.inputType).toBe(notifyLine(text) & 0xffff);
    }
});

test("only the notification procedure is flagged as one", () => {
    const idl = extractIdl(source(0), "Contract", { slot: 4 });

    expect(idl.procedures.find((entry) => entry.name === "Notify")!.notification).toBe(true);
    expect(idl.procedures.find((entry) => entry.name === "Bump")!.notification).toBeUndefined();
});
