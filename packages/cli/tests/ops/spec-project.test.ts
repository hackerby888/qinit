import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSpecProject, installSpecTypes } from "../../src/ops/spec-project";

const workDir = mkdtempSync(join(tmpdir(), "qinit-spec-project-"));

afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
});

function project(name: string): string {
    const root = join(workDir, name);
    mkdirSync(root, { recursive: true });
    return root;
}

test("a bare project gets an ESM package.json with @types/bun and a fixed tsconfig", () => {
    const root = project("bare");
    ensureSpecProject(root);

    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toEqual({
        name: "bare",
        private: true,
        type: "module",
        devDependencies: { "@types/bun": "latest" },
    });
    expect(JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"))).toEqual({
        compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true, skipLibCheck: true },
    });
});

// The developer's own choices win: their fields, their pinned version, their tsconfig.
test("an existing package.json and tsconfig keep what the developer wrote", () => {
    const root = project("owned");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "mine", scripts: { lint: "x" }, devDependencies: { "@types/bun": "1.2.0" } }));
    writeFileSync(join(root, "tsconfig.json"), '{ "compilerOptions": { "strict": false } }\n');
    ensureSpecProject(root);

    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toEqual({
        name: "mine",
        scripts: { lint: "x" },
        devDependencies: { "@types/bun": "1.2.0" },
        type: "module",
    });
    expect(readFileSync(join(root, "tsconfig.json"), "utf8")).toBe('{ "compilerOptions": { "strict": false } }\n');
});

test("a second run changes nothing", () => {
    const root = project("twice");
    ensureSpecProject(root);
    const before = [readFileSync(join(root, "package.json"), "utf8"), readFileSync(join(root, "tsconfig.json"), "utf8")];
    ensureSpecProject(root);
    expect([readFileSync(join(root, "package.json"), "utf8"), readFileSync(join(root, "tsconfig.json"), "utf8")]).toEqual(before);
});

test("the install is skipped when the types are present or the CLI runs without network", async () => {
    const root = project("installed");
    mkdirSync(join(root, "node_modules", "@types", "bun"), { recursive: true });
    expect(await installSpecTypes(root)).toBe("present");

    const offline = project("offline");
    const previous = process.env.QINIT_NO_UPDATE;
    process.env.QINIT_NO_UPDATE = "1";
    try {
        expect(await installSpecTypes(offline)).toBe("skipped");
    } finally {
        if (previous === undefined) delete process.env.QINIT_NO_UPDATE;
        else process.env.QINIT_NO_UPDATE = previous;
    }
    expect(existsSync(join(offline, "node_modules"))).toBe(false);
});
