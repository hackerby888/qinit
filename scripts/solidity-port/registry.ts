// The archetype registry and the variant expansion.
//
// Every contract in the corpus is a pure function of (archetype, axis assignment, GENERATOR_VERSION),
// so a regenerated corpus is byte-identical and a variant id is stable across runs. Bumping the version
// is the one thing that legitimately changes the whole corpus.

import { createHash } from "node:crypto";
import { createHash as createSourceHash } from "node:crypto";
import { AXIS_VALUES } from "./axes";
import { pairwiseCover } from "./cover";
import { assertEmittedSourceIsLegal } from "./emit";
import { INTEGER_ARCHETYPES } from "./archetypes/integers";
import { ASSET_ARCHETYPES } from "./archetypes/assets";
import { CONTROLFLOW_ARCHETYPES } from "./archetypes/controlflow";
import { LIFECYCLE_ARCHETYPES } from "./archetypes/lifecycle";
import { LOGGING_ARCHETYPES } from "./archetypes/logging";
import { VULNERABILITY_ARCHETYPES } from "./archetypes/vulnerabilities";
import { LAYOUT_ARCHETYPES } from "./archetypes/layout";
import { CONTAINER_ARCHETYPES } from "./archetypes/containers";
import { NAMESPACE_ARCHETYPES } from "./archetypes/namespaces";
import type { Archetype, AxisAssignment, AxisName, BuiltContract, Family } from "./types";

/** Bump only with intent: it renames every variant and rewrites the whole corpus. */
export const GENERATOR_VERSION = 1;

export const ARCHETYPES: Archetype[] = [
    ...NAMESPACE_ARCHETYPES,
    ...LAYOUT_ARCHETYPES,
    ...INTEGER_ARCHETYPES, ...CONTAINER_ARCHETYPES,
    ...CONTROLFLOW_ARCHETYPES,
    ...LIFECYCLE_ARCHETYPES,
    ...ASSET_ARCHETYPES,
    ...LOGGING_ARCHETYPES,
    ...VULNERABILITY_ARCHETYPES,
];

export function archetypesByFamily(): Map<Family, Archetype[]> {
    const grouped = new Map<Family, Archetype[]>();
    for (const archetype of [...ARCHETYPES].sort((a, b) => a.name.localeCompare(b.name))) {
        const list = grouped.get(archetype.family) ?? [];
        list.push(archetype);
        grouped.set(archetype.family, list);
    }
    return grouped;
}

export function assertNamesAreUnique(): void {
    const seen = new Set<string>();
    for (const archetype of ARCHETYPES) {
        if (seen.has(archetype.name)) throw new Error(`duplicate archetype name: ${archetype.name}`);
        seen.add(archetype.name);
    }
}

export interface Variant {
    id: string;
    variantId: string;
    archetype: Archetype;
    axis: AxisAssignment;
    contract: BuiltContract;
}

function shortHash(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/** A stable, order-independent description of an axis assignment — the variant id's only input. */
export function canonicalAxis(axis: AxisAssignment): string {
    return Object.entries(axis)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join(",");
}

/**
 * Expand one archetype into its variants: the base (no axes applied) plus a pairwise cover of the axes
 * it opted into, capped so no single archetype dominates the corpus.
 */
export function expandArchetype(archetype: Archetype, maxVariants: number, exhaustive = false): Variant[] {
    const axes = archetype.axes.filter((axis) => AXIS_VALUES[axis].length > 0);
    const assignments: AxisAssignment[] = [{}];

    if (axes.length > 0) {
        const domains = axes.map((axis) => AXIS_VALUES[axis]);
        const rows = exhaustive ? crossProduct(domains) : pairwiseCover(domains, Number.parseInt(shortHash(`${archetype.name}#${GENERATOR_VERSION}`), 16) >>> 0, Math.max(1, maxVariants - 1));
        for (const row of rows) {
            const assignment: AxisAssignment = {};
            row.forEach((valueIndex, axisIndex) => {
                const axis: AxisName = axes[axisIndex];
                (assignment as Record<string, unknown>)[axis] = domains[axisIndex][valueIndex];
            });
            assignments.push(assignment);
        }
    }

    const seenAxis = new Set<string>();
    // Two axis assignments that render the same bytes are the same test run twice. Deduplicating on the
    // rendered source keeps the contract count honest: an axis an archetype ignores adds no variants.
    const seenSource = new Set<string>();
    const variants: Variant[] = [];
    for (const axis of assignments) {
        const canonical = canonicalAxis(axis);
        if (seenAxis.has(canonical)) continue;
        seenAxis.add(canonical);
        const contract = archetype.build(axis);
        // Fingerprint the code, not the banner: every emitted file records its axis in a header comment,
        // so hashing the whole text would make two identical contracts look distinct and inflate the
        // corpus with variants that test nothing.
        const code = contract.source.replace(/^(?:\/\/[^\n]*\n)+/, "");
        const fingerprint = createSourceHash("sha256").update(`${code}\u0000${JSON.stringify(contract.script)}`).digest("hex");
        if (seenSource.has(fingerprint)) continue;
        seenSource.add(fingerprint);
        const variantId = canonical === "" ? "base" : shortHash(`${archetype.name}|${canonical}|${GENERATOR_VERSION}`).slice(0, 4);
        assertEmittedSourceIsLegal(`${archetype.name}__${variantId}`, contract.source);
        variants.push({
            id: `${archetype.family}/${archetype.name}__${variantId}`,
            variantId,
            archetype,
            axis,
            contract,
        });
        if (variants.length >= maxVariants) break;
    }
    return variants;
}

/** Every combination of the opted-in axes, in a fixed order so the corpus is reproducible. */
function crossProduct(domains: readonly (readonly unknown[])[]): number[][] {
    let rows: number[][] = [[]];
    for (const domain of domains) {
        const next: number[][] = [];
        for (const row of rows) {
            for (let index = 0; index < domain.length; index++) next.push([...row, index]);
        }
        rows = next;
    }
    return rows;
}

export const TIERS = {
    /** One contract per archetype: the CI gate and the harness's own smoke test. */
    smoke: 1,
    /** Pairwise cover of each archetype's opted-in axes — every axis value and every pair, no more. */
    standard: 15,
    /** A wider pairwise cover, for re-running a family after a mismatch cluster. */
    deep: 40,
    /** Every combination of every opted-in axis. The campaign sweep. */
    full: 400,
} as const;

export type Tier = keyof typeof TIERS;

export function expandAll(tier: Tier, filter?: (archetype: Archetype) => boolean): Variant[] {
    assertNamesAreUnique();
    const variants: Variant[] = [];
    for (const archetype of [...ARCHETYPES].sort((a, b) => `${a.family}/${a.name}`.localeCompare(`${b.family}/${b.name}`))) {
        if (filter && !filter(archetype)) continue;
        variants.push(...expandArchetype(archetype, TIERS[tier], tier === "full"));
    }
    return variants;
}
