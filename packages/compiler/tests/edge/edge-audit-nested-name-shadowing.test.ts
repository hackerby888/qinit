// A contract struct named like a container's private nested struct (LinkedList::Node, Collection::Element) is a
// template argument bound in the contract's scope; the container's own struct must not shadow it once its body compiles.
import { describe, expect, test } from "bun:test";
import { HAS_CORE } from "../../../../test-utils/paths";
import { edgeRunner } from "../support/edge-compile";

const run = edgeRunner("ShadowProbe");

const contract = (element: string, state: string, locals: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct ${element} { uint64 tag; uint64 other; };
  struct StateData { uint64 a; ${state} };
  struct Go_input {}; struct Go_output {};
  struct Go_locals { ${locals} };
  PUBLIC_PROCEDURE_WITH_LOCALS(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

const CASES: Record<string, string> = {
    "LinkedList<Node> keeps the contract's Node": contract(
        "Node",
        "LinkedList<Node, 8> l;",
        "Node n;",
        "locals.n.tag = 4242; state.mut().l.addTail(locals.n); state.mut().a = state.get().l.element(state.get().l.headIndex()).tag;",
    ),
    "Collection<Element> keeps the contract's Element": contract(
        "Element",
        "Collection<Element, 8> coll;",
        "Element e; sint64 idx;",
        "locals.e.tag = 4242; locals.idx = state.mut().coll.add(SELF, locals.e, 1); state.mut().a = state.get().coll.element(locals.idx).tag;",
    ),
};

describe.skipIf(!HAS_CORE)("template arguments named like a container's nested struct", () => {
    for (const [name, source] of Object.entries(CASES)) {
        test(name, async () => {
            expect(await run(source)).toBe(4242n);
        }, 120000);
    }
});
