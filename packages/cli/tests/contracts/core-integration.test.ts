import {
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CoreIntegrationMetadataRequiredError,
  inspectCoreIntegration,
  runCoreIntegration,
} from "../../src/ops/core-integration";

const temporaryDirectories: string[] = [];
const CRLF = "\r\n";

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "qinit-core-integration-test-"));
  temporaryDirectories.push(path);
  return path;
}

// Commits also run in the checkouts the integration clones, which inherit no identity — and CI
// machines have no global one either, so every call carries the fixture identity.
const GIT_IDENTITY = [
  "-c",
  "user.email=qinit@example.test",
  "-c",
  "user.name=Qinit Test",
];

function runGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...GIT_IDENTITY, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
}

function writeCoreText(path: string, lines: string[], bom = false): void {
  writeFileSync(path, `${bom ? "\ufeff" : ""}${lines.join(CRLF)}${CRLF}`);
}

function createCoreRepository(root: string, baseAssetName = "BASE"): string {
  const corePath = join(root, "core-source");
  mkdirSync(join(corePath, "src", "contract_core"), { recursive: true });
  mkdirSync(join(corePath, "src", "contracts"), { recursive: true });
  mkdirSync(join(corePath, "test"), { recursive: true });

  writeCoreText(join(corePath, "src", "contract_core", "contract_def.h"), [
    "#pragma once",
    "",
    "#define BASE_CONTRACT_INDEX 1",
    "#define CONTRACT_INDEX BASE_CONTRACT_INDEX",
    "#define CONTRACT_STATE_TYPE Base",
    "#define CONTRACT_STATE2_TYPE Base2",
    "#include \"contracts/Base.h\"",
    "",
    "// new contracts should be added above this line",
    "",
    "struct IPO {};",
    "constexpr struct ContractDescription",
    "{",
    "    char assetName[8];",
    "    unsigned short constructionEpoch, destructionEpoch;",
    "    unsigned long long stateSize;",
    "} contractDescriptions[] = {",
    "    {\"\", 0, 0, sizeof(int)},",
    `    {"${baseAssetName}", 1, 10000, sizeof(Base::StateData)},`,
    "    // new contracts should be added above this line",
    "};",
    "",
    "static void initializeContracts()",
    "{",
    "    REGISTER_CONTRACT_FUNCTIONS_AND_PROCEDURES(Base);",
    "    // new contracts should be added above this line",
    "}",
  ]);
  writeCoreText(join(corePath, "src", "contracts", "Base.h"), [
    "struct Base { struct StateData {}; };",
  ]);
  writeCoreText(join(corePath, "src", "Qubic.vcxproj"), [
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
    "<Project>",
    "  <ItemGroup>",
    "    <ClInclude Include=\"contracts\\Base.h\" />",
    "  </ItemGroup>",
    "</Project>",
  ], true);
  writeCoreText(join(corePath, "src", "Qubic.vcxproj.filters"), [
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
    "<Project>",
    "  <ItemGroup>",
    "    <ClInclude Include=\"contracts\\Base.h\">",
    "      <Filter>contracts</Filter>",
    "    </ClInclude>",
    "  </ItemGroup>",
    "</Project>",
  ], true);
  writeCoreText(join(corePath, "test", "test.vcxproj"), [
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
    "<Project>",
    "  <ItemGroup>",
    "    <ClCompile Include=\"contract_base.cpp\" />",
    "  </ItemGroup>",
    "</Project>",
  ], true);
  writeCoreText(join(corePath, "test", "test.vcxproj.filters"), [
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
    "<Project>",
    "  <ItemGroup>",
    "    <ClCompile Include=\"contract_base.cpp\" />",
    "  </ItemGroup>",
    "</Project>",
  ], true);

  runGit(corePath, "init", "-b", "main");
  runGit(corePath, "config", "core.autocrlf", "false");
  runGit(corePath, "add", ".");
  runGit(corePath, "commit", "-m", "Initial core fixture");
  return corePath;
}

function createProject(root: string): string {
  const projectRoot = join(root, "project");
  mkdirSync(join(projectRoot, "contracts"), { recursive: true });
  mkdirSync(join(projectRoot, "tests"), { recursive: true });
  writeFileSync(
    join(projectRoot, "contracts", "Main.h"),
    "struct Main { struct StateData { Base::StateData* base; }; };\n",
  );
  writeFileSync(
    join(projectRoot, "tests", "Main.test.cpp"),
    "#include \"contract_testing.h\"\nTEST_CONTRACT(Main);\n",
  );
  return projectRoot;
}

function expectBomAndCrlf(path: string): void {
  const bytes = readFileSync(path);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.subarray(3).toString("utf8");
  expect(text).toContain(CRLF);
  expect(text.replaceAll(CRLF, "")).not.toContain("\n");
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("runCoreIntegration", () => {
  test("creates and safely updates a Core integration", async () => {
    const root = temporaryDirectory();
    const repositoryUrl = createCoreRepository(root);
    const projectRoot = createProject(root);
    const outputPath = join(root, "Main-core");
    const options = {
      projectRoot,
      contractPath: "contracts/Main.h",
      contractName: "Main",
      outputPath,
      assetName: "MAIN",
      constructionEpoch: 300,
      repositoryUrl,
    };

    await expect(runCoreIntegration({
      ...options,
      requireDestructionEpoch: true,
    })).rejects.toBeInstanceOf(CoreIntegrationMetadataRequiredError);
    expect(runGit(outputPath, "branch", "--show-current")).toBe("main");
    expect(runGit(outputPath, "status", "--porcelain")).toBe("");

    const created = await runCoreIntegration(options);

    expect(created.mode).toBe("created");
    expect(created.contractIndex).toBe(2);
    expect(created.branch).toBe("qinit/main");
    expect(created.warnings).toEqual([
      "contract_main.cpp references Base without INIT_CONTRACT(Base)",
    ]);
    expect(inspectCoreIntegration(outputPath, "Main")).toEqual({
      index: 2,
      assetName: "MAIN",
      constructionEpoch: 300,
      destructionEpoch: 10000,
    });

    const definitionPath = join(outputPath, "src", "contract_core", "contract_def.h");
    const definition = readFileSync(definitionPath, "utf8");
    expect(definition).toContain("#define Main_CONTRACT_INDEX 2");
    expect(definition).toContain(
      "sizeof(Main::StateData) < sizeof(IPO) ? sizeof(IPO) : sizeof(Main::StateData)",
    );
    expect(definition.match(/new contracts should be added above this line/g)).toHaveLength(3);
    expect(readFileSync(definitionPath, "utf8").replaceAll(CRLF, "")).not.toContain("\n");

    const projectFiles = [
      join(outputPath, "src", "Qubic.vcxproj"),
      join(outputPath, "src", "Qubic.vcxproj.filters"),
      join(outputPath, "test", "test.vcxproj"),
      join(outputPath, "test", "test.vcxproj.filters"),
    ];
    for (const projectFile of projectFiles) {
      expectBomAndCrlf(projectFile);
    }
    expect(readFileSync(join(outputPath, "src", "Qubic.vcxproj"), "utf8"))
      .toContain("contracts\\Main.h");
    expect(readFileSync(join(outputPath, "test", "test.vcxproj"), "utf8"))
      .toContain("contract_main.cpp");

    await expect(runCoreIntegration(options)).rejects.toThrow("Core checkout is dirty");

    runGit(outputPath, "add", ".");
    runGit(outputPath, "commit", "-m", "Wire Main");
    writeFileSync(
      join(projectRoot, "contracts", "Main.h"),
      "struct Main { static constexpr unsigned long long MAIN_FEE = 1; " +
        "struct StateData { Base::StateData* base; unsigned long long value; }; };\n",
    );
    const updated = await runCoreIntegration({
      projectRoot,
      contractPath: "contracts/Main.h",
      contractName: "Main",
      outputPath,
      repositoryUrl,
    });

    expect(updated.mode).toBe("updated");
    expect(updated.contractIndex).toBe(2);
    expect(readFileSync(join(outputPath, "src", "contracts", "Main.h"), "utf8"))
      .toContain("unsigned long long value");

    runGit(outputPath, "add", ".");
    runGit(outputPath, "commit", "-m", "Update Main");
    rmSync(join(projectRoot, "tests", "Main.test.cpp"));
    writeFileSync(
      join(projectRoot, "contracts", "Main.h"),
      "struct Main { struct StateData { Base::StateData* base; unsigned long long next; }; };\n",
    );
    await runCoreIntegration({
      projectRoot,
      contractPath: "contracts/Main.h",
      contractName: "Main",
      outputPath,
      repositoryUrl,
    });
    expect(existsSync(join(outputPath, "test", "contract_main.cpp"))).toBe(true);
  });

  test("rejects collisions and unregistered local callees before source writes", async () => {
    const root = temporaryDirectory();
    const repositoryUrl = createCoreRepository(root);
    const projectRoot = createProject(root);
    const outputPath = join(root, "Main-core");
    writeFileSync(
      join(projectRoot, "contracts", "Missing.h"),
      "struct Missing { struct StateData {}; };\n",
    );
    writeFileSync(
      join(projectRoot, "contracts", "Main.h"),
      "struct Main { struct StateData { Missing::StateData* missing; }; };\n",
    );

    await expect(runCoreIntegration({
      projectRoot,
      contractPath: "contracts/Main.h",
      contractName: "Main",
      outputPath,
      assetName: "MAIN",
      constructionEpoch: 300,
      destructionEpoch: 10000,
      repositoryUrl,
    })).rejects.toThrow("callee 'Missing' must already be registered");

    expect(existsSync(join(outputPath, "src", "contracts", "Main.h"))).toBe(false);
    expect(runGit(outputPath, "status", "--porcelain")).toBe("");
    expect(runGit(outputPath, "branch", "--show-current")).toBe("main");

    writeFileSync(
      join(projectRoot, "contracts", "Main.h"),
      "struct Main { struct StateData {}; };\n",
    );
    await expect(runCoreIntegration({
      projectRoot,
      contractPath: "contracts/Main.h",
      contractName: "Main",
      outputPath,
      assetName: "BASE",
      constructionEpoch: 300,
      destructionEpoch: 10000,
      repositoryUrl,
    })).rejects.toThrow("asset 'BASE' is already used");
    expect(runGit(outputPath, "status", "--porcelain")).toBe("");
  });

  test("syncs main before deciding whether registration metadata is needed", async () => {
    const root = temporaryDirectory();
    const repositoryUrl = createCoreRepository(root);
    const projectRoot = createProject(root);
    const staleOutputPath = join(root, "stale-core");
    runGit(root, "clone", repositoryUrl, staleOutputPath);

    const landedOutputPath = join(root, "landed-core");
    await runCoreIntegration({
      projectRoot,
      contractPath: "contracts/Main.h",
      contractName: "Main",
      outputPath: landedOutputPath,
      assetName: "MAIN",
      constructionEpoch: 300,
      repositoryUrl,
    });
    runGit(landedOutputPath, "add", ".");
    runGit(landedOutputPath, "commit", "-m", "Land Main");
    runGit(repositoryUrl, "fetch", landedOutputPath, "qinit/main");
    runGit(repositoryUrl, "merge", "--ff-only", "FETCH_HEAD");

    const updated = await runCoreIntegration({
      projectRoot,
      contractPath: "contracts/Main.h",
      contractName: "Main",
      outputPath: staleOutputPath,
      repositoryUrl,
    });

    expect(updated.mode).toBe("updated");
    expect(updated.contractIndex).toBe(2);
    expect(updated.branch).toBe("qinit/main-update");
  });

  test("rejects asset aliases and partial registration artifacts", async () => {
    const aliasRoot = temporaryDirectory();
    const aliasRepository = createCoreRepository(aliasRoot, "ALIAS");
    const aliasProject = createProject(aliasRoot);

    await expect(runCoreIntegration({
      projectRoot: aliasProject,
      contractPath: "contracts/Main.h",
      contractName: "ALIAS",
      outputPath: join(aliasRoot, "Alias-core"),
      assetName: "NEW",
      constructionEpoch: 300,
      repositoryUrl: aliasRepository,
    })).rejects.toThrow(
      "contract name 'ALIAS' is already used by Base at index 1",
    );

    const partialRoot = temporaryDirectory();
    const partialRepository = createCoreRepository(partialRoot);
    const definitionPath = join(
      partialRepository,
      "src",
      "contract_core",
      "contract_def.h",
    );
    const definition = readFileSync(definitionPath, "utf8");
    const lastMarker = definition.lastIndexOf(
      "// new contracts should be added above this line",
    );
    writeFileSync(
      definitionPath,
      definition.slice(0, lastMarker) +
        "    REGISTER_CONTRACT_FUNCTIONS_AND_PROCEDURES(Main);\r\n" +
        definition.slice(lastMarker),
    );
    runGit(partialRepository, "add", ".");
    runGit(partialRepository, "commit", "-m", "Add partial Main registration");

    const partialProject = createProject(partialRoot);
    const partialOutput = join(partialRoot, "Partial-core");
    await expect(runCoreIntegration({
      projectRoot: partialProject,
      contractPath: "contracts/Main.h",
      contractName: "Main",
      outputPath: partialOutput,
      assetName: "MAIN",
      constructionEpoch: 300,
      repositoryUrl: partialRepository,
    })).rejects.toThrow("contract 'Main' has a partial Core registration");
    expect(existsSync(join(partialOutput, "src", "contracts", "Main.h")))
      .toBe(false);
    expect(runGit(partialOutput, "status", "--porcelain")).toBe("");
  });
});
