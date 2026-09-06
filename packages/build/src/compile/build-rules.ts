// The build gate every backend runs on the analyzer's findings before compiling: one table of rules, each
// scoped to user contracts or to every contract (core's own system contracts are built here too).
import { USER_CONTRACT_RULES, type SourceAnalysisDiagnostic } from "@qinit/compiler/analyzer";
import { LOG_HEADER_WORD_HINT } from "@qinit/compiler";

export type ContractKind = "user" | "system";

export interface BuildGateContext {
    /** System contracts skip the user-scope rules; they are core's code, not the developer's. */
    contractKind?: ContractKind;
    /** false drops the user-scope rules (`--no-build-rules`); the protocol rules always run. */
    buildRules?: boolean;
    /** Whether a log payload whose leading word the host overwrites is a violation (off for known core headers). */
    rejectsLogHeader?: boolean;
}

export interface BuildGateRule {
    title: string;
    scope: ContractKind | "all";
    matches(diagnostic: SourceAnalysisDiagnostic, context: Required<BuildGateContext>): boolean;
}

// Add a rule: emit a diagnostic from the analyzer, then match its code here (and list it in USER_CONTRACT_RULES if user-scoped).
export const BUILD_GATE_RULES: readonly BuildGateRule[] = [
    { title: "registered-entry", scope: "all", matches: (d) => d.message.includes(" is forbidden in registered entry") },
    { title: "public-complex-type", scope: "all", matches: (d) => d.code === "qpi/public-complex-type" },
    // clang reports this as a bare `redefinition of 'interContractCallError'` from inside the macro.
    { title: "duplicate-call-error-var", scope: "all", matches: (d) => d.code === "qpi/duplicate-call-error-var" },
    { title: "log-header", scope: "all", matches: (d, c) => c.rejectsLogHeader && d.message.includes(LOG_HEADER_WORD_HINT) },
    { title: "unqualified-math", scope: "user", matches: (d) => USER_CONTRACT_RULES.has(d.code) },
];

/** QINIT_BUILD_RULES=off switches the user-scope rules off everywhere a flag cannot reach (dev, test, CI). */
export function buildRulesEnabled(): boolean {
    return !/^(0|off|false|no)$/i.test(process.env.QINIT_BUILD_RULES?.trim() ?? "");
}

export function buildGateViolations(diagnostics: readonly SourceAnalysisDiagnostic[], context: BuildGateContext = {}): string[] {
    const resolved: Required<BuildGateContext> = {
        contractKind: context.contractKind ?? "user",
        buildRules: (context.buildRules ?? true) && buildRulesEnabled(),
        rejectsLogHeader: context.rejectsLogHeader ?? true,
    };
    const rules = BUILD_GATE_RULES.filter((rule) => rule.scope === "all" || (rule.scope === resolved.contractKind && resolved.buildRules));
    return diagnostics.filter((diagnostic) => rules.some((rule) => rule.matches(diagnostic, resolved))).map(describe);
}

// A rejection in the build result's own shape, so neither backend needs a second error path.
export function buildGateRejection(violations: readonly string[]): { ok: false; stderr: string } | null {
    if (!violations.length) {
        return null;
    }
    return { ok: false, stderr: ["Qubic protocol violations:", ...violations.map((violation) => `  • ${violation}`)].join("\n") };
}

function describe(diagnostic: SourceAnalysisDiagnostic): string {
    return diagnostic.span.line > 0 ? `line ${diagnostic.span.line}: ${diagnostic.message}` : diagnostic.message;
}
