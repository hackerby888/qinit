// The archetype registry and the variant expansion.

import { createHash } from "node:crypto";
import { createHash as createSourceHash } from "node:crypto";
import { AXIS_VALUES } from "./axes";
import { pairwiseCover } from "./cover";
import { assertEmittedSourceIsLegal } from "./emit";
import { INTEGER_ARCHETYPES } from "./archetypes/integers";
import { SHIFT_ARCHETYPES } from "./archetypes/integers-shifts";
import { INTEGER_MATH_ARCHETYPES, K12_EXPRESSION_ARCHETYPES } from "./archetypes/integers-math";
import { INTEGER_WIDE_ARCHETYPES } from "./archetypes/integers-wide";
import { INTEGER_CAST_ARCHETYPES } from "./archetypes/integers-casts";
import { INTEGER_SIGNED_ARCHETYPES } from "./archetypes/integers-signed";
import { INTEGER_LOOP_ARCHETYPES } from "./archetypes/integers-loops";
import { DATETIME_ARCHETYPES } from "./archetypes/integers-datetime";
import { LAYOUT_PACKING_ARCHETYPES } from "./archetypes/layout-packing";
import { LAYOUT_ARRAY_ARCHETYPES } from "./archetypes/layout-arrays";
import { LAYOUT_WIDTH_ARCHETYPES } from "./archetypes/layout-widths";
import { LAYOUT_MATRIX_ARCHETYPES } from "./archetypes/layout-matrices";
import { NAMESPACE_RESOLUTION_ARCHETYPES } from "./archetypes/namespaces-resolution";
import { NAMESPACE_SCOPING_ARCHETYPES } from "./archetypes/namespaces-scoping";
import { NAMESPACE_VALUE_ARCHETYPES } from "./archetypes/namespaces-values";
import { NAMESPACE_LOOKUP_ARCHETYPES } from "./archetypes/namespaces-lookup";
import { INTERCONTRACT_ARCHETYPES } from "./archetypes/intercontract";
import { INTERCONTRACT_DAG_ARCHETYPES } from "./archetypes/intercontract-dag";
import { INTERCONTRACT_HOOK_ARCHETYPES } from "./archetypes/intercontract-hooks";
import { INTERCONTRACT_MORE_ARCHETYPES } from "./archetypes/intercontract-more";
import { ASSET_ARCHETYPES } from "./archetypes/assets";
import { ASSET_LEDGER_ARCHETYPES } from "./archetypes/assets-ledger";
import { ASSET_SHARE_ARCHETYPES } from "./archetypes/assets-shares";
import { ASSET_MORE_ARCHETYPES } from "./archetypes/assets-more";
import { ASSET_ITERATOR_ARCHETYPES } from "./archetypes/assets-iterators";
import { HOSTCALL_IDENTITY_ARCHETYPES } from "./archetypes/hostcalls-identity";
import { HOSTCALL_TIME_ARCHETYPES } from "./archetypes/hostcalls-time";
import { HOSTCALL_MORE_ARCHETYPES } from "./archetypes/hostcalls-more";
import { CONTROLFLOW_ARCHETYPES } from "./archetypes/controlflow";
import { CONTROLFLOW_STRUCTURE_ARCHETYPES } from "./archetypes/controlflow-structure";
import { CONTROLFLOW_DISPATCH_ARCHETYPES } from "./archetypes/controlflow-dispatch";
import { CONTROLFLOW_PATTERN_ARCHETYPES } from "./archetypes/controlflow-patterns";
import { LIFECYCLE_ARCHETYPES } from "./archetypes/lifecycle";
import { LIFECYCLE_CONSTRUCTION_ARCHETYPES } from "./archetypes/lifecycle-construction";
import { LIFECYCLE_MORE_ARCHETYPES } from "./archetypes/lifecycle-more";
import { LOGGING_ARCHETYPES } from "./archetypes/logging";
import { LOGGING_PAYLOAD_ARCHETYPES } from "./archetypes/logging-payloads";
import { LOGGING_HOOK_ARCHETYPES } from "./archetypes/logging-hooks";
import { LOGGING_MORE_ARCHETYPES } from "./archetypes/logging-more";
import { VULNERABILITY_ARCHETYPES } from "./archetypes/vulnerabilities";
import { VULNERABILITY_CLASSIC_ARCHETYPES } from "./archetypes/vulnerabilities-classic";
import { VULNERABILITY_DEFI_ARCHETYPES } from "./archetypes/vulnerabilities-defi";
import { VULNERABILITY_DEFI_MATH_ARCHETYPES } from "./archetypes/vulnerabilities-defi-math";
import { LAYOUT_ARCHETYPES } from "./archetypes/layout";
import { CONTAINER_ARCHETYPES } from "./archetypes/containers";
import { CONTAINER_STRUCTURE_ARCHETYPES } from "./archetypes/containers-structures";
import { CONTAINER_COLLECTION_ARCHETYPES } from "./archetypes/containers-collections";
import { CONTAINER_ADVANCED_ARCHETYPES } from "./archetypes/containers-advanced";
import { COLLECTION_POV_ARCHETYPES } from "./archetypes/containers-collection-pov";
import { HASH_REMOVAL_ARCHETYPES } from "./archetypes/containers-hash-removal";
import { CONTAINER_PATTERN_ARCHETYPES } from "./archetypes/containers-patterns";
import { NAMESPACE_ARCHETYPES } from "./archetypes/namespaces";
import { UNIVERSAL_AXES } from "./types";
import type { Archetype, AxisAssignment, AxisName, BuiltContract, Family } from "./types";

/** Bump only with intent: it renames every variant and rewrites the whole corpus. */
export const GENERATOR_VERSION = 2;

export const ARCHETYPES: Archetype[] = [
    ...NAMESPACE_ARCHETYPES,
    ...NAMESPACE_RESOLUTION_ARCHETYPES,
    ...NAMESPACE_SCOPING_ARCHETYPES,
    ...NAMESPACE_VALUE_ARCHETYPES,
    ...NAMESPACE_LOOKUP_ARCHETYPES,
    ...LAYOUT_ARCHETYPES,
    ...INTEGER_ARCHETYPES,
    ...SHIFT_ARCHETYPES,
    ...INTEGER_MATH_ARCHETYPES,
    ...K12_EXPRESSION_ARCHETYPES,
    ...INTEGER_WIDE_ARCHETYPES,
    ...INTEGER_CAST_ARCHETYPES,
    ...INTEGER_SIGNED_ARCHETYPES,
    ...INTEGER_LOOP_ARCHETYPES,
    ...DATETIME_ARCHETYPES,
    ...LAYOUT_PACKING_ARCHETYPES,
    ...LAYOUT_ARRAY_ARCHETYPES,
    ...LAYOUT_WIDTH_ARCHETYPES,
    ...LAYOUT_MATRIX_ARCHETYPES,
    ...CONTAINER_ARCHETYPES,
    ...CONTAINER_STRUCTURE_ARCHETYPES,
    ...CONTAINER_COLLECTION_ARCHETYPES,
    ...CONTAINER_ADVANCED_ARCHETYPES,
    ...COLLECTION_POV_ARCHETYPES,
    ...HASH_REMOVAL_ARCHETYPES,
    ...CONTAINER_PATTERN_ARCHETYPES,
    ...CONTROLFLOW_ARCHETYPES,
    ...CONTROLFLOW_STRUCTURE_ARCHETYPES,
    ...CONTROLFLOW_DISPATCH_ARCHETYPES,
    ...CONTROLFLOW_PATTERN_ARCHETYPES,
    ...LIFECYCLE_ARCHETYPES,
    ...LIFECYCLE_CONSTRUCTION_ARCHETYPES,
    ...LIFECYCLE_MORE_ARCHETYPES,
    ...ASSET_ARCHETYPES,
    ...ASSET_LEDGER_ARCHETYPES,
    ...ASSET_SHARE_ARCHETYPES,
    ...ASSET_MORE_ARCHETYPES,
    ...ASSET_ITERATOR_ARCHETYPES,
    ...HOSTCALL_IDENTITY_ARCHETYPES,
    ...HOSTCALL_TIME_ARCHETYPES,
    ...HOSTCALL_MORE_ARCHETYPES,
    ...LOGGING_ARCHETYPES,
    ...LOGGING_PAYLOAD_ARCHETYPES,
    ...LOGGING_HOOK_ARCHETYPES,
    ...LOGGING_MORE_ARCHETYPES,
    ...VULNERABILITY_ARCHETYPES,
    ...VULNERABILITY_CLASSIC_ARCHETYPES,
    ...VULNERABILITY_DEFI_ARCHETYPES,
    ...VULNERABILITY_DEFI_MATH_ARCHETYPES,
    ...INTERCONTRACT_ARCHETYPES,
    ...INTERCONTRACT_DAG_ARCHETYPES,
    ...INTERCONTRACT_HOOK_ARCHETYPES,
    ...INTERCONTRACT_MORE_ARCHETYPES,
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

function assertIdsAreUnique(variants: Variant[]): void {
    const seen = new Map<string, string>();
    for (const variant of variants) {
        const clash = seen.get(variant.id);
        if (clash !== undefined) {
            throw new Error(`variant id collision: ${variant.id} is produced by both '${clash}' and '${canonicalAxis(variant.axis)}'`);
        }
        seen.set(variant.id, canonicalAxis(variant.axis));
    }
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

/** Expand one archetype into its variants: the base (no axes applied) plus a pairwise cover of the axes it opted into, capped so no single archetype
 *  dominates the corpus. */
export function expandArchetype(archetype: Archetype, maxVariants: number, exhaustive = false): Variant[] {
    // Universal axes go on every archetype, applied inside `emitContract`. One that ignores an axis
    // renders identically under both values and the dedup drops the copy, so the count stays honest.
    const declared = [...new Set([...archetype.axes, ...UNIVERSAL_AXES])];
    const axes = declared.filter((axis) => AXIS_VALUES[axis].length > 0);
    const assignments: AxisAssignment[] = [{}];

    if (axes.length > 0) {
        const domains = axes.map((axis) => AXIS_VALUES[axis]);
        // The cross product explodes past three axes, so it is enumerated in full only under the cap.
        // Beyond that a pairwise cover still reaches every value and every pair of values.
        const product = domains.reduce((total, domain) => total * domain.length, 1);
        const seed = Number.parseInt(shortHash(`${archetype.name}#${GENERATOR_VERSION}`), 16) >>> 0;
        const rows = exhaustive && product <= maxVariants ? crossProduct(domains) : pairwiseCover(domains, seed, Math.max(1, maxVariants - 1));
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
        // Fingerprint the code, not the banner: every emitted file records its axis in a header comment, so hashing the whole text would make two identical
        // contracts look distinct and inflate the corpus with variants that test nothing.
        const code = contract.source.replace(/^(?:\/\/[^\n]*\n)+/, "");
        const fingerprint = createSourceHash("sha256")
            .update(`${code}\u0000${JSON.stringify(contract.script)}`)
            .digest("hex");
        if (seenSource.has(fingerprint)) continue;
        seenSource.add(fingerprint);
        const variantId = canonical === "" ? "base" : shortHash(`${archetype.name}|${canonical}|${GENERATOR_VERSION}`);
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
    /** The committed tier. The cross product never fits under any cap, so this number decides how many
     *  spellings of one archetype are kept while the archetype count decides how many shapes. */
    full: 17,
    /** A wider cover of one family's axis space, for bisecting a mismatch cluster during triage. */
    wide: 32,
    /** A wider cap still, for an on-demand overnight run. */
    max: 64,
} as const;

export type Tier = keyof typeof TIERS;

export function expandAll(tier: Tier, filter?: (archetype: Archetype) => boolean): Variant[] {
    assertNamesAreUnique();
    const variants: Variant[] = [];
    for (const archetype of [...ARCHETYPES].sort((a, b) => `${a.family}/${a.name}`.localeCompare(`${b.family}/${b.name}`))) {
        if (filter && !filter(archetype)) continue;
        variants.push(...expandArchetype(archetype, TIERS[tier], tier === "full"));
    }
    assertIdsAreUnique(variants);
    return variants;
}
