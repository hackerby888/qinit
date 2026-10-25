// `qinit call QX` reaches the native QX only; a developer whose project copy of QX runs on the node is told where it went.
import { expect, test } from "bun:test";
import { notLoadedMessage, projectCopiesOf, type ContractSets } from "../../src/contracts/registry";

const copy = (index: number, name: string, struct: string) => ({ index, name, armed: true, source: `struct ${struct} : public ContractBase { struct StateData {}; };` }) as any;

test("project copies of a system struct are named in the not-loaded message", () => {
    const sets: ContractSets = { user: [copy(31, "MyQx", "QX"), copy(32, "MyQx2", "QX"), copy(33, "Counter", "Counter")], system: [] };
    expect(projectCopiesOf(sets, "QX")).toEqual(["MyQx", "MyQx2"]);
    expect(projectCopiesOf(sets, "QUTIL")).toEqual([]);
    expect(notLoadedMessage("QX", ["MyQx", "MyQx2"])).toBe("QX is not running on this simulator — qinit system add QX · this node runs MyQx, MyQx2, project copies of QX");
    expect(notLoadedMessage("QX")).toBe("QX is not running on this simulator — qinit system add QX");
});
