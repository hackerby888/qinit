import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveContracts } from "../../src/contracts/project-dependencies";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";

const CORE = CORE_PATH;

function calls(...names: string[]): string {
    return names.map((name) => `CALL_OTHER_CONTRACT_FUNCTION(${name}, Get, input, output);`).join("\n");
}

function project(files: Record<string, string>, run: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "qinit-project-deps-"));
    try {
        for (const [path, source] of Object.entries(files)) {
            const fullPath = join(root, path);
            mkdirSync(dirname(fullPath), { recursive: true });
            writeFileSync(fullPath, source);
        }
        run(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

test.skipIf(!HAS_CORE)("resolves recursive workspace callees in dependency-first order", () => {
    project(
        {
            "contracts/Main.h": calls("Middle", "Shared"),
            "contracts/nested/Middle.h": contract("Middle", calls("Leaf", "Shared")),
            "contracts/Leaf.h": contract("Leaf"),
            "contracts/Shared.h": contract("Shared"),
        },
        (root) => {
            const graph = resolveContracts({
                projectRoot: root,
                corePath: CORE,
                contractName: "Main",
                contractPath: "contracts/Main.h",
            });

            expect(graph.map((node) => node.stateType)).toEqual(["Leaf", "Shared", "Middle", "Main"]);
            expect(graph.find((node) => node.stateType === "Middle")?.callees).toEqual(["Leaf", "Shared"]);
        },
    );
});

test.skipIf(!HAS_CORE)("resolves custom callees referenced through ABI types", () => {
    project(
        {
            "contracts/Main.h": "Counter::Get_input input{};",
            "contracts/Counter.h": contract("Counter"),
        },
        (root) => {
            const graph = resolveContracts({
                projectRoot: root,
                corePath: CORE,
                contractName: "Main",
                contractPath: "contracts/Main.h",
            });

            expect(graph.map((node) => node.stateType)).toEqual(["Counter", "Main"]);
        },
    );
});

test.skipIf(!HAS_CORE)("resolves custom callees referenced only by additional root source", () => {
    project(
        {
            "contracts/Main.h": "",
            "contracts/Helper.h": contract("Helper"),
        },
        (root) => {
            const graph = resolveContracts({
                projectRoot: root,
                corePath: CORE,
                contractName: "Main",
                contractPath: "contracts/Main.h",
                additionalRootSource: `
        INIT_CONTRACT(Helper);
      `,
            });

            expect(graph.map((node) => node.stateType)).toEqual(["Helper", "Main"]);
        },
    );
});

test.skipIf(!HAS_CORE)("explicit callees override workspace discovery and may omit a slot", () => {
    project(
        {
            "contracts/Main.h": calls("Counter"),
            "contracts/Counter.h": contract("Counter", calls("Wrong")),
            "contracts/Leaf.h": contract("Leaf"),
            "overrides/Counter.h": calls("Leaf"),
        },
        (root) => {
            const withoutSlot = resolveContracts({
                projectRoot: root,
                corePath: CORE,
                contractName: "Main",
                contractPath: "contracts/Main.h",
                explicitCallees: {
                    Counter: { header: "overrides/Counter.h" },
                },
            });
            expect(withoutSlot.map((node) => node.stateType)).toEqual(["Leaf", "Counter", "Main"]);
            expect(withoutSlot[1].slot).toBeUndefined();

            const withSlot = resolveContracts({
                projectRoot: root,
                corePath: CORE,
                contractName: "Main",
                contractPath: "contracts/Main.h",
                explicitCallees: {
                    Counter: { header: "overrides/Counter.h", slot: 31 },
                },
            });
            expect(withSlot[1].slot).toBe(31);
        },
    );
});

test.skipIf(!HAS_CORE)("a header merely named after a system contract does not replace it", () => {
    project(
        {
            "contracts/Main.h": calls("QUTIL"),
            "contracts/QUTIL.h": calls("MissingWorkspaceDependency"),
        },
        (root) => {
            const graph = resolveContracts({
                projectRoot: root,
                corePath: CORE,
                contractName: "Main",
                contractPath: "contracts/Main.h",
            });

            expect(graph.map((node) => [node.stateType, node.kind, node.slot])).toEqual([
                ["QX", "system", 1],
                ["QUTIL", "system", 4],
                ["Main", "custom", undefined],
            ]);
        },
    );
});

test.skipIf(!HAS_CORE)("rejects missing and ambiguous workspace callees deterministically", () => {
    project(
        {
            "contracts/Main.h": calls("Missing"),
        },
        (root) => {
            expect(() =>
                resolveContracts({
                    projectRoot: root,
                    corePath: CORE,
                    contractName: "Main",
                    contractPath: "contracts/Main.h",
                }),
            ).toThrow("unknown callee 'Missing' referenced by Main; expected --callee Missing=path[@index] or contracts/**/Missing.h");
        },
    );

    project(
        {
            "contracts/Main.h": calls("Counter"),
            "contracts/one/Counter.h": contract("Counter"),
            "contracts/two/Counter.h": contract("Counter"),
        },
        (root) => {
            expect(() =>
                resolveContracts({
                    projectRoot: root,
                    corePath: CORE,
                    contractName: "Main",
                    contractPath: "contracts/Main.h",
                }),
            ).toThrow("callee 'Counter' referenced by Main is ambiguous: contracts/one/Counter.h, contracts/two/Counter.h");
        },
    );
});

test.skipIf(!HAS_CORE)("rejects dependency cycles and ignores self-calls", () => {
    project(
        {
            "contracts/Main.h": calls("First"),
            "contracts/First.h": contract("First", calls("Second")),
            "contracts/Second.h": contract("Second", calls("First")),
        },
        (root) => {
            expect(() =>
                resolveContracts({
                    projectRoot: root,
                    corePath: CORE,
                    contractName: "Main",
                    contractPath: "contracts/Main.h",
                }),
            ).toThrow("inter-contract dependency cycle: First -> Second -> First");
        },
    );

    project(
        {
            "contracts/Main.h": calls("Main"),
        },
        (root) => {
            const graph = resolveContracts({
                projectRoot: root,
                corePath: CORE,
                contractName: "Main",
                contractPath: "contracts/Main.h",
            });

            expect(graph.map((node) => node.stateType)).toEqual(["Main"]);
            expect(graph[0]?.callees).toEqual([]);
        },
    );
});

test.skipIf(!HAS_CORE)("rejects explicit and main contract system-name overrides", () => {
    project(
        {
            "contracts/Main.h": "",
            "contracts/CustomQx.h": "",
        },
        (root) => {
            expect(() =>
                resolveContracts({
                    projectRoot: root,
                    corePath: CORE,
                    contractName: "Main",
                    contractPath: "contracts/Main.h",
                    explicitCallees: {
                        QX: { header: "contracts/CustomQx.h" },
                    },
                }),
            ).toThrow("--callee 'QX' cannot override system contract QX at slot 1");

            expect(() =>
                resolveContracts({
                    projectRoot: root,
                    corePath: CORE,
                    contractName: "qx",
                    contractPath: "contracts/CustomQx.h",
                }),
            ).toThrow("contract name 'qx' is reserved by system contract QX at slot 1");
        },
    );
});

function contract(name: string, body = ""): string {
    return `struct ${name} : public ContractBase {
  struct StateData {};
  struct Get_input {}; struct Get_output {};
  PUBLIC_FUNCTION(Get) {}
  ${body}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
};`;
}

test.skipIf(!HAS_CORE)("includeWorkspaceSiblings appends unreferenced contracts after the reachable ones", () => {
    project(
        {
            "contracts/Main.h": contract("Main", calls("Leaf")),
            "contracts/Leaf.h": contract("Leaf"),
            "contracts/Sibling.h": contract("Sibling"),
        },
        (root) => {
            const options = {
                projectRoot: root,
                corePath: CORE,
                contractName: "Main",
                contractPath: "contracts/Main.h",
            };
            const reachable = resolveContracts(options);
            const widened = resolveContracts({ ...options, includeWorkspaceSiblings: true });

            expect(reachable.map((node) => node.stateType)).toEqual(["Leaf", "Main"]);
            expect(widened.map((node) => node.stateType)).toEqual(["Leaf", "Main", "Sibling"]);
            expect(widened.filter((node) => node.workspaceSibling).map((node) => node.stateType)).toEqual(["Sibling"]);
            // The sibling is offered for completion, not called, so it must not become a dependency.
            expect(widened.find((node) => node.stateType === "Main")?.callees).toEqual(["Leaf"]);
        },
    );
});

test.skipIf(!HAS_CORE)("a broken or non-contract sibling is skipped instead of failing resolution", () => {
    project(
        {
            "contracts/Main.h": contract("Main"),
            "contracts/Broken.h": contract("Broken", calls("Missing")),
            "contracts/helpers.h": "static constexpr unsigned int SHARED_LIMIT = 4;",
        },
        (root) => {
            const graph = resolveContracts({
                projectRoot: root,
                corePath: CORE,
                contractName: "Main",
                contractPath: "contracts/Main.h",
                includeWorkspaceSiblings: true,
            });

            expect(graph.map((node) => node.stateType)).toEqual(["Main"]);
        },
    );
});

// a helper header under contracts/ is a plain qualified type to the contract, not a callee that would take a slot
test.skipIf(!HAS_CORE)("a qualified call into a helper header is not a callee", () => {
    project(
        {
            "contracts/Main.h": contract("Main", "uint64 next() { return MainMath::bump(1); }"),
            "contracts/MainMath.h": "struct MainMath { static inline uint64 bump(uint64 value) { return value + 2; } };",
        },
        (root) => {
            const graph = resolveContracts({ projectRoot: root, corePath: CORE, contractName: "Main", contractPath: "contracts/Main.h", includeWorkspaceSiblings: true });

            expect(graph.map((node) => node.stateType)).toEqual(["Main"]);
        },
    );
});

// a project copy of a core contract keeps its struct and takes its own deploy name, so none of its prefixed globals move.
test.skipIf(!HAS_CORE)("a project header declaring a core struct is the main contract under its own deploy name", () => {
    project({ "contracts/MyQx.h": contract("QX") }, (root) => {
        const graph = resolveContracts({ projectRoot: root, corePath: CORE, contractName: "MyQx", contractPath: "contracts/MyQx.h" });
        expect(graph.map((node) => [node.name, node.stateType, node.kind])).toEqual([["MyQx", "QX", "custom"]]);
    });
});

test.skipIf(!HAS_CORE)("a project contract calling a core struct binds to the project's copy", () => {
    project(
        {
            "contracts/Main.h": contract("Main", calls("QUTIL", "QX")),
            "contracts/MyQx.h": contract("QX"),
        },
        (root) => {
            const graph = resolveContracts({ projectRoot: root, corePath: CORE, contractName: "Main", contractPath: "contracts/Main.h" });
            const qx = graph.filter((node) => node.stateType === "QX");
            expect(qx.map((node) => [node.name, node.kind, node.slot])).toEqual([["MyQx", "custom", undefined]]);
            expect(graph.find((node) => node.stateType === "QUTIL")?.kind).toBe("system");
            // one node per struct: core's QUTIL names the copy too, which is what the prelude needs; the node itself calls slot 1 natively
            expect(graph.find((node) => node.stateType === "QUTIL")?.callees).toContain("QX");
            expect(graph.at(-1)?.callees).toEqual(["QUTIL", "QX"]);
        },
    );
});

// core's own contracts are compiled against canonical slots, so their references never pick up a project header.
test.skipIf(!HAS_CORE)("a core contract's own callees come from the catalog even when the project holds a copy", () => {
    project(
        {
            "contracts/Main.h": contract("Main", calls("QUTIL")),
            "contracts/MyQx.h": contract("QX"),
        },
        (root) => {
            const graph = resolveContracts({ projectRoot: root, corePath: CORE, contractName: "Main", contractPath: "contracts/Main.h" });
            expect(graph.map((node) => [node.stateType, node.kind, node.slot])).toEqual([
                ["QX", "system", 1],
                ["QUTIL", "system", 4],
                ["Main", "custom", undefined],
            ]);
        },
    );
});

// deploy copies the core headers a project depends on under contracts/system_scs for the editor; a redeploy must not read them as project copies.
test.skipIf(!HAS_CORE)("the copies under contracts/system_scs are not project contracts", () => {
    project(
        {
            "contracts/Test.h": contract("QUTIL", calls("QX")),
            "contracts/system_scs/Qx.h": contract("QX"),
        },
        (root) => {
            const graph = resolveContracts({ projectRoot: root, corePath: CORE, contractName: "Test", contractPath: "contracts/Test.h" });
            expect(graph.map((node) => [node.name, node.stateType, node.kind, node.slot])).toEqual([
                ["QX", "QX", "system", 1],
                ["Test", "QUTIL", "custom", undefined],
            ]);
        },
    );
});

// two project headers declaring the same core struct cannot both be the copy a caller means; silently taking the catalog would hide the mistake.
test.skipIf(!HAS_CORE)("two project copies of one core struct are an ambiguous callee", () => {
    project(
        {
            "contracts/Main.h": contract("Main", calls("QX")),
            "contracts/MyQx.h": contract("QX"),
            "contracts/MyQx2.h": contract("QX"),
        },
        (root) => {
            expect(() => resolveContracts({ projectRoot: root, corePath: CORE, contractName: "Main", contractPath: "contracts/Main.h" })).toThrow(
                "callee 'QX' referenced by Main is ambiguous: contracts/MyQx.h, contracts/MyQx2.h",
            );
        },
    );
});
