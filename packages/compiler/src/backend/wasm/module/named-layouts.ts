import { AstKind } from "../../../shared/enums";
import type { ProgramAnalysis } from "../../../semantics/program-analysis";
import type { StructLayout } from "../../../semantics/types";
import type { TypeSpec } from "../../../ast";

export class ContractLayoutResolver {
    readonly emptyLayout: StructLayout = emptyNamedLayout();

    constructor(private readonly programAnalysis: ProgramAnalysis) {}

    hasType(name: string): boolean {
        return this.programAnalysis["nested"].has(name) || this.programAnalysis.typedefs.has(name) || this.programAnalysis.globalStructs.has(name);
    }

    resolve(name: string): StructLayout {
        const nestedDeclaration = this.programAnalysis["nested"].get(name);

        if (nestedDeclaration) {
            return this.programAnalysis.layoutOf(nestedDeclaration);
        }

        return this.resolveNamedType(name, emptyNamedLayout());
    }

    resolveOptional(name: string | undefined): StructLayout {
        if (!name) {
            return this.emptyLayout;
        }

        return this.resolveNamedType(name, this.emptyLayout);
    }

    private resolveNamedType(name: string, fallback: StructLayout): StructLayout {
        const type: TypeSpec = { kind: AstKind.NAME, name };
        const layout = this.programAnalysis.layoutOfType(type);

        if (layout) {
            return layout;
        }

        const size = this.programAnalysis.sizeOfType(type);

        if (size <= 0) {
            return fallback;
        }

        return {
            size,
            align: Math.min(size, 8),
            fields: new Map(),
        };
    }
}

function emptyNamedLayout(): StructLayout {
    return {
        size: 0,
        align: 1,
        fields: new Map(),
    };
}
