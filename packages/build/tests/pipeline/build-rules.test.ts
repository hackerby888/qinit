// The build gate: which analyzer findings fail a build, for which contract kind, and how it is switched off.
import { afterEach, expect, test } from "bun:test";
import { analyzeContract, DiagnosticSeverity, SourceAnalysisOrigin } from "@qinit/compiler/analyzer";
import { BUILD_GATE_RULES, buildGateRejection, buildGateViolations, buildRulesEnabled } from "../../src";

const originalEnv = process.env.QINIT_BUILD_RULES;
afterEach(() => {
    if (originalEnv === undefined) delete process.env.QINIT_BUILD_RULES;
    else process.env.QINIT_BUILD_RULES = originalEnv;
});

const BARE_DIV = `
using namespace QPI;
struct Ratio : public ContractBase {
  struct StateData { uint64 last; };
  struct Read_input { uint64 a; uint64 b; };
  struct Read_output { uint64 q; };
  PUBLIC_FUNCTION(Read) { output.q = div(input.a, input.b); }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
  }
};`;

const diagnostics = () => analyzeContract({ source: BARE_DIV, contractName: "Ratio" }).diagnostics;

test("every rule names a scope, and the user-scope rules are the only ones a system build drops", () => {
    for (const rule of BUILD_GATE_RULES) {
        expect(["user", "system", "all"]).toContain(rule.scope);
    }
    expect(BUILD_GATE_RULES.some((rule) => rule.scope === "user")).toBe(true);
});

test("a callee type in a public interface, a log or mutating cheat in a function and an LP64 width fail every contract kind", () => {
    const codes = ["qpi/public-callee-type", "qpi/log-in-function", "cheat/mutator-in-function", "qpi/lp64-width-type"];
    for (const code of codes) {
        const finding = {
            origin: SourceAnalysisOrigin.QPI,
            code,
            severity: DiagnosticSeverity.ERROR,
            message: `${code} tripped`,
            span: { start: 0, end: 0, line: 0, column: 0 },
        };

        expect(buildGateViolations([finding], { contractKind: "user" })).toEqual([`${code} tripped`]);
        expect(buildGateViolations([finding], { contractKind: "system" })).toEqual([`${code} tripped`]);
    }
});

test("a bare div fails a user contract with a line number and the QPI:: spelling", () => {
    const violations = buildGateViolations(diagnostics(), { contractKind: "user" });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^line 7: `div\(…\)` is unqualified — write `QPI::div\(…\)`/);
    expect(buildGateRejection(violations)?.stderr).toContain("Qubic protocol violations:");
});

test("a system contract keeps its bare div: core's own code is exempt from the user rules", () => {
    expect(buildGateViolations(diagnostics(), { contractKind: "system" })).toEqual([]);
});

test("buildRules:false and QINIT_BUILD_RULES=off drop the user rules only", () => {
    expect(buildGateViolations(diagnostics(), { contractKind: "user", buildRules: false })).toEqual([]);

    process.env.QINIT_BUILD_RULES = "off";
    expect(buildRulesEnabled()).toBe(false);
    expect(buildGateViolations(diagnostics(), { contractKind: "user" })).toEqual([]);

    // The protocol rules are not optional: a public HashMap still fails with the switch off.
    const complex = analyzeContract({
        source: `
using namespace QPI;
struct Unsafe : public ContractBase {
  struct StateData {};
  typedef HashMap<id, uint64, 8> Read_input;
  typedef HashMap<id, uint64, 8> Read_output;
  PUBLIC_FUNCTION(Read) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
  }
};`,
        contractName: "Unsafe",
    }).diagnostics;
    expect(buildGateViolations(complex, { contractKind: "user" }).join("\n")).toContain("HashMap is forbidden");
});

test("no violations means no rejection", () => {
    expect(buildGateRejection([])).toBeNull();
});
