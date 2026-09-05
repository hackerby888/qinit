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
            "contracts/nested/Middle.h": calls("Leaf", "Shared"),
            "contracts/Leaf.h": "",
            "contracts/Shared.h": "",
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
            "contracts/Counter.h": "",
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
            "contracts/Helper.h": "",
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
            "contracts/Counter.h": calls("Wrong"),
            "contracts/Leaf.h": "",
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

test.skipIf(!HAS_CORE)("system contracts take precedence over workspace headers", () => {
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
            "contracts/one/Counter.h": "",
            "contracts/two/Counter.h": "",
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
            "contracts/First.h": calls("Second"),
            "contracts/Second.h": calls("First"),
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
