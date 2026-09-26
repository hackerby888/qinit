import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_SOURCE_DIR, writeSystemSource } from "../../src/contracts/system-wasm";

test("a deployed system header is copied under contracts/system_scs and rewritten only when core's copy changes", () => {
    const root = mkdtempSync(join(tmpdir(), "qinit-system-source-"));
    try {
        const corePath = join(root, "QUtil.h");
        writeFileSync(corePath, "struct QUTIL : public ContractBase {};\n");

        const relativePath = writeSystemSource(root, corePath);
        expect(relativePath).toBe(`${SYSTEM_SOURCE_DIR}/QUtil.h`);
        const target = join(root, "contracts", "system_scs", "QUtil.h");
        expect(readFileSync(target, "utf8")).toBe(readFileSync(corePath, "utf8"));

        // an identical copy is left alone, so a watcher keyed on mtime sees nothing
        const stale = new Date(Date.now() - 60_000);
        utimesSync(target, stale, stale);
        expect(writeSystemSource(root, corePath)).toBe(relativePath);
        expect(statSync(target).mtimeMs).toBe(stale.getTime());

        writeFileSync(corePath, "struct QUTIL : public ContractBase { uint64 x; };\n");
        writeSystemSource(root, corePath);
        expect(readFileSync(target, "utf8")).toBe(readFileSync(corePath, "utf8"));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
