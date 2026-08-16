import { test, expect } from "bun:test";
import { templateSource, TEMPLATE_KINDS } from "../../src/generate/templates";
import { verifyContract, resolveVerifyTool } from "@qinit/build";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const noVerifyTool = !resolveVerifyTool();

for (const kind of TEMPLATE_KINDS) {
    test.skipIf(noVerifyTool)(`template ${kind} verifies`, async () => {
        const name = kind[0].toUpperCase() + kind.slice(1);
        const f = join(tmpdir(), `tmpl-${kind}.h`);
        writeFileSync(f, templateSource(kind));
        const r = await verifyContract(f, name, kind === "intercontract" ? { allowedPrefixes: ["Counter"] } : undefined);
        if (!r.ok) console.error(`\n[${kind}] errors:`, JSON.stringify(r.errors, null, 2));
        expect(r.ok).toBe(true);
    });
}
