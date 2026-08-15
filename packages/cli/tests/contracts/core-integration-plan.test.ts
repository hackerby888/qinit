// planMutations decides the whole Core wiring from in-memory text, so these cases need no checkout,
// no clone and no git — the disk facts it used to read are the three injected inputs.
import { describe, expect, test } from "bun:test";
import { planMutations, type ContractDefinitions, type CoreFiles, type PlanMutationsOptions, type TextFile } from "../../src/ops/core-integration-plan";

const CRLF = "\r\n";

function textFile(lines: string[], bom = false): TextFile {
    return { bom, eol: CRLF, text: `${lines.join(CRLF)}${CRLF}` };
}

function contractDefinition(): TextFile {
    return textFile([
        "#pragma once",
        "",
        "#define BASE_CONTRACT_INDEX 1",
        "#define CONTRACT_INDEX BASE_CONTRACT_INDEX",
        "#define CONTRACT_STATE_TYPE Base",
        '#include "contracts/Base.h"',
        "",
        "// new contracts should be added above this line",
        "",
        "constexpr struct ContractDescription {} contractDescriptions[] = {",
        '    {"", 0, 0, sizeof(int)},',
        '    {"BASE", 1, 10000, sizeof(Base::StateData)},',
        "    // new contracts should be added above this line",
        "};",
        "",
        "static void REGISTER_CONTRACTS() {",
        "    REGISTER_CONTRACT_FUNCTIONS_AND_PROCEDURES(Base);",
        "    // new contracts should be added above this line",
        "}",
    ]);
}

function vcxproj(entries: string[]): TextFile {
    return textFile(["<Project>", "  <ItemGroup>", ...entries, "  </ItemGroup>", "</Project>"]);
}

function coreFiles(): CoreFiles {
    return {
        contractDefinition: contractDefinition(),
        project: vcxproj(['    <ClInclude Include="contracts\\Base.h" />']),
        projectFilters: vcxproj(['    <ClInclude Include="contracts\\Base.h" />']),
        testProject: vcxproj(['    <ClCompile Include="contract_base.cpp" />']),
        testProjectFilters: vcxproj(['    <ClCompile Include="contract_base.cpp" />']),
    };
}

const BASE_DEFINITIONS: ContractDefinitions = new Map([["Base", { type: "Base", index: 1, include: "contracts/Base.h" }]]);

function planOptions(overrides: Partial<PlanMutationsOptions> = {}): PlanMutationsOptions {
    return {
        corePath: "/core",
        contractPath: "/project/contracts/Token.h",
        contractName: "Token",
        contractSource: "struct Token : public ContractBase {};\n",
        existing: null,
        metadata: { assetName: "TOK", constructionEpoch: 200, destructionEpoch: 10_000 },
        files: coreFiles(),
        definitions: BASE_DEFINITIONS,
        localHeaders: [],
        fileExists: () => false,
        ...overrides,
    };
}

// ignoreBOM, because whether the mutation kept the file's BOM is one of the things under test.
const mutationText = (plan: ReturnType<typeof planMutations>, path: string) => {
    const mutation = plan.mutations.find((candidate) => candidate.path === path);
    return mutation ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(mutation.bytes) : undefined;
};

describe("a new contract", () => {
    test("takes the next index and writes the header, definition and both projects", () => {
        const plan = planMutations(planOptions());

        expect(plan.contractIndex).toBe(2);
        expect(plan.warnings).toEqual([]);
        expect(plan.mutations.map((mutation) => mutation.path)).toEqual([
            "/core/src/contracts/Token.h",
            "/core/src/contract_core/contract_def.h",
            "/core/src/Qubic.vcxproj",
            "/core/src/Qubic.vcxproj.filters",
        ]);

        const definition = mutationText(plan, "/core/src/contract_core/contract_def.h")!;
        expect(definition).toContain("#define Token_CONTRACT_INDEX 2");
        expect(definition).toContain('#include "contracts/Token.h"');
        expect(definition).toContain('{"TOK", 200, 10000, sizeof(Token::StateData) < sizeof(IPO) ? sizeof(IPO) : sizeof(Token::StateData)},');
        expect(definition).toContain("REGISTER_CONTRACT_FUNCTIONS_AND_PROCEDURES(Token);");
        expect(mutationText(plan, "/core/src/Qubic.vcxproj")).toContain('<ClInclude Include="contracts\\Token.h" />');
        expect(mutationText(plan, "/core/src/Qubic.vcxproj.filters")).toContain("<Filter>contracts</Filter>");
    });

    test("keeps the line ending and the BOM of every file it rewrites", () => {
        const files = coreFiles();
        files.contractDefinition = { ...files.contractDefinition, bom: true };
        const plan = planMutations(planOptions({ files }));
        const definition = mutationText(plan, "/core/src/contract_core/contract_def.h")!;

        expect(definition.startsWith("﻿")).toBe(true);
        expect(definition).toContain(`#define CONTRACT_STATE_TYPE Token${CRLF}`);
    });

    test("wires the test file when the project has one", () => {
        const plan = planMutations(planOptions({ testSource: "TEST(Token, Works) {}\n" }));

        expect(plan.testPath).toBe("/core/test/contract_token.cpp");
        expect(mutationText(plan, "/core/test/contract_token.cpp")).toContain("TEST(Token, Works)");
        expect(mutationText(plan, "/core/test/test.vcxproj")).toContain('<ClCompile Include="contract_token.cpp" />');
    });

    test("warns when the test calls a dependency it never initializes", () => {
        const contractSource = "struct Token : public ContractBase { CALL_OTHER_CONTRACT_FUNCTION(Base, Get, a, b); };\n";
        const plan = planMutations(planOptions({ contractSource, testSource: "TEST(Token, Works) { Base::Get_input i; }\n" }));

        expect(plan.warnings).toEqual(["contract_token.cpp references Base without INIT_CONTRACT(Base)"]);
    });

    // A bare `X::Member` is only a callee reference once a project header names X — otherwise it reads
    // as a plain qualified type and the plan ignores it.
    test("counts a bare reference as a callee only when a project header names that type", () => {
        const contractSource = "struct Token : public ContractBase { Ghost::Row row; };\n";

        expect(planMutations(planOptions({ contractSource })).contractIndex).toBe(2);
        expect(() => planMutations(planOptions({ contractSource, localHeaders: ["Ghost"] }))).toThrow(/callee 'Ghost' must already be registered/);
    });
});

describe("a rejected contract", () => {
    test("refuses a callee that is not registered", () => {
        const contractSource = "struct Token : public ContractBase { CALL_OTHER_CONTRACT_FUNCTION(Ghost, Get, a, b); };\n";

        expect(() => planMutations(planOptions({ contractSource }))).toThrow(/callee 'Ghost' must already be registered/);
    });

    test("refuses a callee at a higher index", () => {
        const definitions: ContractDefinitions = new Map([...BASE_DEFINITIONS, ["Later", { type: "Later", index: 3, include: "contracts/Later.h" }]]);
        const contractSource = "struct Base : public ContractBase { CALL_OTHER_CONTRACT_FUNCTION(Later, Get, a, b); };\n";
        const options = planOptions({
            contractName: "Base",
            contractPath: "/project/contracts/Base.h",
            contractSource,
            definitions,
            existing: { index: 1, assetName: "BASE", constructionEpoch: 1, destructionEpoch: 10_000, include: "contracts/Base.h" },
            metadata: { assetName: "BASE", constructionEpoch: 1, destructionEpoch: 10_000 },
        });

        expect(() => planMutations(options)).toThrow(/callee 'Later' must use a lower contract index than 1/);
    });

    test("refuses a taken asset name", () => {
        expect(() => planMutations(planOptions({ metadata: { assetName: "BASE", constructionEpoch: 200, destructionEpoch: 10_000 } }))).toThrow(
            /asset 'BASE' is already used by contract index 1/,
        );
    });

    test("refuses a header path that already exists", () => {
        expect(() => planMutations(planOptions({ fileExists: (path) => path === "/core/src/contracts/Token.h" }))).toThrow(
            /Core contract header 'contracts\/Token.h' already exists/,
        );
    });

    test("refuses a gap in the registered indices", () => {
        const definitions: ContractDefinitions = new Map([["Base", { type: "Base", index: 2, include: "contracts/Base.h" }]]);

        expect(() => planMutations(planOptions({ definitions }))).toThrow(/contract indices are not contiguous/);
    });

    test("refuses a name another contract already registers", () => {
        const plan = () =>
            planMutations(planOptions({ contractName: "Base", metadata: { assetName: "TOK", constructionEpoch: 200, destructionEpoch: 10_000 } }));

        expect(plan).toThrow(/contract index macro 'Base_CONTRACT_INDEX' already exists/);
    });
});

describe("an existing contract", () => {
    const existing = { index: 1, assetName: "BASE", constructionEpoch: 1, destructionEpoch: 10_000, include: "contracts/Base.h" };

    test("keeps its index and rewrites only the header", () => {
        const plan = planMutations(
            planOptions({
                contractName: "Base",
                contractPath: "/project/contracts/Base.h",
                contractSource: "struct Base : public ContractBase { int updated; };\n",
                existing,
                metadata: { assetName: "BASE", constructionEpoch: 1, destructionEpoch: 10_000 },
            }),
        );

        expect(plan.contractIndex).toBe(1);
        expect(plan.mutations.map((mutation) => mutation.path)).toEqual(["/core/src/contracts/Base.h"]);
        expect(mutationText(plan, "/core/src/contracts/Base.h")).toContain("int updated;");
    });

    test("reports the test path a checkout already holds", () => {
        const plan = planMutations(
            planOptions({
                contractName: "Base",
                contractPath: "/project/contracts/Base.h",
                existing,
                metadata: { assetName: "BASE", constructionEpoch: 1, destructionEpoch: 10_000 },
                fileExists: (path) => path === "/core/test/contract_base.cpp",
            }),
        );

        expect(plan.testPath).toBe("/core/test/contract_base.cpp");
    });
});
