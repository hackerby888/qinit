// A contract struct named like a container's private nested struct (LinkedList::Node, Collection::Element, Collection::PoV) is a
// template argument bound in the contract's scope; the container's own struct must not shadow it once its body compiles.
import { describe, expect } from "bun:test";
import { HAS_CORE } from "../../../../test-utils/paths";
import { edgeClangRunner } from "../support/edge-compile";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";

const run = edgeClangRunner("ShadowProbe");

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
    "Collection<PoV> keeps the contract's PoV": contract(
        "PoV",
        "Collection<PoV, 8> coll;",
        "PoV e; sint64 idx;",
        "locals.e.tag = 4242; locals.idx = state.mut().coll.add(SELF, locals.e, 1); state.mut().a = state.get().coll.element(locals.idx).tag;",
    ),
    "HashMap<uint64, Element> keeps the contract's Element": contract(
        "Element",
        "HashMap<uint64, Element, 8> map;",
        "Element e; Element found;",
        "locals.e.tag = 4242; state.mut().map.set(1, locals.e); state.get().map.get(1, locals.found); state.mut().a = locals.found.tag;",
    ),
    // HashSet nests no struct, so this one only guards; a set key needs operator==, which the shared element shape lacks.
    "HashSet<Element> keeps the contract's Element": contract(
        "Element",
        "HashSet<Element, 8> set;",
        "Element e;",
        "locals.e.tag = 4242; state.mut().set.add(locals.e); state.mut().a = state.get().set.contains(locals.e) ? locals.e.tag : 0;",
    ).replace("uint64 other; };", "uint64 other; bool operator==(const Element& rhs) const { return tag == rhs.tag && other == rhs.other; } };"),
};

describe.skipIf(!HAS_CORE)("template arguments named like a container's nested struct", () => {
    for (const [name, source] of Object.entries(CASES)) {
        toolchainTest(name, wasiToolchain(), async () => {
            expect(await run(source)).toBe(4242n);
        });
    }
});
