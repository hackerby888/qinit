// The whole chain in one test: compile a contract that prints, run it, and read back the line the dev
// wrote. The unit tests either stop at the wire or start from synthetic records; this is what proves
// the two halves actually meet.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileContractWithTypeScript, loadQpiHeader } from "@qinit/compiler";
import { QubicSimulator } from "@qinit/engine";
import { initK12 } from "@qinit/engine/support/k12";
import { HAS_CORE } from "../../../../test-utils/paths";
import { describeTrace } from "../../src/trace/format";

const ADD = 1;
const source = readFileSync(join(import.meta.dir, "../../../../fixtures/Cheats.h"), "utf8");

test.if(HAS_CORE)("a CC_PRINT written in a contract reads back as the line the dev wrote", async () => {
    const compiled = await compileContractWithTypeScript({ source, contractName: "Cheats", slot: 28, qpiHeader: loadQpiHeader() });

    expect(compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    await initK12();
    const sim = new QubicSimulator();
    sim.setDebug(true);
    sim.deploy(28, compiled.wasm);
    sim.procedure(28, ADD, new Uint8Array(new BigUint64Array([7n]).buffer));

    const entry = sim.getTrace().entries.at(-1)!;
    const view = await describeTrace(entry, source, "Cheats", undefined, compiled.idl);

    expect(view.cheats.map((cheat) => cheat.text)).toEqual(["adding 7", "total is now 7"]);
    expect(view.cheats.map((cheat) => cheat.line)).toEqual([33, 36]);
    // The printed words never became a protocol log.
    expect(view.logs).toEqual([]);
});
