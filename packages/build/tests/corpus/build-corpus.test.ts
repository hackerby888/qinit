import { CORE_PATH, HAS_CORE, HAS_WASI } from "../../../../test-utils/paths";
// Compile the upstream QUTIL corpus to verify its include redirect and Wasm test harness.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCorpusRunner } from "../../src/index";

const CORE = CORE_PATH;

// Skipped rather than silently passed when the wasi toolchain is absent.
test.skipIf(!HAS_WASI || !HAS_CORE)(
    "QUTIL corpus compiles verbatim against the qinit harness header",
    async () => {
        const outDir = mkdtempSync(join(tmpdir(), "qutil-corpus-"));

        const built = await buildCorpusRunner({
            corpusPath: join(CORE, "test", "contract_qutil.cpp"),
            contractPath: join(CORE, "src", "contracts", "QUtil.h"),
            contractName: "QUTIL",
            stateType: "QUTIL",
            slot: 4,
            corePath: CORE,
            outDir,
        });

        if (!built.ok) {
            console.error("Build stderr:\n" + built.stderr);
        }

        expect(built.ok).toBe(true);
    },
    300000,
);
