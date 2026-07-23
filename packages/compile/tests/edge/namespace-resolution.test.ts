import { DiagnosticSeverity } from "../../src/enums";
import { CORE_PATH } from "../../../../test-utils/paths";
// Namespace-aware free-helper resolution: using-directives, qualified forms, no accidental QPI fallback.
import { describe, expect, test } from "bun:test";
import { compileContract, loadQpiHeader } from "../../src/index";

const HEADERS = loadQpiHeader(CORE_PATH);

const compile = (source: string, strict = true) =>
  compileContract({ source, name: "NsProbe", slot: 28, qpiHeader: HEADERS, strict });

const contractShell = (prelude: string, body: string, members = "") => `${prelude}
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 x; };
  ${members}
  struct Go_input { uint64 v; };
  struct Go_output { uint64 r; };
  PUBLIC_FUNCTION(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Go, 1); }
};
`;

describe("namespace resolution", () => {
  test("custom namespace helper resolves via using namespace", async () => {
    const source = contractShell(
      `using namespace QPI;
namespace Utils {
  inline uint64 twice(uint64 v) { return v * 2ull; }
}
using namespace Utils;`,
      `output.r = twice(input.v);`,
    );
    const r = await compile(source);
    expect(r.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
    expect(r.wasm.byteLength).toBeGreaterThan(100);
  });

  test("custom namespace helper resolves via qualified name without using that namespace", async () => {
    const source = contractShell(
      `using namespace QPI;
namespace Utils {
  inline uint64 thrice(uint64 v) { return v * 3ull; }
}`,
      `output.r = Utils::thrice(input.v);`,
    );
    const r = await compile(source);
    expect(r.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
    expect(r.wasm.byteLength).toBeGreaterThan(100);
  });

  test("unqualified custom-namespace symbol does not resolve without using that namespace", async () => {
    // Only `using namespace QPI` — Utils::onlyMine must not be found via a hardcoded QPI fallback.
    const source = contractShell(
      `using namespace QPI;
namespace Utils {
  inline uint64 onlyMine(uint64 v) { return v + 7ull; }
}`,
      `output.r = onlyMine(input.v);`,
      "",
    );
    const r = await compile(source, false);
    // Non-strict: unknown free helper is non-fatal (fidelity/warn path), not a hard success.
    const errors = r.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR);
    const warnings = r.diagnostics.filter((d) => d.severity === DiagnosticSeverity.WARNING);
    // Must not silently bind onlyMine through QPI — either a diagnostic fires or the build fails to lower cleanly.
    const complained =
      errors.length > 0 ||
      warnings.some((d) => /onlyMine|unknown|failed to compile|unsupported/i.test(d.message));
    expect(complained).toBe(true);
  });

  test("QPI math still resolves under using namespace QPI", async () => {
    const source = contractShell(`using namespace QPI;`, `output.r = (uint64)div(input.v, 2ull);`);
    const r = await compile(source);
    expect(r.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
    expect(r.wasm.byteLength).toBeGreaterThan(100);
  });

  test("qualified QPI:: math still resolves", async () => {
    const source = contractShell(
      `using namespace QPI;`,
      `output.r = (uint64)QPI::div(input.v, 2ull);`,
    );
    const r = await compile(source);
    expect(r.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
    expect(r.wasm.byteLength).toBeGreaterThan(100);
  });

  test("ProposalTypes::cls resolves under using namespace QPI", async () => {
    const source = contractShell(
      `using namespace QPI;`,
      `output.r = ProposalTypes::cls(uint16(input.v));`,
    );
    const r = await compile(source);
    expect(r.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
    expect(r.wasm.byteLength).toBeGreaterThan(100);
  });

  test("sibling helpers inside a custom namespace resolve via lexical sourceNamespace", async () => {
    const source = contractShell(
      `using namespace QPI;
namespace Utils {
  inline uint64 inc(uint64 v) { return v + 1ull; }
  inline uint64 incTwice(uint64 v) { return inc(inc(v)); }
}
using namespace Utils;`,
      `output.r = incTwice(input.v);`,
    );
    const r = await compile(source);
    expect(r.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
    expect(r.wasm.byteLength).toBeGreaterThan(100);
  });

  test("a callee static helper resolves its unqualified sibling", async () => {
    const calleeSource = `using namespace QPI;
struct HelperCallee : public ContractBase {
  struct StateData {};
  static void derive(const uint64& value, uint64& result) { mix(value, result); }
  static void mix(const uint64& value, uint64& result) { result = value + 1ull; }
};`;
    const source = contractShell(
      `using namespace QPI;`,
      `HelperCallee::derive(input.v, output.r);`,
    );
    const r = await compileContract({
      source,
      name: "NsProbe",
      slot: 28,
      qpiHeader: HEADERS,
      callees: [
        { name: "HelperCallee", index: 27, functions: {}, procedures: {} },
      ],
      calleeSources: [{ name: "HelperCallee", source: calleeSource }],
    });
    expect(r.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
    expect(r.wasm.byteLength).toBeGreaterThan(100);
  });

  test("using namespace inside a nested namespace does not leak outside", async () => {
    const source = contractShell(
      `using namespace QPI;
namespace Utils {
  inline uint64 onlyMine(uint64 v) { return v + 7ull; }
}
namespace Hidden {
  using namespace Utils;
}`,
      `output.r = onlyMine(input.v);`,
    );
    const r = await compile(source, false);
    expect(r.diagnostics.some((d) => /onlyMine|unsupported call/i.test(d.message))).toBe(true);
  });

  test("using namespace declared later does not affect an earlier function body", async () => {
    const source = `${contractShell(
      `using namespace QPI;
namespace Utils {
  inline uint64 onlyMine(uint64 v) { return v + 7ull; }
}`,
      `output.r = onlyMine(input.v);`,
    )}
using namespace Utils;`;
    const r = await compile(source, false);
    expect(r.diagnostics.some((d) => /onlyMine|unsupported call/i.test(d.message))).toBe(true);
  });

  test("header helper retains using namespace directives visible at its definition", async () => {
    const qpiHeader = `${HEADERS}
namespace Extra {
  inline uint64 plusSeven(uint64 v) { return v + 7ull; }
}
using namespace Extra;
namespace Wrap {
  inline uint64 wrapped(uint64 v) { return plusSeven(v); }
}`;
    const source = contractShell(`using namespace QPI;`, `output.r = Wrap::wrapped(input.v);`);
    const r = await compileContract({ source, name: "NsProbe", slot: 28, qpiHeader });
    expect(r.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
    expect(r.diagnostics.some((d) => /plusSeven|unsupported call/i.test(d.message))).toBe(false);
    expect(r.wasm.byteLength).toBeGreaterThan(100);
  });
});
