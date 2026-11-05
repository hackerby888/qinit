import { CORE_PATH, HAS_CORE, HAS_WASI } from "../../../../test-utils/paths";
// A header bundle is all a fresh install has, so it must carry everything a project's gtest includes.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCoreWasmSlotLayout } from "@qinit/core";
import { buildCorpusRunner, buildSnapshot } from "../../src/index";
import { templateGtest, templateSource } from "../../src/generate/templates";

test.skipIf(!HAS_WASI || !HAS_CORE)(
    "a project gtest builds against the header bundle alone",
    async () => {
        const dir = mkdtempSync(join(tmpdir(), "qinit-snapshot-"));
        try {
            const snapshot = await buildSnapshot(CORE_PATH, dir);
            const contractPath = join(dir, "Probe.h");
            const corpusPath = join(dir, "Probe.test.cpp");
            writeFileSync(contractPath, templateSource("counter", "Probe"));
            writeFileSync(corpusPath, templateGtest("counter", "Probe"));

            const built = await buildCorpusRunner({
                corpusPath,
                contractPath,
                contractName: "Probe",
                stateType: "Probe",
                slot: loadCoreWasmSlotLayout(snapshot.root).slotBase,
                corePath: snapshot.root,
                outDir: join(dir, "out"),
            });

            expect(built.stderr ?? "").not.toContain("file not found");
            expect(built.ok).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    },
    300000,
);
