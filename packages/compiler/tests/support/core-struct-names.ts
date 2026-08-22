// Names core declares as plain structs with method bodies. A contract nesting one of these shadows it
// in C++, so the compiler must keep the two apart; enumerating from core keeps the list honest as
// upstream moves instead of freezing today's names into a test.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SCANNED_DIRECTORIES = ["qpi", "platform", "oracle_interfaces"];

function headerFiles(root: string): string[] {
    const out: string[] = [];

    for (const directory of SCANNED_DIRECTORIES) {
        const base = join(root, "src", directory);

        try {
            statSync(base);
        } catch {
            continue;
        }

        for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith(".h")) {
                out.push(join(entry.parentPath ?? base, entry.name));
            }
        }
    }

    return out;
}

/**
 * Plain (non-template) struct names whose body declares a method with an implementation.
 *
 * A template is excluded: nesting `struct Array` in a contract shadows the template itself, which is a
 * different question from the method-table collision this list is for.
 */
export function coreStructNamesWithMethods(corePath: string): string[] {
    const found = new Set<string>();

    for (const file of headerFiles(corePath)) {
        const lines = readFileSync(file, "utf8").split("\n");

        for (let index = 0; index < lines.length; index++) {
            const declaration = /^[\t ]*struct\s+(\w+)\s*$|^[\t ]*struct\s+(\w+)\s*\{/.exec(lines[index]);

            if (!declaration) {
                continue;
            }

            const previous = lines[index - 1]?.trim() ?? "";

            if (previous.startsWith("template")) {
                continue;
            }

            const name = declaration[1] ?? declaration[2];
            const body = lines.slice(index, index + 80).join("\n");

            // A method with a body: a signature line whose parameter list is followed by a brace.
            if (/\b\w+\s*\([^;]*\)\s*(const\s*)?\{/.test(body)) {
                found.add(name);
            }
        }
    }

    return [...found].sort();
}
