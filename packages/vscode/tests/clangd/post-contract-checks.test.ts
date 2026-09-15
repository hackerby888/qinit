import { test, expect } from "bun:test";
import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { editorPrefixSource } from "../../src/clangd-config";
import { generateWasmWrapperSource } from "@qinit/build/compile/clang";
import { CheatMode } from "@qinit/compiler";

const CORE = process.env.QINIT_CORE ?? "";
const CORE_SOURCE_ROOT = join(CORE, "src");
const hasCore = CORE !== "" && existsSync(CORE_SOURCE_ROOT);

// Core checks a contract's log payload with `static_assert`s that live in a header the wrapper includes
// AFTER the contract, so the editor's translation unit — a strict prefix of the build's — never carries
// them. Round 29 measured that: the build refuses a payload whose `_terminator` is not last, and clangd
// says nothing about the same file for over two minutes. qinit's own analyzer is the editor's only source
// for those rules, and it happens to cover all of them today. Nothing keeps that true, which is what this
// records: the region's checks, so that a core release adding one to it fails here instead of going quiet.
const CHECKS_ONLY_THE_BUILD_SEES: ReadonlyArray<[string, number]> = [
    ["extensions/wasm/sdk/lhost_imports.h", 8],
    ["extensions/wasm/sdk/qpi_forwarders.h", 3],
    ["network_messages/assets.h", 9],
    ["network_messages/entity.h", 3],
    ["platform/concurrency.h", 1],
    ["public_settings.h", 3],
];

const INCLUDE_PATTERN = /#\s*include\s+"([^"]+)"/g;
const STATIC_ASSERT_PATTERN = /static_assert\s*\(/g;

/** Every core header reachable from `source`, following quoted includes and resolving each against core and its includer. */
function coreHeaderClosure(source: string, startingAt: string[]): Set<string> {
    const reached = new Set<string>();
    const pending = [...startingAt, ...[...source.matchAll(INCLUDE_PATTERN)].map((match) => match[1]!)];

    while (pending.length > 0) {
        const header = pending.pop()!;
        const relative = resolveAgainstCore(header, "");

        if (!relative || reached.has(relative)) {
            continue;
        }

        reached.add(relative);
        const text = readFileSync(join(CORE_SOURCE_ROOT, relative), "utf8");

        for (const match of text.matchAll(INCLUDE_PATTERN)) {
            const nested = resolveAgainstCore(match[1]!, dirname(relative));
            if (nested) pending.push(nested);
        }
    }

    return reached;
}

/** A quoted include as core spells it, or relative to the header that included it; undefined when it leaves the tree. */
function resolveAgainstCore(include: string, includerDirectory: string): string | undefined {
    for (const candidate of [include, normalize(join(includerDirectory, include))]) {
        if (existsSync(join(CORE_SOURCE_ROOT, candidate))) {
            return candidate;
        }
    }

    return undefined;
}

function staticAssertCount(relativeHeader: string): number {
    return [...readFileSync(join(CORE_SOURCE_ROOT, relativeHeader), "utf8").matchAll(STATIC_ASSERT_PATTERN)].length;
}

test.if(hasCore)("the checks past the editor's prefix are the ones this branch measured", () => {
    const wrapper = generateWasmWrapperSource({
        contractName: "Probe",
        contractPath: "Probe.h",
        slot: 31,
        cheats: CheatMode.OFF,
    } as Parameters<typeof generateWasmWrapperSource>[0]);
    const prefix = editorPrefixSource(wrapper, "Probe.h");

    expect(prefix.length).toBeLessThan(wrapper.length);

    // What the build's translation unit reaches after the contract, minus what the editor's already carried.
    const afterContract = wrapper.slice(prefix.length);
    const editorReaches = coreHeaderClosure(prefix, []);
    const buildAlsoReaches = coreHeaderClosure(afterContract, []);
    const onlyTheBuildReaches = [...buildAlsoReaches].filter((header) => !editorReaches.has(header));

    const carryingChecks = onlyTheBuildReaches
        .map((header) => [header, staticAssertCount(header)] as [string, number])
        .filter(([, count]) => count > 0)
        .sort(([left], [right]) => left.localeCompare(right));

    expect(carryingChecks).toEqual(CHECKS_ONLY_THE_BUILD_SEES.map(([header, count]) => [header, count]));
});

test.if(hasCore)("the editor's own analyzer still covers every log rule core asserts past the prefix", () => {
    const lhostImports = readFileSync(join(CORE_SOURCE_ROOT, "extensions/wasm/sdk/lhost_imports.h"), "utf8");
    const logRules = [...lhostImports.matchAll(/static_assert\s*\([^;]*?"([^"]+)"\s*\)/g)].map((match) => match[1]!);

    // Four log levels repeat the same two rules; both are implemented in `log-payload.ts`, which is what the
    // editor runs. `TERMINATOR_TOO_EARLY` answers the first and `FIELD_AFTER_TERMINATOR` the second.
    expect(new Set(logRules)).toEqual(
        new Set([
            "Invalid contract debug message structure",
            "Invalid contract error message structure",
            "Invalid contract info message structure",
            "Invalid contract warning message structure",
            "Fields after _terminator are never logged",
        ]),
    );
});

// Round 31 swept every container method that can touch a user-supplied type — Collection and LinkedList with
// a bare element struct, HashMap and HashSet with a bare value and a key that declares `operator==`, and
// element types carrying a nested container. All three oracles agreed on every one, so the key comparison
// E27 reports is the only thing these bodies ask of a contract's own type. That holds only while the set of
// containers whose bodies live past the contract stays put, which is what this pins.
const CONTAINERS_DEFINED_PAST_THE_CONTRACT = ["Collection", "HashMap", "HashSet", "LinkedList"];

test.if(hasCore)("only these containers keep their method bodies past the editor's prefix", () => {
    const containerNames = ["Array", "BitArray", "Collection", "HashMap", "HashSet", "LinkedList", "SlowAnySizeArray"];
    const implSources = globSync(join(CORE_SOURCE_ROOT, "qpi/impl/*.h")).map((path) => readFileSync(path, "utf8"));

    const definedPastTheContract = containerNames.filter((name) => implSources.some((source) => new RegExp(`\\b${name}\\s*<[^>]*>::`).test(source))).sort();

    // Array, BitArray and SlowAnySizeArray define every body inline in `qpi_containers.h`, which the prefix
    // carries, so the editor type-checks their uses in full. A container moving out of that group would take
    // its bodies out of the editor's reach, and every requirement in them with it.
    expect(definedPastTheContract).toEqual(CONTAINERS_DEFINED_PAST_THE_CONTRACT);
});
