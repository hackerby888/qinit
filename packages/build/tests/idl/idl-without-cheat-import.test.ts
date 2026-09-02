// The clang backend links its own cheat import and borrows the TypeScript analyzer for the IDL alone,
// so stale core headers must not cost it the cheats table — a client with no typed names is a real loss.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadQpiHeader } from "@qinit/compiler";
import { CORE_PATH, HAS_CORE, qpiHeaderWithoutCheatImport } from "../../../../test-utils/paths";
import { extractIdl } from "../../src/compile/idl";

const CONTRACT = join(import.meta.dir, "../../../../fixtures/Cheats.h");

test.if(HAS_CORE)("the cheats IDL survives headers that never declared the cheat import", () => {
    const source = readFileSync(CONTRACT, "utf8");
    const qpiHeader = qpiHeaderWithoutCheatImport(loadQpiHeader(CORE_PATH));

    const idl = extractIdl(source, "Cheats", { slot: 28, qpiHeader });

    expect(idl.cheats?.map((cheat) => cheat.line)).toEqual([33, 36, 41]);
});
