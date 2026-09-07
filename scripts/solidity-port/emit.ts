// Emitting QPI contract source. Every archetype builds its contract through these helpers rather than
// by string-pasting a whole file, so the structural rules — the state2 struct, per-entry I/O structs,
// `_WITH_LOCALS` where locals exist, registration of every entry — hold by construction.
//
// The forbidden-construct gate at the bottom is the backstop: it runs on the rendered text before the
// source is ever handed to a compiler, so a generator bug surfaces as a generator failure rather than
// as a contract both backends reject.

import type { Family } from "./types";

export interface EntrySpec {
    name: string;
    kind: "procedure" | "function";
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
    /**
     * Where the archetype's own members sit inside StateData. A guard member is always added on the far
     * side, so a layout error shows up as a changed neighbour rather than being absorbed into padding.
     * Entry bodies are rewritten to match, so an archetype's body text never has to know the placement.
     */
    statePlacement?: "first" | "last" | "nested";
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
    const parts = [structBlock(`${entry.name}_input`, entry.input ?? ""), structBlock(`${entry.name}_output`, entry.output ?? "")];
    if (entry.locals !== undefined) parts.push(structBlock(`${entry.name}_locals`, entry.locals));
    const macro = entry.kind === "procedure" ? "PUBLIC_PROCEDURE" : "PUBLIC_FUNCTION";
    const suffix = entry.locals !== undefined ? "_WITH_LOCALS" : "";
    parts.push(`    ${macro}${suffix}(${entry.name})\n    {\n${bodyBlock(entry.body, "        ")}\n    }`);
    return parts.join("\n\n");
}

function emitHook(macro: string, body: string | undefined): string | null {
    if (body === undefined) return null;
    return `    ${macro}()\n    {\n${bodyBlock(body, "        ")}\n    }`;
}

/**
 * Apply the placement axis: move the archetype's members around inside StateData and rewrite the entry
 * bodies to reach them. Done here rather than in each archetype so the axis is genuinely applied
 * everywhere it is declared — an axis an archetype silently ignores is fake coverage.
 */
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

export function emitContract(input: ContractSpec): string {
    const spec = applyPlacement(input);
    const { header } = spec;
    const comment = [
        `// ${header.archetype} — ported from ${header.solidity}`,
        `// Stresses: ${header.stresses}`,
        ...(header.caveat ? [`// Port caveat: ${header.caveat}`] : []),
        `// Variant: ${header.axis}`,
        `// Generated by scripts/solidity-port/generate.ts. Do not edit; edit the archetype instead.`,
    ].join("\n");

    const blocks: string[] = [];
    blocks.push(structBlock("StateData", spec.state));
    if (spec.extraStructs?.trim()) blocks.push(indentBlock(spec.extraStructs, "    "));
    for (const entry of [...spec.entries].sort((a, b) => a.name.localeCompare(b.name))) blocks.push(emitEntry(entry));

    const registrations = [...spec.entries]
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
    for (const [macro, body] of [
        ["BEGIN_TICK", spec.beginTick],
        ["END_TICK", spec.endTick],
        ["BEGIN_EPOCH", spec.beginEpoch],
        ["END_EPOCH", spec.endEpoch],
    ] as const) {
        const hook = emitHook(macro, body);
        if (hook) blocks.push(hook);
    }

    const prelude = spec.prelude?.trim() ? `\n${spec.prelude.trim()}\n` : "";
    return `${comment}\nusing namespace QPI;\n${prelude}\nstruct ${spec.name}2\n{\n};\n\nstruct ${spec.name} : public ContractBase\n{\n${blocks.join("\n\n")}\n};\n`;
}

/**
 * QPI's source policy, re-checked on the rendered text. These are the rules `source-policy.ts` enforces
 * on both backends; catching them here means a generator slip fails generation instead of producing a
 * contract that is uniformly rejected and therefore tests nothing.
 */
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
