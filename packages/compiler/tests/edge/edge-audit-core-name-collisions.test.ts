// A contract may nest a struct under a name core already declares. C++ resolves the nested one; the
// compiler indexes types and methods by name, so the two can be confused silently. The names come from
// core rather than a frozen list, so the matrix follows upstream instead of yesterday's headers.
import { beforeAll, describe, expect } from "bun:test";
import { initK12 } from "@qinit/core";
import { SCALAR_SIZE } from "../../src/shared/scalar-sizes";
import { coreStructNamesWithMethods } from "../support/core-struct-names";
import { edgeRunner } from "../support/edge-compile";
import { fixtureTest } from "../support/fixture-shapes";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";

const run = edgeRunner("CoreNameCollision");

// The fixture is built from these, so it cannot also shadow them.
const SKELETON_NAMES = new Set(["ContractBase", "StateData"]);

const shadowable = (name: string) => !SKELETON_NAMES.has(name) && SCALAR_SIZE[name] === undefined;

const fixture = (name: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct ${name} {
    uint64 marker;
    ${name}() { marker = 41; }
    uint64 own() const { return marker + 1; }
  };
  struct StateData { uint64 result; };
  struct Go_input {}; struct Go_output {};
  struct Go_locals { ${name} probe; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Go) {
    locals.probe = ${name}();
    state.mut().result = locals.probe.own();
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

describe.skipIf(!HAS_CORE)("a nested struct keeps its own layout and methods", () => {
    beforeAll(initK12);

    for (const name of HAS_CORE ? coreStructNamesWithMethods(CORE_PATH).filter(shadowable) : []) {
        fixtureTest(`shadowing core's ${name}`, async () => {
            // The constructor keys as `${name}/0`, the same key core's type claims, and only the
            // contract's own body sets marker. Its own `own()` then answers 42.
            expect(await run(fixture(name))).toBe(42n);
        });
    }
});
