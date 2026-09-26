// uninstall run from a checkout must never list the runtime it was started from; on Windows that runtime is bun.exe.
import { expect, test } from "bun:test";
import { binTargets } from "../../src/commands/setup/uninstall";

test("uninstall targets a qinit binary but never the bun or node running a checkout", () => {
    for (const runtime of ["C:\\Users\\u\\.bun\\bin\\bun.exe", "/usr/bin/bun", "/usr/bin/node", "C:\\nodejs\\node.exe"]) {
        expect(binTargets(runtime), runtime).not.toContain(runtime);
    }
    for (const installed of ["/home/u/.local/bin/qinit", "C:\\q\\qinit.exe"]) {
        expect(binTargets(installed), installed).toContain(installed);
    }
});
