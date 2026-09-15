import { AstKind } from "../../../shared/enums";
import { SCALAR_SIZE } from "../../../shared/scalar-sizes";
import type { StructLayout } from "../../../semantics/types";
import type { Span, TypeSpec } from "../../../ast";
import { findMemberFn } from "./contract-discovery";
import type { PreparedContractModule } from "./module-analysis";

const MIGRATION_IMPLEMENTATION = "__impl_migrate";
const OLD_STATE_STRUCT = "OldStateData";

// How deep a nested state struct is followed before giving up, matching the depth guards elsewhere here.
const MAX_FIELD_DEPTH = 8;

/** The signed QPI scalars; everything else in `SCALAR_SIZE` that this rule judges is unsigned. */
const SIGNED_SCALARS: ReadonlySet<string> = new Set(["sint8", "sint16", "sint32", "sint64"]);

// A migration rewrites persisted state once, irreversibly, on a deployed contract. C++ permits both a
// narrowing and a signedness change implicitly, so no compiler refuses either — this is the only thing that
// says so. It warns rather than errors: narrowing after proving the range is a legitimate thing to do.
export function validateMigrationNarrowing(prepared: PreparedContractModule): void {
    const contract = prepared.contract;

    if (!contract || !findMemberFn(contract, MIGRATION_IMPLEMENTATION)?.body) {
        return;
    }

    const migration = findMemberFn(contract, MIGRATION_IMPLEMENTATION)!;
    const oldState = prepared.layouts.resolve(OLD_STATE_STRUCT);

    if (oldState.fields.size === 0) {
        return;
    }

    reportNarrowedFields(prepared, oldState, prepared.stateLayout, "", 0, migration.span);
}

function reportNarrowedFields(
    prepared: PreparedContractModule,
    oldLayout: StructLayout,
    newLayout: StructLayout,
    path: string,
    depth: number,
    span: Span,
): void {
    if (depth > MAX_FIELD_DEPTH) {
        return;
    }

    for (const [name, oldField] of oldLayout.fields) {
        const newField = newLayout.fields.get(name);

        if (!newField) {
            continue;
        }

        const fieldPath = path === "" ? name : `${path}.${name}`;
        const oldScalar = scalarNameOf(prepared, oldField.type);
        const newScalar = scalarNameOf(prepared, newField.type);

        if (oldScalar && newScalar) {
            const loss = whatIsLost(oldScalar, newScalar);

            if (loss) {
                prepared.programAnalysis.warn(
                    `migration narrows persisted field '${fieldPath}': ${loss}. Every stored value outside the new range is rewritten once, irreversibly`,
                    span,
                );
            }

            continue;
        }

        // A field that is a struct on both sides is followed; anything else — a container, a changed kind —
        // is left alone, because what it means to narrow one is not the same question.
        const oldNested = prepared.programAnalysis.layoutOfType(oldField.type);
        const newNested = prepared.programAnalysis.layoutOfType(newField.type);

        if (oldNested && newNested) {
            reportNarrowedFields(prepared, oldNested, newNested, fieldPath, depth + 1, span);
        }
    }
}

/** What the new type cannot carry over from the old one, or null when every old value still fits. */
function whatIsLost(oldScalar: string, newScalar: string): string | null {
    if (oldScalar === newScalar) {
        return null;
    }

    const oldSize = SCALAR_SIZE[oldScalar]!;
    const newSize = SCALAR_SIZE[newScalar]!;
    const oldSigned = SIGNED_SCALARS.has(oldScalar);
    const newSigned = SIGNED_SCALARS.has(newScalar);

    if (newSize < oldSize) {
        return `${oldScalar} to ${newScalar} truncates`;
    }

    if (oldSigned && !newSigned) {
        return `${oldScalar} to ${newScalar} turns every negative value into a large positive one`;
    }

    if (!oldSigned && newSigned && newSize <= oldSize) {
        return `${oldScalar} to ${newScalar} loses the top half of the range`;
    }

    return null;
}

/** The scalar a field is declared as, or null when it is not one this rule can compare. */
function scalarNameOf(prepared: PreparedContractModule, type: TypeSpec): string | null {
    const resolved = prepared.programAnalysis.derefType(type);

    if (resolved.kind !== AstKind.NAME || SCALAR_SIZE[resolved.name] === undefined) {
        return null;
    }

    // `id` and `m256i` are scalars by size but carry no range to lose, and `bool`/`bit` are not narrowed.
    return SIGNED_SCALARS.has(resolved.name) || resolved.name.startsWith("uint") ? resolved.name : null;
}
