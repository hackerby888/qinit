// The Node and browser entry points are hand-maintained barrels over the same modules, so they drift
// silently. The browser surface is a subset of the main one — anything it exports must exist in both.
import { expect, test } from "bun:test";
import * as browserEntry from "../src/browser";
import * as nodeEntry from "../src/index";

test("every browser export is also exported from the main entry", () => {
    const nodeExports = new Set(Object.keys(nodeEntry));
    const missing = Object.keys(browserEntry).filter((name) => !nodeExports.has(name));

    expect(missing).toEqual([]);
});

test("the browser entry stays a strict subset", () => {
    expect(Object.keys(browserEntry).length).toBeLessThan(Object.keys(nodeEntry).length);
});
