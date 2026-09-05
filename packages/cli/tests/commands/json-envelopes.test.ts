// The commands that used to accept --json and render Ink anyway now emit a document; each builder is pure.
import { expect, test } from "bun:test";
import { META } from "../../src/meta";
import { genJsonResult } from "../../src/commands/develop/gen";
import { doctorJsonResult } from "../../src/commands/setup/doctor";
import { cleanJsonResult } from "../../src/commands/setup/clean";
import { integrateJsonResult } from "../../src/commands/develop/integrate";
import { backendPickerJsonResult } from "../../src/commands/misc/backend-picker";
import { seedJsonResult } from "../../src/commands/deploy-interact/seed";
import { systemJsonResult } from "../../src/commands/deploy-interact/system";

test("every command that renders a document advertises --json in its metadata", () => {
    for (const command of ["seed", "runtime", "compiler", "system", "gen", "doctor", "clean", "integrate"] as const) {
        expect(META[command].json, command).toBe(true);
    }
});

test("gen reports the generated client or the failure under one envelope", () => {
    expect(genJsonResult({ ok: true, file: "/p/Counter.ts", name: "Counter", slot: 29, fns: 1, procs: 1 })).toEqual({
        ok: true,
        file: "/p/Counter.ts",
        name: "Counter",
        slot: 29,
        fns: 1,
        procs: 1,
        error: null,
    });
    expect(genJsonResult({ ok: false, err: "no such file" })).toEqual({ ok: false, error: "no such file" });
});

test("doctor fails the document only on a required check", () => {
    const optionalMissing = doctorJsonResult([
        { name: "wasi-sdk", ok: true, detail: "/sdk/clang++" },
        { name: "contract-verify tool", ok: null, detail: "not fetched", fix: "qinit setup", optional: true },
    ]);
    expect(optionalMissing.ok).toBe(true);
    expect(optionalMissing.error).toBeNull();
    expect(optionalMissing.checks[1]).toEqual({ name: "contract-verify tool", ok: null, detail: "not fetched", fix: "qinit setup", optional: true });

    const headersMissing = doctorJsonResult([{ name: "qubic-core-lite headers", ok: false, detail: "headers not found", fix: "qinit setup" }]);
    expect(headersMissing.ok).toBe(false);
    expect(headersMissing.error).toBe("qubic-core-lite headers not ready");
});

test("clean carries byte counts, the dry-run flag and the cache root", () => {
    const done = cleanJsonResult({ phase: "done", items: [{ name: "wasi-sdk", sz: 382300000 }], total: 382300000, killed: false }, true, "/c");
    expect(done).toEqual({ ok: true, dryRun: true, root: "/c", total: 382300000, items: [{ name: "wasi-sdk", bytes: 382300000 }], killed: false, error: null });
    expect(cleanJsonResult({ phase: "empty" }, false, "/c")).toEqual({ ok: true, dryRun: false, root: "/c", total: 0, items: [], killed: false, error: null });
    expect(cleanJsonResult({ phase: "err", err: "EACCES" }, false, "/c").error).toBe("EACCES");
});

test("integrate reports the wired contract or the refusal", () => {
    const done = integrateJsonResult({
        phase: "done",
        contractName: "PCheat",
        result: { mode: "created", contractIndex: 29, corePath: "/core", branch: "qinit/pcheat", warnings: ["x"] } as any,
    });
    expect(done).toEqual({ ok: true, mode: "created", contractIndex: 29, corePath: "/core", branch: "qinit/pcheat", testPath: null, warnings: ["x"], error: null });
    expect(integrateJsonResult({ phase: "error", message: "checkout is dirty" })).toEqual({ ok: false, error: "checkout is dirty" });
});

test("runtime and compiler report the active backend and the choices", () => {
    expect(backendPickerJsonResult("runtime", "core", ["core", "simulator"], ["✓ runtime set: core"])).toEqual({
        ok: true,
        command: "runtime",
        active: "core",
        backends: ["core", "simulator"],
        lines: ["✓ runtime set: core"],
        error: null,
    });
    const unknown = backendPickerJsonResult("compiler", "clang", ["clang", "typescript"], ["✗ unknown compiler 'gcc' — pick: clang, typescript"]);
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toBe("unknown compiler 'gcc' — pick: clang, typescript");
});

test("seed carries the saved seed's facts, never the rendered lines", () => {
    const shown = seedJsonResult({ action: "show", seed: "a".repeat(55), identity: "ID", balance: "2000000000000", path: "/cfg/seed" }, null);
    expect(shown).toEqual({ ok: true, action: "show", seed: "a".repeat(55), identity: "ID", balance: "2000000000000", path: "/cfg/seed", error: null });
    const refused = seedJsonResult(null, "no terminal to pick in — pass the seed instead: qinit seed <seed>");
    expect(refused.ok).toBe(false);
    expect(refused.action).toBeNull();
});

test("system ls carries the catalog rows as data next to the rendered lines", () => {
    const result = systemJsonResult("ls", [{ t: " 1  QX           live", ok: true }], [{ index: 1, name: "QX", state: "live" }], ["QX"]);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("ls");
    expect(result.catalog).toEqual([{ index: 1, name: "QX", state: "live" }]);
    expect(result.selected).toEqual(["QX"]);
    expect(result.lines[0]).toEqual({ text: " 1  QX           live", ok: true });
});
