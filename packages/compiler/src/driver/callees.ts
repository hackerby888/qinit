import { AstKind, DiagnosticSeverity } from "../shared/enums";
import type { ParserDiagnostic } from "../frontend/parser";
import type { Declaration, StructDecl } from "../ast";
import type { CompileOptions } from "./types";
import type { QpiContext } from "./qpi-context";
import { scanUnterminatedSource } from "./diagnostics";
import { parseContractSource, preprocessContractSource } from "./contract-frontend";

export interface CalleeContext {
    contractStructs: Map<string, StructDecl>;
    // Which callee declares each name in `contractStructs`, for diagnostics that name the owner.
    typeOwners: Map<string, string>;
    calleeTranslationUnits: Array<{ contractName: string; declarations: Declaration[] }>;
    diagnostics: ParserDiagnostic[];
}

export function collectCalleeContext(options: CompileOptions, qpi: QpiContext): CalleeContext {
    const contractStructs = new Map<string, StructDecl>();
    const typeOwners = new Map<string, string>();
    const calleeTranslationUnits: Array<{ contractName: string; declarations: Declaration[] }> = [];
    const diagnostics: ParserDiagnostic[] = [];
    const calleeSlots = new Map((options.callees ?? []).map((callee) => [callee.name, callee.slot]));

    for (const callee of options.calleeSources ?? []) {
        const early = scanUnterminatedSource(callee.source).map((diagnostic) => ({
            ...diagnostic,
            message: `Callee '${callee.name}': ${diagnostic.message}`,
        }));
        diagnostics.push(...early);
        if (early.some((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)) {
            continue;
        }

        const preprocessed = preprocessContractSource(
            {
                source: callee.source,
                contractName: callee.name,
                slot: callee.slot ?? calleeSlots.get(callee.name) ?? 0,
                qpiHeader: options.qpiHeader,
            },
            qpi.macros,
        );
        const calleeDiagnostics: ParserDiagnostic[] = [];
        const unit = parseContractSource(preprocessed, calleeDiagnostics);
        const parsed = calleeDiagnostics.map((diagnostic) => ({
            ...diagnostic,
            message: `Callee '${callee.name}': ${diagnostic.message}`,
        }));
        diagnostics.push(...parsed);
        if (parsed.some((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)) {
            continue;
        }

        calleeTranslationUnits.push({ contractName: callee.name, declarations: unit.declarations });
        for (const declaration of unit.declarations) {
            if (declaration.kind !== AstKind.STRUCT) {
                continue;
            }
            const struct = declaration;
            const isContract =
                struct.bases?.some((base) => base.kind === AstKind.NAME && base.name === "ContractBase") || struct.name === "CONTRACT_STATE_TYPE";
            if (!isContract) {
                // A callee's file-scope struct is visible to the caller in core's single translation unit,
                // so it must resolve here too, or a copy through it lowers at the wrong size.
                if (struct.name) {
                    contractStructs.set(struct.name, struct);
                    typeOwners.set(struct.name, callee.name);
                }
                continue;
            }
            for (const member of struct.members ?? []) {
                if (member.kind === AstKind.STRUCT && member.name) {
                    contractStructs.set(`${callee.name}::${member.name}`, member);
                    typeOwners.set(`${callee.name}::${member.name}`, callee.name);
                }
            }
        }
    }

    return { contractStructs, typeOwners, calleeTranslationUnits, diagnostics };
}
