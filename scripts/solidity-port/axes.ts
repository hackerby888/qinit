// Turning one archetype into many variants: the axis values, and the helpers an archetype uses to
// apply them. The axes are chosen from the families that have historically produced silent bugs in
// this compiler — name qualification, field placement, scalar width, container fill.

import { ALL_WIDTHS, LAYOUT_MODES, NS_MODES, PLACEMENTS, UNSIGNED_WIDTHS } from "./types";
import type { AxisAssignment, AxisName, Fill, LayoutMode, NsMode, Placement, ScalarWidth } from "./types";
import { LEGAL_CAPACITIES } from "./emit";

/** Values each axis ranges over. Kept small deliberately: pairwise coverage beats a huge cross product. */
export const AXIS_VALUES: { [K in AxisName]: readonly unknown[] } = {
    width: ALL_WIDTHS,
    capacity: [2, 8, 64, 1024],
    fill: ["empty", "half", "full", "over"] satisfies Fill[],
    ns: NS_MODES,
    layout: LAYOUT_MODES,
    placement: PLACEMENTS,
    temporaries: ["locals", "stateScratch"],
    loopShape: ["constant", "clamped", "zero"],
};

export function widthOf(axis: AxisAssignment, fallback: ScalarWidth = "uint64"): ScalarWidth {
    return axis.width ?? fallback;
}

export function capacityOf(axis: AxisAssignment, fallback = 8): number {
    const capacity = axis.capacity ?? fallback;
    if (!(LEGAL_CAPACITIES as readonly number[]).includes(capacity)) throw new Error(`capacity ${capacity} is not a legal QPI capacity`);
    return capacity;
}

/** How many entries a script should write, for the requested fill of a container of this capacity. */
export function fillCount(axis: AxisAssignment, capacity: number): number {
    switch (axis.fill ?? "half") {
        case "empty":
            return 0;
        case "half":
            return Math.max(1, capacity >> 1);
        case "full":
            return capacity;
        case "over":
            return capacity + 2;
    }
}

/**
 * One payload type, spelled the way the `ns` axis asks for. `collision` is the interesting one: two
 * namespaces declare the same name and only the qualification at the use site picks the right layout,
 * which is the shape that produced nine silent bugs in this compiler.
 */
export interface QualifiedType {
    /** Declarations to place in the contract's prelude. */
    prelude: string;
    /** How to spell the type at its use site. */
    use: string;
    /** A second spelling that must resolve to a *different* type, for the collision mode. Empty otherwise. */
    other?: string;
}

/**
 * Build a struct type under the requested qualification. `definition` is the struct body; `decoy` is a
 * deliberately different body used by the twin namespace so a mis-resolution changes the layout, and
 * therefore the state digest, instead of being invisible.
 */
export function qualifiedStruct(axis: AxisAssignment, typeName: string, definition: string, decoy: string): QualifiedType {
    const mode: NsMode = axis.ns ?? "global";
    const body = (indent: string, text: string) =>
        text
            .trim()
            .split("\n")
            .map((line) => `${indent}${line.trim()}`)
            .join("\n");

    switch (mode) {
        case "global":
            return { prelude: `struct ${typeName}\n{\n${body("    ", definition)}\n};`, use: typeName };
        case "single":
            return { prelude: `namespace Port\n{\nstruct ${typeName}\n{\n${body("    ", definition)}\n};\n}`, use: `Port::${typeName}` };
        case "alias":
            return {
                prelude: `namespace Port\n{\nstruct ${typeName}\n{\n${body("    ", definition)}\n};\nusing ${typeName}Alias = ${typeName};\n}`,
                use: `Port::${typeName}Alias`,
            };
        case "aliasOfAlias":
            return {
                prelude:
                    `namespace Port\n{\nstruct ${typeName}\n{\n${body("    ", definition)}\n};\n` +
                    `using ${typeName}A = ${typeName};\nusing ${typeName}B = ${typeName}A;\nusing ${typeName}C = ${typeName}B;\n}`,
                use: `Port::${typeName}C`,
            };
        case "collision":
            // Two namespaces, same name, different layouts. Picking the wrong one changes sizeof and
            // every offset after it, so the state digest moves — a silent mis-resolution cannot hide.
            return {
                prelude:
                    `namespace Alpha\n{\nstruct ${typeName}\n{\n${body("    ", definition)}\n};\n}\n\n` +
                    `namespace Beta\n{\nstruct ${typeName}\n{\n${body("    ", decoy)}\n};\n}`,
                use: `Alpha::${typeName}`,
                other: `Beta::${typeName}`,
            };
    }
}

/**
 * Place a payload inside StateData per the `placement` axis, always with a guard field on the far side
 * so a layout error shows up as a changed neighbour rather than as a silently absorbed offset.
 */
export function placeInState(axis: AxisAssignment, payloadDeclaration: string): { state: string; path: string } {
    const placement: Placement = axis.placement ?? "first";
    switch (placement) {
        case "first":
            return { state: `${payloadDeclaration}\nuint64 guard;`, path: "" };
        case "last":
            return { state: `uint64 guard;\n${payloadDeclaration}`, path: "" };
        case "nested":
            return {
                state: `struct Inner\n{\n    ${payloadDeclaration.trim().split("\n").join("\n    ")}\n};\nuint64 guard;\nInner inner;`,
                path: "inner.",
            };
    }
}

/** Order the fields of a struct per the `layout` axis. Members arrive widest-first as declared by the archetype. */
export function orderFields(axis: AxisAssignment, fields: { declaration: string; bytes: number }[]): string {
    const mode: LayoutMode = axis.layout ?? "declared";
    const sorted = [...fields];
    switch (mode) {
        case "declared":
            break;
        case "widestLast":
            sorted.sort((a, b) => a.bytes - b.bytes);
            break;
        case "widestFirst":
            sorted.sort((a, b) => b.bytes - a.bytes);
            break;
        case "padded":
            // A one-byte member between the wide ones forces interior padding the compiler must agree on.
            sorted.sort((a, b) => b.bytes - a.bytes);
            sorted.splice(1, 0, { declaration: "uint8 hole;", bytes: 1 });
            break;
    }
    return sorted.map((field) => field.declaration).join("\n");
}

/** The loop header for the `loopShape` axis. `clamped` is the shape the compiler cannot constant-fold. */
export function loopHeader(axis: AxisAssignment, counter: string, boundExpression: string, constantBound: number): string {
    switch (axis.loopShape ?? "constant") {
        case "constant":
            return `for (${counter} = 0; ${counter} < ${constantBound}; ${counter}++)`;
        case "clamped":
            return `for (${counter} = 0; ${counter} < ${boundExpression}; ${counter}++)`;
        case "zero":
            return `for (${counter} = 0; ${counter} < 0; ${counter}++)`;
    }
}

/** Widths an archetype should be re-typed to when it only makes sense unsigned. */
export const UNSIGNED_ONLY: readonly ScalarWidth[] = UNSIGNED_WIDTHS;
