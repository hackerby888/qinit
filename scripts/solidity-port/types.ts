// Shared vocabulary for the Solidity-port differential campaign: what an archetype is, how it is
// parameterised, and the call script both compilers are driven with.

/** Archetype families, ordered by the bug families this compiler has actually produced. */
export type Family =
    | "namespaces"
    | "integers"
    | "layout"
    | "containers"
    | "controlflow"
    | "lifecycle"
    | "assets"
    | "logging"
    | "vulnerabilities"
    | "intercontract"
    | "hostcalls";

export const FAMILIES: Family[] = [
    "namespaces",
    "integers",
    "layout",
    "containers",
    "controlflow",
    "lifecycle",
    "assets",
    "logging",
    "vulnerabilities",
    "intercontract",
    "hostcalls",
];

/** QPI scalar spellings an archetype can be re-typed to. `uint128` has no literal suffix, so it is handled apart. */
export type ScalarWidth = "uint8" | "uint16" | "uint32" | "uint64" | "sint8" | "sint16" | "sint32" | "sint64";

export const UNSIGNED_WIDTHS: ScalarWidth[] = ["uint8", "uint16", "uint32", "uint64"];
export const SIGNED_WIDTHS: ScalarWidth[] = ["sint8", "sint16", "sint32", "sint64"];
export const ALL_WIDTHS: ScalarWidth[] = [...UNSIGNED_WIDTHS, ...SIGNED_WIDTHS];

/** How a type name is spelled at its use site — the family that produced nine silent bugs. */
export type NsMode = "global" | "single" | "alias" | "aliasOfAlias" | "collision";

export const NS_MODES: NsMode[] = ["global", "single", "alias", "aliasOfAlias", "collision"];

/** Where the archetype's payload sits inside StateData, which decides padding and offsets. */
export type Placement = "first" | "last" | "nested";

export const PLACEMENTS: Placement[] = ["first", "last", "nested"];

/** Field order inside the archetype's own struct — tail padding vs leading padding. */
export type LayoutMode = "declared" | "widestLast" | "widestFirst" | "padded";

export const LAYOUT_MODES: LayoutMode[] = ["declared", "widestLast", "widestFirst", "padded"];

/** How full a container is driven, relative to its declared capacity. */
export type Fill = "empty" | "half" | "full" | "over";

export const FILLS: Fill[] = ["empty", "half", "full", "over"];

/** Where an entry's temporaries live. Both are legal; only the `_locals` struct is canonical. */
export type Temporaries = "locals" | "stateScratch";

export const TEMPORARIES: Temporaries[] = ["locals", "stateScratch"];

/** How much INITIALIZE does. `absent` omits it entirely, leaving construction-time zeroing to the host. */
export type InitStyle = "full" | "empty" | "absent";

export const INIT_STYLES: InitStyle[] = ["full", "empty", "absent"];

/** Whether an entry's body runs inline or is reached through a PRIVATE_FUNCTION + CALL. */
export type EntryShape = "direct" | "viaPrivate";

export const ENTRY_SHAPES: EntryShape[] = ["direct", "viaPrivate"];

/** Declaration order of StateData's own members. Reversing it moves every offset after the first field. */
export type StateOrder = "declared" | "reversed";

export const STATE_ORDERS: StateOrder[] = ["declared", "reversed"];

/** Declaration order of the contract's entries inside the class. The registration numbers do not move. */
export type EntryOrder = "declared" | "reversed";

export const ENTRY_ORDERS: EntryOrder[] = ["declared", "reversed"];

/** Whether the archetype's operand arrives at runtime or as a compile-time constant. */
export type ConstSource = "input" | "constexpr";

export const CONST_SOURCES: ConstSource[] = ["input", "constexpr"];

/** The shape of a loop bound, which decides whether the trip count is a constant to the compiler. */
export type LoopShape = "constant" | "clamped" | "zero";

export type AxisName =
    | "width"
    | "capacity"
    | "fill"
    | "ns"
    | "layout"
    | "placement"
    | "temporaries"
    | "loopShape"
    | "initStyle"
    | "entryShape"
    | "constSource"
    | "stateOrder"
    | "entryOrder";

/** Axes needing nothing from an archetype but its `axis` passed through, so every archetype opts in. One
 *  that ignores an axis renders identically under both values and the duplicate is deduped away. */
export const UNIVERSAL_AXES: AxisName[] = ["placement", "temporaries", "initStyle", "entryShape", "stateOrder", "entryOrder"];

/** One point in the archetype's opted-in axis space. Absent keys mean the archetype ignores that axis. */
export interface AxisAssignment {
    width?: ScalarWidth;
    capacity?: number;
    fill?: Fill;
    ns?: NsMode;
    layout?: LayoutMode;
    placement?: Placement;
    temporaries?: Temporaries;
    loopShape?: LoopShape;
    initStyle?: InitStyle;
    entryShape?: EntryShape;
    constSource?: ConstSource;
    stateOrder?: StateOrder;
    entryOrder?: EntryOrder;
}

/** One step of stimulus. `in` is the raw input struct as hex, so both compilers see identical bytes. */
export interface CallStep {
    kind: "procedure" | "function" | "advanceTick" | "advanceEpoch";
    /** Registered entry number for `procedure` / `function`. */
    entry?: number;
    /** Input struct bytes, hex. Empty or absent for an empty `_input`. */
    in?: string;
    /** Index into `identities`; the caller of this step. */
    invocator?: number;
    /** Invocation reward (QU) attached to a procedure, decimal string. */
    amount?: string;
    /** Tick or epoch count for the advance kinds. */
    n?: number;
    /** Free-text note carried into the result row, for triage readability. */
    note?: string;
}

/** A row the port asserts independently of compiler agreement, used only where the Solidity → QPI width mapping is exact. Secondary oracle: it can convict a
 *  bug both backends share, which the digest cannot. */
export interface ExpectRow {
    /** Index into `steps`. */
    step: number;
    /** Expected output struct bytes, hex. */
    out: string;
    /** Where the expectation comes from: a Solidity test row, or a hand-derived C++ rule. */
    source: "solidity" | "cpp-rule";
    /** The rule or the Solidity `// ----` line it was taken from. */
    note: string;
}

export interface CallScript {
    slot: number;
    /** Pinned so `qpi.tick()` cannot make the digest a moving target. */
    tick: number;
    epoch: number;
    /** 0 turns epoch rollover off; set it only when the archetype exercises END_EPOCH. */
    epochLength: number;
    /** 32-byte identities as hex, referenced by index from `invocator` and `fund`. */
    identities: string[];
    fund: { id: number; amount: string }[];
    steps: CallStep[];
    expect?: ExpectRow[];
}

/** What an archetype builder returns for one axis assignment. */
export interface BuiltContract {
    source: string;
    script: CallScript;
    /** A callee this contract calls, at a strictly lower slot. clang static_asserts that ordering inside
     *  CALL while the TypeScript backend fails at runtime, so a wrong-order pair reads as a divergence. */
    callee?: { name: string; source: string; slot: number };
}

export interface Archetype {
    /** PascalCase, unique within its family. */
    name: string;
    family: Family;
    /** Provenance: the Solidity test path or pattern this was ported from. */
    solidity: string;
    /** What this stresses in the Qubic compilers. */
    stresses: string;
    /** How the port differs from the Solidity original, where it does. */
    caveat?: string;
    /** Axes this archetype opts into. The generator crosses only these. */
    axes: AxisName[];
    /** Set when the archetype exists to prove both backends refuse the contract, so agreeing on rejection
     *  is the pass. Weaker than the rest, but the only rows that would catch the gates drifting. */
    expectReject?: boolean;
    /** A divergence this archetype exists to pin, with a documented cause. Scored as a match when it diverges exactly this way, and as a failure if it ever
     *  stops — a regression test rather than a permanent red row on the scoreboard. Requires `divergenceNote`. */
    expectedVerdict?: Verdict;
    /** Why the expected divergence happens; rendered into the emitted file and the scoreboard. */
    divergenceNote?: string;
    build(axis: AxisAssignment): BuiltContract;
}

/** One backend's run of one contract. */
export interface StepRecord {
    index: number;
    kind: CallStep["kind"];
    entry?: number;
    /** Output struct bytes, hex. Absent for the advance kinds. */
    out?: string;
    /** Contract state digest after this step — localises a final-digest mismatch to a step. */
    digest?: string;
    /** Logs emitted during this step, as `<type>:<payload hex>`. A log divergence is cheap signal. */
    logs?: string[];
    /** Set when the step trapped or aborted. */
    fault?: string;
}

export interface BackendRun {
    backend: "typescript" | "clang";
    status: "ok" | "rejected" | "trap" | "error";
    /** K12 of the full contract state after the last step. The campaign's primary comparison. */
    digest?: string;
    stateSize?: number;
    /** First and last 32 bytes of the final state, so a digest difference can be localised without a re-run. */
    statePrefix?: string;
    stateSuffix?: string;
    steps: StepRecord[];
    /** Compile diagnostics when `status` is "rejected", or the thrown message when "error". */
    diagnostics?: string[];
    compileMs: number;
    executeMs: number;
    wasmBytes?: number;
    /** True when the wasm came from the compile cache, so `compileMs` is not a build time. */
    cached?: boolean;
    /** The callee's final state, for a pair. Most cross-contract mutation lands here, so the caller's own state can be identical while the callee's
     *  diverges. */
    calleeDigest?: string;
    calleeStateSize?: number;
    /** Cross-contract calls the run actually made, so a pair that never called out is visible. */
    calls?: number;
}

export type Verdict =
    "match" | "digest-mismatch" | "step-mismatch" | "trap-divergence" | "one-side-rejected" | "both-rejected" | "expect-violation" | "hang" | "harness-error";

export interface CellResult {
    /** `<family>/<Archetype>__<variantId>`. */
    id: string;
    archetype: string;
    family: Family;
    axis: AxisAssignment;
    verdict: Verdict;
    /** First point of disagreement, human readable. */
    firstDifference?: string;
    ts: BackendRun;
    clang: BackendRun;
    totalMs: number;
}
