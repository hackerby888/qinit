// The sibling of the struct-name matrix, for templates. A contract may declare its own `Array` or
// `Collection`; C++ resolves the nested one, while an instance keyed by name and arguments alone lets
// the contract's instantiation and core's claim the same key.
import { beforeAll, describe, expect } from "bun:test";
import { initK12 } from "@qinit/core";
import { SCALAR_SIZE } from "../../src/shared/scalar-sizes";
import { coreTemplateNamesWithMethods } from "../support/core-struct-names";
import { edgeRunner } from "../support/edge-compile";
import { fixtureTest } from "../support/fixture-shapes";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";

const run = edgeRunner("CoreTemplateCollision");

// The fixture is built from these, so it cannot also shadow them.
const SKELETON_NAMES = new Set(["ContractBase", "StateData", "ContractState"]);

const shadowable = (name: string) => !SKELETON_NAMES.has(name) && SCALAR_SIZE[name] === undefined;

// Two parameters whatever arity core gives the name it shares: a nested declaration hides the outer
// one whole, so the contract's own parameter list is the only one in scope.
const fixture = (name: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  template <typename T, uint64 L> struct ${name} {
    T slots[L];
    uint64 own() const { return L * 10 + 2; }
  };
  struct StateData { uint64 result; };
  struct Go_input {}; struct Go_output {};
  struct Go_locals { ${name}<uint64, 4> probe; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Go) {
    state.mut().result = locals.probe.own();
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

describe.skipIf(!HAS_CORE)("a nested template keeps its own body", () => {
    beforeAll(initK12);

    for (const name of HAS_CORE ? coreTemplateNamesWithMethods(CORE_PATH).filter(shadowable) : []) {
        fixtureTest(`shadowing core's ${name}`, async () => {
            // `own()` reads the contract's own L. Core's same-named template declares no such method,
            // so answering 42 means the contract's instantiation was the one compiled.
            expect(await run(fixture(name))).toBe(42n);
        });
    }
});
