// The Node and browser entries are hand-maintained barrels over the same modules, so they drift silently — the browser surface must be a subset of the main.
import { expect, test } from "bun:test";
import * as browserEntry from "../../src/browser";
import * as nodeEntry from "../../src/index";

test("every browser export is also exported from the main entry", () => {
    const nodeExports = new Set(Object.keys(nodeEntry));
    const missing = Object.keys(browserEntry).filter((name) => !nodeExports.has(name));

    expect(missing).toEqual([]);
});

test("the browser entry stays a strict subset", () => {
    expect(Object.keys(browserEntry).length).toBeLessThan(Object.keys(nodeEntry).length);
});
