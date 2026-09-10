// The build gate every backend runs on the analyzer's findings: one rule table, each scoped to user contracts or to all — core's contracts build here too.
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
    // Core's verifier refuses another contract's types in a public input/output; qinit's own check names the owner.
    { title: "public-callee-type", scope: "all", matches: (d) => d.code === "qpi/public-callee-type" },
    // Both compilers reject a log or a mutating cheat inside a function before either builds it.
    { title: "log-in-function", scope: "all", matches: (d) => d.code === "qpi/log-in-function" },
    { title: "cheat-in-function", scope: "all", matches: (d) => d.code === "cheat/mutator-in-function" },
    // long / size_t are 4 bytes on wasm32 but 8 on Core, so clang must refuse them like the TypeScript backend.
    { title: "lp64-width-type", scope: "all", matches: (d) => d.code === "qpi/lp64-width-type" },
    // clang reports this as a bare `redefinition of 'interContractCallError'` from inside the macro.
    { title: "duplicate-call-error-var", scope: "all", matches: (d) => d.code === "qpi/duplicate-call-error-var" },
    { title: "log-header", scope: "all", matches: (d, c) => c.rejectsLogHeader && d.message.includes(LOG_HEADER_WORD_HINT) },
    { title: "unqualified-math", scope: "user", matches: (d) => USER_CONTRACT_RULES.has(d.code) },
];

// reported but not failed on: the contract compiles and ships, but does not do what its author wrote.
export const BUILD_WARN_RULES: readonly BuildGateRule[] = [
    // registered nowhere, so it ships inside the binary and is unreachable by anyone.
    { title: "unregistered-entry", scope: "user", matches: (d) => d.code === "qpi/unregistered" },
    // qpi.invocator() is the null identity on the RPC query path, so a caller gate in a view is dead code.
    { title: "invocator-in-function", scope: "user", matches: (d) => d.code === "qpi/invocator-in-function" },
];

/** QINIT_BUILD_RULES=off switches the user-scope rules off everywhere a flag cannot reach (dev, test, CI). */
export function buildRulesEnabled(): boolean {
    return !/^(0|off|false|no)$/i.test(process.env.QINIT_BUILD_RULES?.trim() ?? "");
}

function resolveContext(context: BuildGateContext): Required<BuildGateContext> {
    return {
        contractKind: context.contractKind ?? "user",
        buildRules: (context.buildRules ?? true) && buildRulesEnabled(),
        rejectsLogHeader: context.rejectsLogHeader ?? true,
    };
}

function select(table: readonly BuildGateRule[], diagnostics: readonly SourceAnalysisDiagnostic[], resolved: Required<BuildGateContext>): string[] {
    const rules = table.filter((rule) => rule.scope === "all" || (rule.scope === resolved.contractKind && resolved.buildRules));
    return diagnostics.filter((diagnostic) => rules.some((rule) => rule.matches(diagnostic, resolved))).map(describe);
}

export function buildGateViolations(diagnostics: readonly SourceAnalysisDiagnostic[], context: BuildGateContext = {}): string[] {
    return select(BUILD_GATE_RULES, diagnostics, resolveContext(context));
}

/** the non-fatal half, reported on a successful build. */
export function buildGateWarnings(diagnostics: readonly SourceAnalysisDiagnostic[], context: BuildGateContext = {}): string[] {
    return select(BUILD_WARN_RULES, diagnostics, resolveContext(context));
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
