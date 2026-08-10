import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveProjectDependencies } from "../../src/project-dependencies";

const CORE = resolve(
  import.meta.dir,
  "../../../vscode/resources/core-headers",
);

function calls(...names: string[]): string {
  return names
    .map((name) => `CALL_OTHER_CONTRACT_FUNCTION(${name}, Get, input, output);`)
    .join("\n");
}

function project(
  files: Record<string, string>,
  run: (root: string) => void,
): void {
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

test("resolves recursive workspace callees in dependency-first order", () => {
  project({
    "contracts/Main.h": calls("Middle", "Shared"),
    "contracts/nested/Middle.h": calls("Leaf", "Shared"),
    "contracts/Leaf.h": "",
    "contracts/Shared.h": "",
  }, (root) => {
    const graph = resolveProjectDependencies({
      projectRoot: root,
      corePath: CORE,
      contractName: "Main",
      contractPath: "contracts/Main.h",
    });

    expect(graph.map((node) => node.stateType)).toEqual([
      "Leaf",
      "Shared",
      "Middle",
      "Main",
    ]);
    expect(graph.find((node) => node.stateType === "Middle")?.dependencies)
      .toEqual(["Leaf", "Shared"]);
  });
});

test("resolves custom callees referenced through ABI types", () => {
  project({
    "contracts/Main.h": "Counter::Get_input input{};",
    "contracts/Counter.h": "",
  }, (root) => {
    const graph = resolveProjectDependencies({
      projectRoot: root,
      corePath: CORE,
      contractName: "Main",
      contractPath: "contracts/Main.h",
    });

    expect(graph.map((node) => node.stateType)).toEqual([
      "Counter",
      "Main",
    ]);
  });
});

test("resolves custom callees referenced only by additional root source", () => {
  project({
    "contracts/Main.h": "",
    "contracts/Helper.h": "",
  }, (root) => {
    const graph = resolveProjectDependencies({
      projectRoot: root,
      corePath: CORE,
      contractName: "Main",
      contractPath: "contracts/Main.h",
      additionalRootSource: `
        INIT_CONTRACT(Helper);
      `,
    });

    expect(graph.map((node) => node.stateType)).toEqual([
      "Helper",
      "Main",
    ]);
  });
});

test("explicit callees override workspace discovery and may omit an index", () => {
  project({
    "contracts/Main.h": calls("Counter"),
    "contracts/Counter.h": calls("Wrong"),
    "contracts/Leaf.h": "",
    "overrides/Counter.h": calls("Leaf"),
  }, (root) => {
    const withoutIndex = resolveProjectDependencies({
      projectRoot: root,
      corePath: CORE,
      contractName: "Main",
      contractPath: "contracts/Main.h",
      explicitCallees: {
        Counter: { header: "overrides/Counter.h" },
      },
    });
    expect(withoutIndex.map((node) => node.stateType)).toEqual([
      "Leaf",
      "Counter",
      "Main",
    ]);
    expect(withoutIndex[1].index).toBeUndefined();

    const withIndex = resolveProjectDependencies({
      projectRoot: root,
      corePath: CORE,
      contractName: "Main",
      contractPath: "contracts/Main.h",
      explicitCallees: {
        Counter: { header: "overrides/Counter.h", index: 31 },
      },
    });
    expect(withIndex[1].index).toBe(31);
  });
});

test("system contracts take precedence over workspace headers", () => {
  project({
    "contracts/Main.h": calls("QUTIL"),
    "contracts/QUTIL.h": calls("MissingWorkspaceDependency"),
  }, (root) => {
    const graph = resolveProjectDependencies({
      projectRoot: root,
      corePath: CORE,
      contractName: "Main",
      contractPath: "contracts/Main.h",
    });

    expect(graph.map((node) => [node.stateType, node.kind, node.index])).toEqual([
      ["QX", "system", 1],
      ["QUTIL", "system", 4],
      ["Main", "custom", undefined],
    ]);
  });
});

test("rejects missing and ambiguous workspace callees deterministically", () => {
  project({
    "contracts/Main.h": calls("Missing"),
  }, (root) => {
    expect(() => resolveProjectDependencies({
      projectRoot: root,
      corePath: CORE,
      contractName: "Main",
      contractPath: "contracts/Main.h",
    })).toThrow(
      "unknown callee 'Missing' referenced by Main; expected --callee Missing=path[@index] or contracts/**/Missing.h",
    );
  });

  project({
    "contracts/Main.h": calls("Counter"),
    "contracts/one/Counter.h": "",
    "contracts/two/Counter.h": "",
  }, (root) => {
    expect(() => resolveProjectDependencies({
      projectRoot: root,
      corePath: CORE,
      contractName: "Main",
      contractPath: "contracts/Main.h",
    })).toThrow(
      "callee 'Counter' referenced by Main is ambiguous: contracts/one/Counter.h, contracts/two/Counter.h",
    );
  });
});

test("rejects dependency cycles and self-calls with the dependency chain", () => {
  project({
    "contracts/Main.h": calls("First"),
    "contracts/First.h": calls("Second"),
    "contracts/Second.h": calls("First"),
  }, (root) => {
    expect(() => resolveProjectDependencies({
      projectRoot: root,
      corePath: CORE,
      contractName: "Main",
      contractPath: "contracts/Main.h",
    })).toThrow("inter-contract dependency cycle: First -> Second -> First");
  });

  project({
    "contracts/Main.h": calls("Main"),
  }, (root) => {
    expect(() => resolveProjectDependencies({
      projectRoot: root,
      corePath: CORE,
      contractName: "Main",
      contractPath: "contracts/Main.h",
    })).toThrow("inter-contract dependency cycle: Main -> Main");
  });
});

test("rejects explicit and main contract system-name overrides", () => {
  project({
    "contracts/Main.h": "",
    "contracts/CustomQx.h": "",
  }, (root) => {
    expect(() => resolveProjectDependencies({
      projectRoot: root,
      corePath: CORE,
      contractName: "Main",
      contractPath: "contracts/Main.h",
      explicitCallees: {
        QX: { header: "contracts/CustomQx.h" },
      },
    })).toThrow("--callee 'QX' cannot override system contract QX at slot 1");

    expect(() => resolveProjectDependencies({
      projectRoot: root,
      corePath: CORE,
      contractName: "qx",
      contractPath: "contracts/CustomQx.h",
    })).toThrow("contract name 'qx' is reserved by system contract QX at slot 1");
  });
});
