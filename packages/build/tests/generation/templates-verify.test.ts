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

// `qinit new mytoken` used to scaffold `struct CONTRACT_STATE_TYPE` — the form core defines around its
// own includes, which leaves the contract with no name outside them. Scaffolding resolves the macro so
// the file a developer opens, and eventually submits, carries the contract's own name.
for (const kind of TEMPLATE_KINDS) {
    test(`template ${kind} scaffolds under the contract's own name`, () => {
        const named = templateSource(kind, "MyToken");
        expect(named).toContain("struct MyToken : public ContractBase");
        expect(named).not.toContain("CONTRACT_STATE_TYPE");
        expect(named).not.toContain("CONTRACT_STATE2_TYPE");

        // The bodies stay name-agnostic so one file serves every contract; only the scaffold resolves it.
        expect(templateSource(kind)).toContain("CONTRACT_STATE_TYPE");
    });
}
