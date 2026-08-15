// clangd completes everything the translation unit can see — libc, libc++, the SIMD headers behind
// platform/m256.h — none of which a contract may use. The allowed set is derived from the headers the
// contract compile itself pulls in, so a new QPI container, macro or oracle interface needs no change here.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { QPI_BANNED_KEYWORDS } from "@qinit/compiler/analyzer";

const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/g;
const QUOTED_INCLUDE_PATTERN = /^[ \t]*#[ \t]*include[ \t]+"([^"]+)"/gm;
const ANY_INCLUDE_PATTERN = /^[ \t]*#[ \t]*include[ \t]+[<"][^>"]*[>"]/gm;
const COMMENT_PATTERN = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
const LEADING_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*/;
const QUALIFIER_PATTERN = /([A-Za-z_][A-Za-z0-9_]*)\s*::\s*$/;

// The core headers spell `std::` for their own type traits, which would otherwise allow the namespace and
// with it everything under it. A language namespace, not a QPI name — this does not move with the API.
const NON_QPI_NAMESPACES = new Set(["std"]);

const allowedByCoreSource = new Map<string, ReadonlySet<string>>();

function identifiersIn(source: string): string[] {
    return source.match(IDENTIFIER_PATTERN) ?? [];
}

// Quoted includes resolve against the including file first, then the core include root. Angle includes are
// never followed: that is what keeps <cstdint>, <string> and the rest of the sysroot out of the set.
function resolveInclude(includingFile: string, spec: string, coreSourceRoot: string): string | undefined {
    for (const candidate of [resolve(dirname(includingFile), spec), resolve(coreSourceRoot, spec)]) {
        if (!candidate.startsWith(coreSourceRoot + sep)) {
            continue;
        }
        if (existsSync(candidate) && statSync(candidate).isFile()) {
            return candidate;
        }
    }
    return undefined;
}

// Everything reachable from the prefix header without leaving the core source tree. simde and the other
// vendored libraries live under lib/, so they fall outside the walk by where they are, not by their names.
function includeClosure(prefixHeaderPath: string, coreSourceRoot: string): string[] {
    const visited = new Set<string>();
    const pending = [resolve(prefixHeaderPath)];
    const files: string[] = [];

    while (pending.length) {
        const file = pending.pop()!;
        if (visited.has(file) || !existsSync(file)) {
            continue;
        }
        visited.add(file);

        let source: string;
        try {
            source = readFileSync(file, "utf8");
        } catch {
            continue;
        }

        if (file.startsWith(coreSourceRoot + sep)) {
            files.push(file);
        }
        for (const [, spec] of source.matchAll(QUOTED_INCLUDE_PATTERN)) {
            const included = resolveInclude(file, spec, coreSourceRoot);
            if (included) {
                pending.push(included);
            }
        }
    }

    return files;
}

/** Identifiers a QPI contract may write, read off the headers its own compile includes. */
export function qpiAllowedIdentifiers(prefixHeaderPath: string, corePath: string): ReadonlySet<string> {
    const coreSourceRoot = resolve(corePath, "src");
    const cached = allowedByCoreSource.get(coreSourceRoot);
    if (cached) {
        return cached;
    }

    const allowed = new Set<string>();
    for (const file of includeClosure(prefixHeaderPath, coreSourceRoot)) {
        // Neither comments nor include directives declare anything, and scraping them would allow the
        // names they merely mention — `vector` and `string` from the includes, `printf` and `abs` from prose.
        const source = readFileSync(file, "utf8").replace(COMMENT_PATTERN, " ").replace(ANY_INCLUDE_PATTERN, "");
        for (const identifier of identifiersIn(source)) {
            // Leading underscores mark QPI's own macro machinery, which a contract may not spell.
            if (!identifier.startsWith("_")) {
                allowed.add(identifier);
            }
        }
    }
    for (const banned of [...QPI_BANNED_KEYWORDS, ...NON_QPI_NAMESPACES]) {
        allowed.delete(banned);
    }

    allowedByCoreSource.set(coreSourceRoot, allowed);
    return allowed;
}

/** Symbols the author has already written, which the core headers cannot know about. */
export function documentIdentifiers(source: string): ReadonlySet<string> {
    return new Set(identifiersIn(source));
}

export type CompletionScope =
    /** A plain identifier: everything in the translation unit is on offer. */
    | { kind: "identifier" }
    /** Members reached through a typed expression — already scoped by that type. */
    | { kind: "member" }
    /** Names under a namespace or type, e.g. `QPI::`, `OI::Price::`, `std::`. */
    | { kind: "qualified"; qualifier: string };

// A trigger character only arrives when the member access itself opened the list — Ctrl-Space after typing
// a few letters comes through as an ordinary invocation, so the line has to be read.
export function completionScope(linePrefix: string): CompletionScope {
    const beforeWord = linePrefix.replace(/[A-Za-z0-9_]*$/, "").trimEnd();
    if (/(\.|->)$/.test(beforeWord)) {
        return { kind: "member" };
    }

    const qualifier = QUALIFIER_PATTERN.exec(beforeWord)?.[1];
    if (qualifier) {
        return { kind: "qualified", qualifier };
    }
    // A bare `::` is the global scope, which offers as much as a plain identifier does.
    return { kind: "identifier" };
}

// clangd labels carry the signature and a leading space, e.g. " get(uint64 index) const".
function completionName(label: string): string | undefined {
    return LEADING_IDENTIFIER_PATTERN.exec(label.trim())?.[0];
}

// Assignment operators and destructors come with every struct and none of them can be written after a
// dot in QPI, so a member list is the reserved names, the operators and the destructor removed.
const NOISE_MEMBER_PATTERN = /^(operator\b|~)/;

export function keepMemberLabel(label: string): boolean {
    if (NOISE_MEMBER_PATTERN.test(label.trim())) {
        return false;
    }
    return !completionName(label)?.startsWith("_");
}

// Whether a `<qualifier>::` list is worth showing at all. The author's own types qualify through the
// document, but a blocked namespace stays blocked even when the file mentions it.
export function keepQualifiedScope(qualifier: string, allowed: ReadonlySet<string>, documentNames: ReadonlySet<string>): boolean {
    if (NON_QPI_NAMESPACES.has(qualifier)) {
        return false;
    }
    return allowed.has(qualifier) || documentNames.has(qualifier);
}

export function keepCompletionLabel(label: string, allowed: ReadonlySet<string>, documentNames: ReadonlySet<string>): boolean {
    const name = completionName(label);
    if (!name) {
        return true;
    }
    if (name.startsWith("_") || NON_QPI_NAMESPACES.has(name)) {
        return false;
    }
    return allowed.has(name) || documentNames.has(name);
}
