// Emitting QPI contract source. Every archetype builds its contract through these helpers rather than by string-pasting a whole file, so the structural rules —
// the state2 struct, per-entry I/O structs, `_WITH_LOCALS` where locals exist, registration of every entry — hold by construction.

import type { AxisAssignment, EntryOrder, EntryShape, Family, InitStyle, StateOrder, Temporaries } from "./types";

export interface EntrySpec {
    name: string;
    kind: "procedure" | "function";
    /** `private` emits PRIVATE_* and is not registered; used by the `entryShape` axis. */
    visibility?: "public" | "private";
    /** Take this entry's `_input`/`_output` types by alias instead of declaring fresh structs. Two structs with identical members are still distinct types
     *  in C++, so a forwarding entry has to alias rather than duplicate or the copy into the forwarded buffer will not compile. */
    ioAlias?: string;
    /** Registration number, unique per kind within the contract. */
    number: number;
    /** Body of `<Name>_input`. Empty means an empty struct. */
    input?: string;
    /** Body of `<Name>_output`. */
    output?: string;
    /** Body of `<Name>_locals`. Present means the entry is emitted in its `_WITH_LOCALS` form. */
    locals?: string;
    /** Statements of the entry body. */
    body: string;
}

export interface ContractSpec {
    name: string;
    /** The variant's axis assignment. The axes needing nothing from the archetype are read from here, so
     *  passing `axis` through opts into all of them; an explicit field below still wins. */
    axis?: AxisAssignment;
    /** Provenance and intent, rendered as the file's header comment. */
    header: {
        archetype: string;
        family: Family;
        solidity: string;
        stresses: string;
        caveat?: string;
        axis: string;
    };
    /** Namespaces, typedefs, enums and constants emitted between `using namespace QPI;` and the contract. */
    prelude?: string;
    /** Body of `struct StateData`. */
    state: string;
    /** Where the archetype's own members sit inside StateData. A guard member is always added on the far side, so a layout error shows up as a changed
     *  neighbour rather than being absorbed into padding. Entry bodies are rewritten to match, so an archetype's body text never has to know the placement. */
    statePlacement?: "first" | "last" | "nested";
    /** Where entry temporaries live. `stateScratch` moves every `_locals` member into a scratch sub-struct of StateData and rewrites the bodies, which is a
     *  different lowering of the same computation: the locals arena versus contract state memory. */
    temporaries?: Temporaries;
    /** How much INITIALIZE does. `absent` omits it, leaving the host's construction-time zeroing exposed. */
    initStyle?: InitStyle;
    /** `viaPrivate` moves each public entry's body into a PRIVATE_* entry reached by CALL. */
    entryShape?: EntryShape;
    /** `reversed` declares StateData's members back to front. Every offset after the first member moves, so the two backends' struct layout has to agree on
     *  a shape the archetype never wrote by hand. */
    stateOrder?: StateOrder;
    /** `reversed` declares the entries back to front inside the class. Registration numbers and the IDL do not move, so only the order the two backends see
     *  the declarations in changes. */
    entryOrder?: EntryOrder;
    /** Whole struct declarations that must live inside the contract, such as a LOG_* payload type. */
    extraStructs?: string;
    entries: EntrySpec[];
    /** Body of `INITIALIZE()`; locals for it go in `initializeLocals`. */
    initialize?: string;
    initializeLocals?: string;
    beginTick?: string;
    endTick?: string;
    beginEpoch?: string;
    endEpoch?: string;
    /** `_locals` for a hook, which QPI spells through the `_WITH_LOCALS` form of the same macro. A hook that calls out to another contract needs them: the
     *  request and reply buffers have nowhere else to live, since a hook has no `_input` or `_output` of its own. */
    beginTickLocals?: string;
    endTickLocals?: string;
    beginEpochLocals?: string;
    endEpochLocals?: string;
}

const MAX_INPUT_BYTES = 1024;
const MAX_OUTPUT_BYTES = 65535;

function structBlock(name: string, body: string): string {
    const trimmed = body.trim();
    if (!trimmed) return `    struct ${name} {};`;
    const lines = trimmed
        .split("\n")
        .map((line) => `        ${line.trim()}`)
        .join("\n");
    return `    struct ${name}\n    {\n${lines}\n    };`;
}

function bodyBlock(body: string, indent: string): string {
    return body
        .trim()
        .split("\n")
        .map((line) => (line.trim() ? `${indent}${line.trim()}` : ""))
        .join("\n");
}

/** Re-indent a block while keeping its own relative nesting, for declarations rather than statements. */
function indentBlock(block: string, indent: string): string {
    const lines = block.replace(/\t/g, "    ").split("\n");
    const widths = lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length);
    const common = widths.length ? Math.min(...widths) : 0;
    return lines
        .map((line) => (line.trim() ? `${indent}${line.slice(common)}` : ""))
        .join("\n")
        .replace(/^\n+|\n+$/g, "");
}

function emitEntry(entry: EntrySpec): string {
    const parts = entry.ioAlias
        ? [`    using ${entry.name}_input = ${entry.ioAlias}_input;`, `    using ${entry.name}_output = ${entry.ioAlias}_output;`]
        : [structBlock(`${entry.name}_input`, entry.input ?? ""), structBlock(`${entry.name}_output`, entry.output ?? "")];
    if (entry.locals !== undefined) parts.push(structBlock(`${entry.name}_locals`, entry.locals));
    const scope = (entry.visibility ?? "public") === "private" ? "PRIVATE" : "PUBLIC";
    const macro = entry.kind === "procedure" ? `${scope}_PROCEDURE` : `${scope}_FUNCTION`;
    const suffix = entry.locals !== undefined ? "_WITH_LOCALS" : "";
    parts.push(`    ${macro}${suffix}(${entry.name})\n    {\n${bodyBlock(entry.body, "        ")}\n    }`);
    return parts.join("\n\n");
}

function emitHook(macro: string, body: string | undefined, locals?: string): string | null {
    if (body === undefined) return null;
    if (locals === undefined || !locals.trim()) return `    ${macro}()\n    {\n${bodyBlock(body, "        ")}\n    }`;
    return `${structBlock(`${macro}_locals`, locals)}\n\n    ${macro}_WITH_LOCALS()\n    {\n${bodyBlock(body, "        ")}\n    }`;
}

/** Apply the placement axis: move the archetype's members around inside StateData and rewrite the entry bodies to reach them. Done here rather than in each
 *  archetype so the axis is genuinely applied everywhere it is declared — an axis an archetype silently ignores is fake coverage. */
function applyPlacement(spec: ContractSpec): ContractSpec {
    const placement = spec.statePlacement ?? "first";
    const members = spec.state.trim();
    if (placement === "first") return { ...spec, state: `${members}\nuint64 placementGuard;` };
    if (placement === "last") return { ...spec, state: `uint64 placementGuard;\n${members}` };

    const nested = members
        .split("\n")
        .map((line) => `    ${line.trim()}`)
        .join("\n");
    // The guard stays a sibling of `inner` — that is the whole point of it — so it must not be rewritten
    // along with the members that moved inside.
    const rewrite = (text: string): string => text.replace(/state\.(mut|get)\(\)\.(?!placementGuard\b)/g, "state.$1().inner.");
    return {
        ...spec,
        state: `struct Inner\n{\n${nested}\n};\nuint64 placementGuard;\nInner inner;`,
        entries: spec.entries.map((entry) => ({ ...entry, body: rewrite(entry.body) })),
        initialize: spec.initialize === undefined ? undefined : rewrite(spec.initialize),
        beginTick: spec.beginTick === undefined ? undefined : rewrite(spec.beginTick),
        endTick: spec.endTick === undefined ? undefined : rewrite(spec.endTick),
        beginEpoch: spec.beginEpoch === undefined ? undefined : rewrite(spec.beginEpoch),
        endEpoch: spec.endEpoch === undefined ? undefined : rewrite(spec.endEpoch),
    };
}

/** Apply the `temporaries` axis: hoist every entry's `_locals` into one StateData sub-struct, prefixed per
 *  entry to avoid collisions. Bails out when a local is typed by an entry's own I/O struct. */
function applyTemporaries(spec: ContractSpec): ContractSpec {
    if ((spec.temporaries ?? "locals") === "locals") return spec;
    // Only a procedure may be rewritten: hoisting a function's temporaries into state would make the function write to `state.mut()`, which the build gate
    // refuses on a read-only entry — a rejection the archetype never asked for.
    const withLocals = spec.entries.filter((entry) => entry.kind === "procedure" && entry.locals !== undefined && entry.locals.trim());
    if (withLocals.length === 0) return spec;

    const declarations: string[] = [];
    const renamesByEntry = new Map<string, Map<string, string>>();
    for (const entry of withLocals) {
        const renames = new Map<string, string>();
        for (const line of entry.locals!.trim().split("\n")) {
            const declaration = line.trim();
            if (!declaration) continue;
            const match = /^(.+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*;$/.exec(declaration);
            if (!match) return spec;
            const [, typeName, member] = match;
            if (/_input\b|_output\b|_locals\b/.test(typeName)) return spec;
            const scoped = `${entry.name.charAt(0).toLowerCase()}${entry.name.slice(1)}${member.charAt(0).toUpperCase()}${member.slice(1)}`;
            renames.set(member, scoped);
            declarations.push(`${typeName} ${scoped};`);
        }
        renamesByEntry.set(entry.name, renames);
    }

    const rewriteFor = (entryName: string) => (text: string) => {
        const renames = renamesByEntry.get(entryName);
        if (!renames) return text;
        return text.replace(/\blocals\.([A-Za-z_][A-Za-z0-9_]*)/g, (whole, member: string) => {
            const scoped = renames.get(member);
            return scoped ? `state.mut().scratch.${scoped}` : whole;
        });
    };

    return {
        ...spec,
        state: `${spec.state.trim()}\nScratch scratch;`,
        extraStructs: `${spec.extraStructs ?? ""}\nstruct Scratch\n{\n${declarations.map((line) => `    ${line}`).join("\n")}\n};`,
        entries: spec.entries.map((entry) =>
            entry.kind === "procedure" && entry.locals !== undefined && entry.locals.trim()
                ? { ...entry, locals: undefined, body: rewriteFor(entry.name)(entry.body) }
                : entry,
        ),
    };
}

/** Apply the `initStyle` axis. */
function applyInitStyle(spec: ContractSpec): ContractSpec {
    switch (spec.initStyle ?? "full") {
        case "full":
            return spec;
        case "empty":
            return { ...spec, initialize: spec.initialize === undefined ? undefined : "", initializeLocals: undefined };
        case "absent":
            return { ...spec, initialize: undefined, initializeLocals: undefined };
    }
}

/** Apply the `entryShape` axis: move each public entry's body into a private entry of the same kind and have the public one CALL it. The private entry
 *  reuses the public one's I/O structs, so only the dispatch changes. */
function applyEntryShape(spec: ContractSpec): ContractSpec {
    if ((spec.entryShape ?? "direct") === "direct") return spec;
    const entries: EntrySpec[] = [];
    for (const entry of spec.entries) {
        // An entry the archetype already made private is its own helper; wrapping it would publish it.
        if ((entry.visibility ?? "public") === "private") {
            entries.push(entry);
            continue;
        }
        const inner = `${entry.name}Body`;
        // The public entry keeps the real I/O structs (the IDL is derived from them); the private one
        // aliases them, so the forwarded copy is between two names for one type.
        entries.push({
            name: entry.name,
            kind: entry.kind,
            number: entry.number,
            input: entry.input,
            output: entry.output,
            // The forwarding buffers use the public entry's own types, declared immediately above, so no member here depends on a type the class has not
            // reached yet. The private entry then aliases those same types, which makes the CALL's buffers exactly the types it expects.
            locals: `${entry.name}_input forwardedInput;\n${entry.name}_output forwardedOutput;`,
            body: [
                ...(entry.input?.trim() ? ["locals.forwardedInput = input;"] : []),
                `CALL(${inner}, locals.forwardedInput, locals.forwardedOutput);`,
                ...(entry.output?.trim() ? ["output = locals.forwardedOutput;"] : []),
            ].join("\n"),
        });
        entries.push({ ...entry, name: inner, visibility: "private", ioAlias: entry.name, input: undefined, output: undefined });
    }
    return { ...spec, entries };
}

/** Apply the `stateOrder` axis: declare StateData's members back to front. Only a run of plain one-line member declarations can be reversed — a state block
 *  that declares a nested struct inline is left alone, and the variant then renders identically to `declared` and is dropped by the dedup. */
function applyStateOrder(spec: ContractSpec): ContractSpec {
    if ((spec.stateOrder ?? "declared") === "declared") return spec;
    const lines = spec.state
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (lines.length < 2) return spec;
    // A member declaration and nothing else: no nested struct, no comment, no blank continuation.
    if (!lines.every((line) => /^[A-Za-z_][A-Za-z0-9_:<>, ]*\s+[A-Za-z_][A-Za-z0-9_]*\s*;$/.test(line))) return spec;
    return { ...spec, state: [...lines].reverse().join("\n") };
}

/** The axis assignment as the emitted file records it, so a variant's banner names every axis applied. */
function describeAssignment(axis: AxisAssignment): string {
    const parts = Object.entries(axis)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`);
    return parts.length ? parts.join(" ") : "base";
}

/** Resolve the axes an archetype opts into purely by passing its assignment through. */
function withAxis(spec: ContractSpec): ContractSpec {
    const axis = spec.axis;
    if (!axis) return spec;
    return {
        ...spec,
        statePlacement: spec.statePlacement ?? axis.placement,
        temporaries: spec.temporaries ?? axis.temporaries,
        initStyle: spec.initStyle ?? axis.initStyle,
        entryShape: spec.entryShape ?? axis.entryShape,
        stateOrder: spec.stateOrder ?? axis.stateOrder,
        entryOrder: spec.entryOrder ?? axis.entryOrder,
    };
}

export function emitContract(input: ContractSpec): string {
    const spec = applyPlacement(applyEntryShape(applyTemporaries(applyInitStyle(applyStateOrder(withAxis(input))))));
    const { header } = spec;
    const comment = [
        `// ${header.archetype} — ported from ${header.solidity}`,
        `// Stresses: ${header.stresses}`,
        ...(header.caveat ? [`// Port caveat: ${header.caveat}`] : []),
        `// Variant: ${spec.axis ? describeAssignment(spec.axis) : header.axis}`,
        `// Generated by scripts/solidity-port/generate.ts. Do not edit; edit the archetype instead.`,
    ].join("\n");

    const blocks: string[] = [];
    // Extra structs come first: StateData can carry one as a member (the `temporaries` axis does exactly
    // that), and a member needs its type to be complete at the point of declaration.
    if (spec.extraStructs?.trim()) blocks.push(indentBlock(spec.extraStructs, "    "));
    blocks.push(structBlock("StateData", spec.state));
    // A struct member needs a complete type, so an entry whose `_locals` names another's I/O comes after
    // it. Helpers first and aliasing entries last satisfies both shapes that need this.
    const emissionRank = (entry: EntrySpec): number => (entry.ioAlias ? 2 : (entry.visibility ?? "public") === "private" ? 0 : 1);
    // `entryOrder` only reverses entries that do not name each other's I/O types, since a struct member
    // needs a complete type. It stands down otherwise, and the duplicate variant is deduped away.
    const entryNames = spec.entries.map((entry) => entry.name);
    const dependsOnAnotherEntry = spec.entries.some((entry) => {
        const declarations = `${entry.locals ?? ""}\n${entry.input ?? ""}\n${entry.output ?? ""}`;
        return entryNames.some((other) => other !== entry.name && new RegExp(`\\b${other}_(input|output|locals)\\b`).test(declarations));
    });
    const nameOrder = (spec.entryOrder ?? "declared") === "reversed" && !dependsOnAnotherEntry ? -1 : 1;
    const ordered = [...spec.entries].sort((a, b) => emissionRank(a) - emissionRank(b) || nameOrder * a.name.localeCompare(b.name));
    for (const entry of ordered) blocks.push(emitEntry(entry));

    const registrations = [...spec.entries]
        .filter((entry) => (entry.visibility ?? "public") !== "private")
        .sort((a, b) => (a.kind === b.kind ? a.number - b.number : a.kind === "function" ? -1 : 1))
        .map((entry) => `        REGISTER_USER_${entry.kind === "procedure" ? "PROCEDURE" : "FUNCTION"}(${entry.name}, ${entry.number});`)
        .join("\n");
    blocks.push(`    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()\n    {\n${registrations}\n    }`);

    if (spec.initialize !== undefined) {
        if (spec.initializeLocals !== undefined) {
            blocks.push(structBlock("INITIALIZE_locals", spec.initializeLocals));
            blocks.push(`    INITIALIZE_WITH_LOCALS()\n    {\n${bodyBlock(spec.initialize, "        ")}\n    }`);
        } else {
            blocks.push(`    INITIALIZE()\n    {\n${bodyBlock(spec.initialize, "        ")}\n    }`);
        }
    }
    for (const [macro, body, hookLocals] of [
        ["BEGIN_TICK", spec.beginTick, spec.beginTickLocals],
        ["END_TICK", spec.endTick, spec.endTickLocals],
        ["BEGIN_EPOCH", spec.beginEpoch, spec.beginEpochLocals],
        ["END_EPOCH", spec.endEpoch, spec.endEpochLocals],
    ] as const) {
        const hook = emitHook(macro, body, hookLocals);
        if (hook) blocks.push(hook);
    }

    const prelude = spec.prelude?.trim() ? `\n${spec.prelude.trim()}\n` : "";
    return `${comment}\nusing namespace QPI;\n${prelude}\nstruct ${spec.name}2\n{\n};\n\nstruct ${spec.name} : public ContractBase\n{\n${blocks.join("\n\n")}\n};\n`;
}

/** QPI's source policy, re-checked on the rendered text. These are the rules `source-policy.ts` enforces on both backends; catching them here means a
 *  generator slip fails generation instead of producing a contract that is uniformly rejected and therefore tests nothing. */
const FORBIDDEN: { pattern: RegExp; rule: string }[] = [
    { pattern: /\[/, rule: "qpi/no-brackets — use Array<T, N>" },
    { pattern: /"/, rule: "qpi/no-string" },
    { pattern: /'/, rule: "qpi/no-char" },
    { pattern: /__/, rule: "qpi/no-dunder" },
    { pattern: /^\s*#/m, rule: "qpi/no-preprocessor" },
    { pattern: /\bunion\b/, rule: "qpi/no-union" },
    { pattern: /\bfloat\b|\bdouble\b/, rule: "qpi/no-float" },
    { pattern: /\blong\b|\bsize_t\b/, rule: "qpi/lp64-width-type" },
    { pattern: /const_cast/, rule: "qpi/no-const-cast" },
    { pattern: /\.\.\./, rule: "qpi/no-varargs" },
];

function stripComments(source: string): string {
    return source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Throws when the rendered contract breaks a rule both compilers enforce. */
export function assertEmittedSourceIsLegal(name: string, source: string): void {
    const code = stripComments(source);
    for (const { pattern, rule } of FORBIDDEN) {
        if (pattern.test(code)) throw new Error(`${name}: emitted source violates ${rule}`);
    }
    // `/` and `%` are only legal as QPI::div / QPI::mod, so no bare operator may survive the strip.
    const withoutQualified = code.replace(/QPI::(div|mod)/g, "QPI_MATH");
    if (/[^*]\/[^/*]/.test(withoutQualified)) throw new Error(`${name}: emitted source uses bare '/' — call QPI::div(a, b)`);
    if (/%/.test(withoutQualified)) throw new Error(`${name}: emitted source uses bare '%' — call QPI::mod(a, b)`);
}

/** Capacities QPI accepts: `Array` static_asserts a power of two, and the other containers follow it. */
export const LEGAL_CAPACITIES = [2, 4, 8, 16, 64, 256, 1024] as const;

export function assertLegalCapacity(name: string, capacity: number): void {
    if (!(LEGAL_CAPACITIES as readonly number[]).includes(capacity)) {
        throw new Error(`${name}: capacity ${capacity} is not one of ${LEGAL_CAPACITIES.join(", ")}`);
    }
}

export function assertIoWithinLimits(name: string, inputBytes: number, outputBytes: number): void {
    if (inputBytes > MAX_INPUT_BYTES) throw new Error(`${name}: input ${inputBytes}B exceeds MAX_INPUT_SIZE ${MAX_INPUT_BYTES}`);
    if (outputBytes > MAX_OUTPUT_BYTES) throw new Error(`${name}: output ${outputBytes}B exceeds ${MAX_OUTPUT_BYTES}`);
}
