// With a callee in the project the main contract does not sit at the window base, so a client generated
// from that base points at the callee. The deploy already wrote the right slot to qinit.idl.json.
import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractIdl } from "@qinit/build";
import { loadQpiHeader } from "@qinit/compiler";
import { saveContractIdl } from "../../src/contracts/idl-file";

const core = process.env.QINIT_CORE?.trim();
const haveCore = !!core && existsSync(join(core, "src", "qpi", "qpi.h"));
const cli = resolve(import.meta.dir, "../../src/index.tsx");
const fixtures = resolve(import.meta.dir, "../../../../fixtures");

test.skipIf(!haveCore)("gen takes the main contract's slot from the IDL file, not the window base", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "qinit-gen-slot-"));
    mkdirSync(join(projectRoot, "contracts"));
    copyFileSync(join(fixtures, "Counter.h"), join(projectRoot, "contracts", "Counter.h"));
    copyFileSync(join(fixtures, "Proxy.h"), join(projectRoot, "contracts", "Proxy.h"));

    try {
        const qpiHeader = loadQpiHeader(core!);
        const idlPath = join(projectRoot, "qinit.idl.json");
        saveContractIdl(29, extractIdl(readFileSync(join(projectRoot, "contracts", "Counter.h"), "utf8"), "Counter", { slot: 29, qpiHeader }), idlPath);
        saveContractIdl(30, extractIdl(readFileSync(join(projectRoot, "contracts", "Proxy.h"), "utf8"), "Proxy", { slot: 30, qpiHeader }), idlPath);

        const child = Bun.spawn([process.execPath, cli, "gen", "contracts/Proxy.h", "--core-dir", core!, "--out", "dist/clients"], {
            cwd: projectRoot,
            env: { ...process.env, QINIT_NO_UPDATE: "1" },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

        expect(exitCode, stderr).toBe(0);
        expect(stdout).toContain("30");
        expect(readFileSync(join(projectRoot, "dist", "clients", "Proxy.ts"), "utf8")).toContain("this.index = o.index ?? 30;");
    } finally {
        rmSync(projectRoot, { recursive: true, force: true });
    }
});
