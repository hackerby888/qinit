import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { editorPrefixSource } from "../../src/clangd-config";
import { generateWasmWrapperSource } from "@qinit/build/compile/clang";
import { CheatMode } from "@qinit/compiler";

const CORE = process.env.QINIT_CORE ?? "";
const CORE_SOURCE_ROOT = join(CORE, "src");
const hasCore = CORE !== "" && existsSync(CORE_SOURCE_ROOT);

// The editor's prefix never carries core's post-contract `static_assert`s, so qinit's analyzer is its only
// source for them. This records the region's checks, so a core release adding one fails here, not quietly.
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
            // Core spells its includes with forward slashes, and so do the sets below; `join` on Windows does not.
            return candidate.replace(/\\/g, "/");
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

// Round 31 swept every container method that can touch a user-supplied type and found one requirement. That
// bound holds only while the set of containers whose bodies live past the contract stays put, so pin it.
const CONTAINERS_DEFINED_PAST_THE_CONTRACT = ["Collection", "HashMap", "HashSet", "LinkedList"];

test.if(hasCore)("only these containers keep their method bodies past the editor's prefix", () => {
    const containerNames = ["Array", "BitArray", "Collection", "HashMap", "HashSet", "LinkedList", "SlowAnySizeArray"];
    const implDirectory = join(CORE_SOURCE_ROOT, "qpi", "impl");
    const implSources = readdirSync(implDirectory)
        .filter((entry) => entry.endsWith(".h"))
        .map((entry) => readFileSync(join(implDirectory, entry), "utf8"));

    const definedPastTheContract = containerNames.filter((name) => implSources.some((source) => new RegExp(`\\b${name}\\s*<[^>]*>::`).test(source))).sort();

    // Array, BitArray and SlowAnySizeArray define every body inline in `qpi_containers.h`, which the prefix
    // carries. One moving out of that group takes its bodies, and every requirement in them, out of reach.
    expect(definedPastTheContract).toEqual(CONTAINERS_DEFINED_PAST_THE_CONTRACT);
});

// Core splits its `qpi/impl` headers: proposals, oracle and trivial land in the editor's prefix, these three
// after it. That split is the whole blind region, so a change to it changes what the editor can see.
const INCLUDED_AFTER_THE_CONTRACT = [
    "extensions/wasm/sdk/module_runtime.h",
    "qpi/impl/qpi_collection_impl.h",
    "qpi/impl/qpi_hash_map_impl.h",
    "qpi/impl/qpi_linked_list_impl.h",
];

test.if(hasCore)("the wrapper includes exactly these headers after the contract", () => {
    const wrapper = generateWasmWrapperSource({
        contractName: "Probe",
        contractPath: "Probe.h",
        slot: 31,
        cheats: CheatMode.OFF,
    } as Parameters<typeof generateWasmWrapperSource>[0]);

    const afterContract = wrapper.slice(editorPrefixSource(wrapper, "Probe.h").length);
    const included = [...afterContract.matchAll(/#\s*include\s+"([^"]+)"/g)].map((match) => match[1]!).filter((header) => header !== "Probe.h");

    expect([...new Set(included)].sort()).toEqual(INCLUDED_AFTER_THE_CONTRACT);
});
