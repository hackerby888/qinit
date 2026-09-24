import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { VerifyResult } from "@qinit/build";
import { CoreIntegrationMetadataRequiredError, inspectCoreIntegration, runCoreIntegration, type CoreIntegrationOptions, type CoreIntegrationProgress } from "../../src/ops/core-integration";

const temporaryDirectories: string[] = [];

const passingVerifier = async (): Promise<VerifyResult> => ({ available: true, ok: true, oracle: false, errors: [] });

// the real verifier is a download; each test that cares about it passes its own.
function integrate(options: CoreIntegrationOptions) {
    return runCoreIntegration({ verify: passingVerifier, ...options });
}
const CRLF = "\r\n";

function temporaryDirectory(): string {
    const path = mkdtempSync(join(tmpdir(), "qinit-core-integration-test-"));
    temporaryDirectories.push(path);
    return path;
}

// Commits also run in the checkouts the integration clones, which inherit no identity, and CI machines have none either — so every call carries the fixture's.
const GIT_IDENTITY = ["-c", "user.email=qinit@example.test", "-c", "user.name=Qinit Test"];

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
        '#include "contracts/Base.h"',
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
        '    {"", 0, 0, sizeof(int)},',
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
    writeCoreText(join(corePath, "src", "contracts", "Base.h"), ["struct Base { struct StateData {}; };"]);
    writeCoreText(
        join(corePath, "src", "Qubic.vcxproj"),
        [
            '<?xml version="1.0" encoding="utf-8"?>',
            "<Project>",
            "  <ItemGroup>",
            '    <ClInclude Include="contracts\\Base.h" />',
            "  </ItemGroup>",
            "</Project>",
        ],
        true,
    );
    writeCoreText(
        join(corePath, "src", "Qubic.vcxproj.filters"),
        [
            '<?xml version="1.0" encoding="utf-8"?>',
            "<Project>",
            "  <ItemGroup>",
            '    <ClInclude Include="contracts\\Base.h">',
            "      <Filter>contracts</Filter>",
            "    </ClInclude>",
            "  </ItemGroup>",
            "</Project>",
        ],
        true,
    );
    writeCoreText(
        join(corePath, "test", "test.vcxproj"),
        [
            '<?xml version="1.0" encoding="utf-8"?>',
            "<Project>",
            "  <ItemGroup>",
            '    <ClCompile Include="contract_base.cpp" />',
            "  </ItemGroup>",
            "</Project>",
        ],
        true,
    );
    writeCoreText(
        join(corePath, "test", "test.vcxproj.filters"),
        [
            '<?xml version="1.0" encoding="utf-8"?>',
            "<Project>",
            "  <ItemGroup>",
            '    <ClCompile Include="contract_base.cpp" />',
            "  </ItemGroup>",
            "</Project>",
        ],
        true,
    );

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
    writeFileSync(join(projectRoot, "contracts", "Main.h"), "struct Main { struct StateData { Base::StateData* base; }; };\n");
    writeFileSync(join(projectRoot, "tests", "Main.test.cpp"), '#include "contract_testing.h"\nTEST_CONTRACT(Main);\n');
    return projectRoot;
}

function expectBomAndCrlf(path: string): void {
    const bytes = readFileSync(path);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.subarray(3).toString("utf8");
    expect(text).toContain(CRLF);
    expect(text.replaceAll(CRLF, "")).not.toContain("\n");
}

function progressRows(events: CoreIntegrationProgress[]): string[] {
    return events.map((event) => `${event.step}:${event.state}:${event.detail ?? ""}`);
}

function expectTerminalElapsed(events: CoreIntegrationProgress[]): void {
    for (const event of events) {
        if (event.state !== "active") {
            expect(event.elapsedMs).toBeNumber();
            expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
        }
    }
}

afterEach(() => {
    for (const path of temporaryDirectories.splice(0)) {
        // `force` only swallows ENOENT. Windows holds handles on the pack files git just wrote, so removal races it and throws EBUSY — hence the retry.
        rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

        const metadataProgress: CoreIntegrationProgress[] = [];
        await expect(
            integrate({
                ...options,
                requireDestructionEpoch: true,
                onProgress: (event) => metadataProgress.push(event),
            }),
        ).rejects.toBeInstanceOf(CoreIntegrationMetadataRequiredError);
        expect(progressRows(metadataProgress)).toEqual([
            "contract:active:Main.h",
            "contract:ok:Main.h",
            "checkout:active:cloning main",
            "checkout:ok:cloned main",
            "wire:active:checking registration",
        ]);
        expectTerminalElapsed(metadataProgress);
        expect(runGit(outputPath, "branch", "--show-current")).toBe("main");
        expect(runGit(outputPath, "status", "--porcelain")).toBe("");

        const createProgress: CoreIntegrationProgress[] = [];
        const created = await integrate({
            ...options,
            onProgress: (event) => createProgress.push(event),
        });

        expect(created.mode).toBe("created");
        expect(created.contractIndex).toBe(2);
        expect(created.branch).toBe("qinit/main");
        expect(created.warnings).toEqual(["contract_main.cpp references Base without INIT_CONTRACT(Base)"]);
        expect(inspectCoreIntegration(outputPath, "Main")).toEqual({
            index: 2,
            assetName: "MAIN",
            constructionEpoch: 300,
            destructionEpoch: 10000,
        });
        expect(progressRows(createProgress)).toEqual([
            "contract:active:Main.h",
            "contract:ok:Main.h",
            "checkout:active:checking checkout",
            "checkout:active:updating main",
            "checkout:ok:updated main",
            "wire:active:checking registration",
            "wire:active:creating qinit/main",
            "wire:ok:created index 2",
        ]);
        expectTerminalElapsed(createProgress);

        const definitionPath = join(outputPath, "src", "contract_core", "contract_def.h");
        const definition = readFileSync(definitionPath, "utf8");
        expect(definition).toContain("#define Main_CONTRACT_INDEX 2");
        expect(definition).toContain("sizeof(Main::StateData) < sizeof(IPO) ? sizeof(IPO) : sizeof(Main::StateData)");
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
        expect(readFileSync(join(outputPath, "src", "Qubic.vcxproj"), "utf8")).toContain("contracts\\Main.h");
        expect(readFileSync(join(outputPath, "test", "test.vcxproj"), "utf8")).toContain("contract_main.cpp");

        const dirtyProgress: CoreIntegrationProgress[] = [];
        await expect(
            integrate({
                ...options,
                onProgress: (event) => dirtyProgress.push(event),
            }),
        ).rejects.toThrow("Core checkout is dirty");
        expect(progressRows(dirtyProgress).at(-1)).toBe("checkout:fail:checking checkout");
        expectTerminalElapsed(dirtyProgress);

        runGit(outputPath, "add", ".");
        runGit(outputPath, "commit", "-m", "Wire Main");
        writeFileSync(
            join(projectRoot, "contracts", "Main.h"),
            "struct Main { static constexpr unsigned long long MAIN_FEE = 1; " + "struct StateData { Base::StateData* base; unsigned long long value; }; };\n",
        );
        const updateProgress: CoreIntegrationProgress[] = [];
        const updated = await integrate({
            projectRoot,
            contractPath: "contracts/Main.h",
            contractName: "Main",
            outputPath,
            repositoryUrl,
            onProgress: (event) => updateProgress.push(event),
        });

        expect(updated.mode).toBe("updated");
        expect(updated.contractIndex).toBe(2);
        expect(progressRows(updateProgress)).toContain("checkout:active:using qinit/main");
        expect(progressRows(updateProgress)).toContain("checkout:ok:using qinit/main");
        expect(progressRows(updateProgress).at(-1)).toBe("wire:ok:updated index 2");
        expectTerminalElapsed(updateProgress);
        expect(readFileSync(join(outputPath, "src", "contracts", "Main.h"), "utf8")).toContain("unsigned long long value");

        runGit(outputPath, "add", ".");
        runGit(outputPath, "commit", "-m", "Update Main");
        rmSync(join(projectRoot, "tests", "Main.test.cpp"));
        writeFileSync(join(projectRoot, "contracts", "Main.h"), "struct Main { struct StateData { Base::StateData* base; unsigned long long next; }; };\n");
        await integrate({
            projectRoot,
            contractPath: "contracts/Main.h",
            contractName: "Main",
            outputPath,
            repositoryUrl,
        });
        expect(existsSync(join(outputPath, "test", "contract_main.cpp"))).toBe(true);
    }, 60000);

    test("rejects collisions and unregistered local callees before source writes", async () => {
        const root = temporaryDirectory();
        const repositoryUrl = createCoreRepository(root);
        const projectRoot = createProject(root);
        const outputPath = join(root, "Main-core");
        writeFileSync(join(projectRoot, "contracts", "Missing.h"), "struct Missing { struct StateData {}; };\n");
        writeFileSync(join(projectRoot, "contracts", "Main.h"), "struct Main { struct StateData { Missing::StateData* missing; }; };\n");

        const failureProgress: CoreIntegrationProgress[] = [];
        await expect(
            integrate({
                projectRoot,
                contractPath: "contracts/Main.h",
                contractName: "Main",
                outputPath,
                assetName: "MAIN",
                constructionEpoch: 300,
                destructionEpoch: 10000,
                repositoryUrl,
                onProgress: (event) => failureProgress.push(event),
            }),
        ).rejects.toThrow("callee 'Missing' must already be registered");
        expect(progressRows(failureProgress).at(-1)).toBe("wire:fail:checking registration");
        expectTerminalElapsed(failureProgress);

        expect(existsSync(join(outputPath, "src", "contracts", "Main.h"))).toBe(false);
        expect(runGit(outputPath, "status", "--porcelain")).toBe("");
        expect(runGit(outputPath, "branch", "--show-current")).toBe("main");

        writeFileSync(join(projectRoot, "contracts", "Main.h"), "struct Main { struct StateData {}; };\n");
        await expect(
            integrate({
                projectRoot,
                contractPath: "contracts/Main.h",
                contractName: "Main",
                outputPath,
                assetName: "BASE",
                constructionEpoch: 300,
                destructionEpoch: 10000,
                repositoryUrl,
            }),
        ).rejects.toThrow("asset 'BASE' is already used");
        expect(runGit(outputPath, "status", "--porcelain")).toBe("");
    }, 60000);

    test("syncs main before deciding whether registration metadata is needed", async () => {
        const root = temporaryDirectory();
        const repositoryUrl = createCoreRepository(root);
        const projectRoot = createProject(root);
        const staleOutputPath = join(root, "stale-core");
        runGit(root, "clone", repositoryUrl, staleOutputPath);

        const landedOutputPath = join(root, "landed-core");
        await integrate({
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

        const updateProgress: CoreIntegrationProgress[] = [];
        const updated = await integrate({
            projectRoot,
            contractPath: "contracts/Main.h",
            contractName: "Main",
            outputPath: staleOutputPath,
            repositoryUrl,
            onProgress: (event) => updateProgress.push(event),
        });

        expect(updated.mode).toBe("updated");
        expect(updated.contractIndex).toBe(2);
        expect(updated.branch).toBe("qinit/main-update");
        expect(progressRows(updateProgress)).toContain("checkout:active:updating main");
        expect(progressRows(updateProgress)).toContain("checkout:ok:updated main");
        expect(progressRows(updateProgress)).toContain("wire:active:creating qinit/main-update");
        expect(progressRows(updateProgress).at(-1)).toBe("wire:ok:updated index 2");
        expectTerminalElapsed(updateProgress);
    }, 60000);

    // integrate is the only hand-off to a Core checkout, so the one place a cheatcode must not survive. These go through the real integration, not the strip.
    test("strips cheatcodes out of the source it writes into Core", async () => {
        const root = temporaryDirectory();
        const repositoryUrl = createCoreRepository(root);
        const projectRoot = createProject(root);
        const contractPath = join(projectRoot, "contracts", "Main.h");

        writeFileSync(
            contractPath,
            'struct Main { struct StateData { Base::StateData* base; }; };\nPUBLIC_PROCEDURE(P)\n{\n    CC_PRINT("here", input.n);\n    state.mut().n += 1;\n}\n',
        );

        const result = await integrate({
            projectRoot,
            contractPath: "contracts/Main.h",
            contractName: "Main",
            outputPath: join(root, "Main-core"),
            assetName: "MAIN",
            constructionEpoch: 300,
            destructionEpoch: 10000,
            repositoryUrl,
        });

        const written = readFileSync(join(result.corePath, "src", "contracts", "Main.h"), "utf8");

        expect(written).not.toMatch(/CC_/);
        // The statement is blanked in place rather than deleted, so every following line keeps its number and a Core stack trace still points where expected.
        expect(written).toContain("state.mut().n += 1;");
        expect(written.replaceAll(CRLF, "\n").split("\n").length).toBe(readFileSync(contractPath, "utf8").split("\n").length);
    }, 60000);

    test("refuses a cheatcode it cannot strip safely rather than writing it to Core", async () => {
        const root = temporaryDirectory();
        const repositoryUrl = createCoreRepository(root);
        const projectRoot = createProject(root);

        // An expression-position cheat cannot be blanked without changing the statement around it.
        writeFileSync(
            join(projectRoot, "contracts", "Main.h"),
            "struct Main { struct StateData { Base::StateData* base; }; };\nPUBLIC_PROCEDURE(P)\n{\n    x = CC_PRINT(1);\n}\n",
        );

        await expect(
            integrate({
                projectRoot,
                contractPath: "contracts/Main.h",
                contractName: "Main",
                outputPath: join(root, "Main-core"),
                assetName: "MAIN",
                constructionEpoch: 300,
                destructionEpoch: 10000,
                repositoryUrl,
            }),
        ).rejects.toThrow(/cheatcode violations/);
    }, 60000);

    test("rejects asset aliases and partial registration artifacts", async () => {
        const aliasRoot = temporaryDirectory();
        const aliasRepository = createCoreRepository(aliasRoot, "ALIAS");
        const aliasProject = createProject(aliasRoot);

        await expect(
            integrate({
                projectRoot: aliasProject,
                contractPath: "contracts/Main.h",
                contractName: "ALIAS",
                outputPath: join(aliasRoot, "Alias-core"),
                assetName: "NEW",
                constructionEpoch: 300,
                repositoryUrl: aliasRepository,
            }),
        ).rejects.toThrow("contract name 'ALIAS' is already used by Base at index 1");

        const partialRoot = temporaryDirectory();
        const partialRepository = createCoreRepository(partialRoot);
        const definitionPath = join(partialRepository, "src", "contract_core", "contract_def.h");
        const definition = readFileSync(definitionPath, "utf8");
        const lastMarker = definition.lastIndexOf("// new contracts should be added above this line");
        writeFileSync(
            definitionPath,
            definition.slice(0, lastMarker) + "    REGISTER_CONTRACT_FUNCTIONS_AND_PROCEDURES(Main);\r\n" + definition.slice(lastMarker),
        );
        runGit(partialRepository, "add", ".");
        runGit(partialRepository, "commit", "-m", "Add partial Main registration");

        const partialProject = createProject(partialRoot);
        const partialOutput = join(partialRoot, "Partial-core");
        await expect(
            integrate({
                projectRoot: partialProject,
                contractPath: "contracts/Main.h",
                contractName: "Main",
                outputPath: partialOutput,
                assetName: "MAIN",
                constructionEpoch: 300,
                repositoryUrl: partialRepository,
            }),
        ).rejects.toThrow("contract 'Main' has a partial Core registration");
        expect(existsSync(join(partialOutput, "src", "contracts", "Main.h"))).toBe(false);
        expect(runGit(partialOutput, "status", "--porcelain")).toBe("");
    }, 60000);
});

describe("build rules at the Core hand-off", () => {
    test("refuses a bare div before any checkout is created", async () => {
        const root = temporaryDirectory();
        const repositoryUrl = createCoreRepository(root);
        const projectRoot = createProject(root);
        const outputPath = join(root, "Main-core");

        writeFileSync(
            join(projectRoot, "contracts", "Main.h"),
            "struct Main { struct StateData { Base::StateData* base; }; };\nPUBLIC_PROCEDURE(P)\n{\n    state.mut().n = div(input.a, input.b);\n}\n",
        );

        await expect(
            integrate({
                projectRoot,
                contractPath: "contracts/Main.h",
                contractName: "Main",
                outputPath,
                assetName: "MAIN",
                constructionEpoch: 300,
                destructionEpoch: 10000,
                repositoryUrl,
            }),
        ).rejects.toThrow(/build rule violations in Main\.h:\n {2}line 4: .*QPI::div/);
        expect(existsSync(outputPath)).toBe(false);
    }, 60000);

    test("--no-build-rules lets the same contract through", async () => {
        const root = temporaryDirectory();
        const repositoryUrl = createCoreRepository(root);
        const projectRoot = createProject(root);

        writeFileSync(
            join(projectRoot, "contracts", "Main.h"),
            "struct Main { struct StateData { Base::StateData* base; }; };\nPUBLIC_PROCEDURE(P)\n{\n    state.mut().n = div(input.a, input.b);\n}\n",
        );

        const result = await integrate({
            projectRoot,
            contractPath: "contracts/Main.h",
            contractName: "Main",
            outputPath: join(root, "Main-core"),
            assetName: "MAIN",
            constructionEpoch: 300,
            destructionEpoch: 10000,
            repositoryUrl,
            buildRules: false,
        });

        expect(readFileSync(join(result.corePath, "src", "contracts", "Main.h"), "utf8")).toContain("div(input.a, input.b)");
    }, 60000);
});

describe("checks at the Core hand-off", () => {
    function newIntegration(root: string) {
        const projectRoot = createProject(root);
        const outputPath = join(root, "Main-core");
        return { projectRoot, outputPath, contractPath: "contracts/Main.h", contractName: "Main", assetName: "MAIN", constructionEpoch: 300 };
    }

    test("refuses a contractverify rejection or a missing verifier before cloning", async () => {
        const root = temporaryDirectory();
        const options = { ...newIntegration(root), repositoryUrl: createCoreRepository(root) };
        writeFileSync(
            join(options.projectRoot, "contracts", "Main.h"),
            "struct Main : public ContractBase\n{\n    struct StateData { Base::StateData* base; };\n    struct Ping_input {};\n    struct Ping_output {};\n    struct Ping_locals { Base::Get_input i; Base::Get_output o; };\n    PUBLIC_PROCEDURE_WITH_LOCALS(Ping)\n    {\n        CALL_OTHER_CONTRACT_FUNCTION(Base, Get, locals.i, locals.o);\n    }\n    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()\n    {\n        REGISTER_USER_PROCEDURE(Ping, 1);\n    }\n};\n",
        );

        const calls: unknown[][] = [];
        const rejecting = async (...args: unknown[]): Promise<VerifyResult> => {
            calls.push(args);
            return { available: true, ok: false, oracle: false, errors: ["Main.h:3: global variable x"] };
        };
        await expect(integrate({ ...options, verify: rejecting })).rejects.toThrow("global variable x");
        // callees may prefix globals, so the verifier gets them as allowed prefixes.
        expect(calls).toEqual([[join(options.projectRoot, "contracts", "Main.h"), "Main", ["Base"]]]);

        const missing = async (): Promise<VerifyResult> => ({ available: false, ok: true, oracle: false, errors: [] });
        await expect(integrate({ ...options, verify: missing })).rejects.toThrow("contractverify is not installed; run `qinit setup`");
        expect(existsSync(options.outputPath)).toBe(false);
    }, 60000);

    test("warns on build-gate findings, a missing GTest, and a Core declaration of the name", async () => {
        const root = temporaryDirectory();
        const repositoryUrl = createCoreRepository(root);
        const corePath = join(root, "core-source");
        mkdirSync(join(corePath, "src", "qpi"), { recursive: true });
        // only the namespace-scope declaration clashes; the nested one and the comment do not.
        writeCoreText(join(corePath, "src", "qpi", "qpi_types.h"), [
            "namespace QPI",
            "{",
            "\tstruct Main2;",
            "\tstruct Stats",
            "\t{",
            "\t\tstruct Main { int n; };",
            "\t};",
            "\t// struct Main is taken",
            "}",
        ]);
        runGit(corePath, "add", ".");
        runGit(corePath, "commit", "-m", "Add qpi types");

        const options = { ...newIntegration(root), repositoryUrl };
        rmSync(join(options.projectRoot, "tests", "Main.test.cpp"));
        writeFileSync(
            join(options.projectRoot, "contracts", "Main.h"),
            "struct Main : public ContractBase\n{\n    struct StateData { Base::StateData* base; };\n    struct Ping_input {};\n    struct Ping_output {};\n    PUBLIC_PROCEDURE(Ping)\n    {\n    }\n};\n",
        );

        const result = await integrate(options);
        expect(result.warnings).toEqual([
            "line 6: `Ping` is defined but never registered — add REGISTER_USER_PROCEDURE(Ping, <index>) so it's callable on-chain.",
            "Core already declares Main2 at src/qpi/qpi_types.h:3; the Windows build may fail on the clash",
            "no tests/Main.test.cpp: Core gets Main without a GTest",
        ]);
    }, 60000);
});
