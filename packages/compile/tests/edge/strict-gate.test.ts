import { CORE_PATH } from "../../../../test-utils/paths";
// Ensures placeholder lowerings fail strict builds instead of silently diverging.
import { describe, expect, test } from "bun:test";
import { compileContract, loadQpiHeader } from "../../src/index";

const HEADERS = loadQpiHeader(CORE_PATH);

// An unresolved constant exercises the placeholder fallback guarded by strict mode.
const SRC = `
using namespace QPI;

struct CONTRACT_STATE2_TYPE {};

struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    uint64 x;
  };

  struct Probe_input {};
  struct Probe_output {
    uint64 v;
  };
  PUBLIC_FUNCTION(Probe)
  {
    output.v = UNKNOWN_FIDELITY_CONST;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
  {
    REGISTER_USER_FUNCTION(Probe, 1);
  }
};
`;

describe("strict fidelity gate", () => {
  test("default (strict) aborts with an error and empty wasm", async () => {
    const r = await compileContract({
      source: SRC,
      name: "StrictProbe",
      slot: 28,
      qpiHeader: HEADERS,
    });

    expect(r.wasm.length).toBe(0);
    const errs = r.diagnostics.filter((d) => d.severity === "error");
    expect(errs.length).toBeGreaterThan(0);
    expect(
      errs.some(
        (d) =>
          d.category === "fidelity" &&
          /unknown identifier 'UNKNOWN_FIDELITY_CONST'/.test(d.message),
      ),
    ).toBe(true);
  });

  test("strict: false keeps the legacy placeholder build, warning only", async () => {
    const r = await compileContract({
      source: SRC,
      name: "StrictProbe",
      slot: 28,
      qpiHeader: HEADERS,
      strict: false,
    });

    expect(r.wasm.length).toBeGreaterThan(0);
    expect(r.diagnostics.some((d) => d.severity === "error")).toBe(false);
    expect(r.diagnostics.some((d) => d.severity === "warning" && d.category === "fidelity")).toBe(
      true,
    );
  });

  test("a clean contract passes strict untouched", async () => {
    const clean = SRC.replace("UNKNOWN_FIDELITY_CONST", "input.v + 1").replace(
      "struct Probe_input {};",
      "struct Probe_input { uint64 v; };",
    );
    const r = await compileContract({
      source: clean,
      name: "StrictProbe",
      slot: 28,
      qpiHeader: HEADERS,
    });

    expect(r.diagnostics.filter((d) => d.severity === "error").length).toBe(0);
    expect(r.wasm.length).toBeGreaterThan(0);
  });
});
