// A notification procedure is dispatched by the node with an oracle reply, so the generated client must not offer it as a method.
import { test, expect } from "bun:test";
import { extractIdl } from "../../src/compile/idl";
import { generateClient } from "../../src/generate/client";

const SRC = `
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Inc_input {}; struct Inc_output {};
  struct OnReply_input { sint64 queryId; sint32 subscriptionId; uint8 status; }; struct OnReply_output {};
  PUBLIC_PROCEDURE(Inc) {}
  PUBLIC_PROCEDURE(OnReply) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Inc, 1);
    REGISTER_USER_PROCEDURE(OnReply, 2);
  }
};`;

test("a notification entry gets no client method; the other procedures keep theirs", () => {
    const idl = extractIdl(SRC, "Demo");
    const onReply = idl.procedures.find((entry) => entry.name === "OnReply")!;
    onReply.notification = true;
    const out = generateClient(idl, 28);
    expect(out.includes("async Inc(")).toBe(true);
    expect(out.includes("async OnReply(")).toBe(false);
    expect(out.includes("procedureId: 2")).toBe(false);
});
