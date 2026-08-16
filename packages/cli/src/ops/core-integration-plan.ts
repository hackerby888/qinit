// The pure half of Core integration: given the Core text files and the checkout facts read for it,
// decide which files change and how. No disk reads of its own, so it is testable without a checkout.
import { basename, join } from "node:path";
import { scanCallees, type parseContractDef } from "@qinit/build/contracts/intercontract";

const CONTRACT_MARKER = "// new contracts should be added above this line";

export interface CoreIntegrationRegistration {
    index: number;
    assetName: string;
    constructionEpoch: number;
    destructionEpoch: number;
}

export interface ContractDescription extends CoreIntegrationRegistration {
    stateExpression: string;
}

export interface TextFile {
    bom: boolean;
    eol: "\n" | "\r\n";
    text: string;
}

export interface CoreFiles {
    contractDefinition: TextFile;
    project: TextFile;
    projectFilters: TextFile;
    testProject: TextFile;
    testProjectFilters: TextFile;
}

export interface FileMutation {
    path: string;
    bytes: Uint8Array;
}

export type ContractDefinitions = ReturnType<typeof parseContractDef>;

// The registration fields a new contract needs, after the CLI options and any existing entry are merged.
export type ContractMetadata = Pick<CoreIntegrationRegistration, "assetName" | "constructionEpoch" | "destructionEpoch">;

export function coreFilePaths(corePath: string) {
    return {
        contractDefinition: join(corePath, "src", "contract_core", "contract_def.h"),
        project: join(corePath, "src", "Qubic.vcxproj"),
        projectFilters: join(corePath, "src", "Qubic.vcxproj.filters"),
        testProject: join(corePath, "test", "test.vcxproj"),
        testProjectFilters: join(corePath, "test", "test.vcxproj.filters"),
    };
}

export function encodeTextFile(file: TextFile): Uint8Array {
    const text = file.bom ? `\ufeff${file.text}` : file.text;
    return new TextEncoder().encode(text);
}

export function contractMarkers(source: string): number[] {
    const markers: number[] = [];
    let offset = 0;

    while (true) {
        const index = source.indexOf(CONTRACT_MARKER, offset);
        if (index < 0) {
            return markers;
        }
        markers.push(index);
        offset = index + CONTRACT_MARKER.length;
    }
}

export function descriptions(source: string): ContractDescription[] {
    const markers = contractMarkers(source);
    if (markers.length !== 3) {
        throw new Error(`unsupported contract_def.h: expected 3 contract markers, found ${markers.length}`);
    }

    const descriptionSource = source.slice(markers[0] + CONTRACT_MARKER.length, markers[1]);
    const rows: ContractDescription[] = [];

    for (const line of descriptionSource.split(/\r?\n/)) {
        const match = line.match(/^\s*\{\s*"([^"]*)"\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(.*?)\s*\}\s*,?(?:\s*\/\/.*)?$/);
        if (!match) {
            continue;
        }

        rows.push({
            index: rows.length,
            assetName: match[1],
            constructionEpoch: Number(match[2]),
            destructionEpoch: Number(match[3]),
            stateExpression: match[4],
        });
    }

    return rows;
}

export function registrationCount(source: string, contractName: string): number {
    const escapedName = contractName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [...source.matchAll(new RegExp(`REGISTER_CONTRACT_FUNCTIONS_AND_PROCEDURES\\s*\\(\\s*${escapedName}\\s*\\)`, "g"))].length;
}

export function xmlIncludes(source: string, tag: "ClInclude" | "ClCompile"): string[] {
    return [...source.matchAll(new RegExp(`<${tag}\\s+Include="([^"]+)"`, "g"))].map((match) => match[1]);
}

export function normalizedWindowsPath(path: string): string {
    return path.replaceAll("/", "\\").toLowerCase();
}

export function hasXmlInclude(source: string, tag: "ClInclude" | "ClCompile", include: string): boolean {
    const wanted = normalizedWindowsPath(include);
    return xmlIncludes(source, tag).some((candidate) => normalizedWindowsPath(candidate) === wanted);
}

export function insertAtMarker(source: string, markerNumber: number, block: string, eol: string): string {
    const markers = contractMarkers(source);
    if (markers.length !== 3) {
        throw new Error(`unsupported contract_def.h: expected 3 contract markers, found ${markers.length}`);
    }

    const markerOffset = markers[markerNumber];
    const markerLineOffset = source.lastIndexOf("\n", markerOffset - 1) + 1;
    return source.slice(0, markerLineOffset) + block + eol + source.slice(markerLineOffset);
}

export function addXmlEntry(source: string, tag: "ClInclude" | "ClCompile", entry: string, eol: string): string {
    const groupStart = source.indexOf(`<${tag} `);
    const groupEnd = source.indexOf("  </ItemGroup>", groupStart);
    if (groupStart < 0 || groupEnd < 0) {
        throw new Error(`unsupported Visual Studio project: no ${tag} item group`);
    }

    return source.slice(0, groupEnd) + entry + eol + source.slice(groupEnd);
}

export function scanDependencies(contractSource: string, testSource: string | undefined, contractName: string, knownTypes: Iterable<string>): Set<string> {
    const dependencies = scanCallees(contractSource, { contractName }, knownTypes);

    if (testSource) {
        const testDependencies = scanCallees(testSource, { contractName }, knownTypes);
        for (const dependency of testDependencies) {
            dependencies.add(dependency);
        }
    }

    dependencies.delete(contractName);
    return dependencies;
}

export function assertDependencyOrder(dependencies: Iterable<string>, definitions: ContractDefinitions, contractIndex: number): void {
    for (const dependency of dependencies) {
        const registered = definitions.get(dependency);
        if (!registered) {
            throw new Error(`callee '${dependency}' must already be registered in this Core checkout`);
        }
        if (registered.index >= contractIndex) {
            throw new Error(`callee '${dependency}' must use a lower contract index than ${contractIndex}`);
        }
    }
}

export function calleeDefinitions(definitions: ContractDefinitions, contractDescriptions: readonly ContractDescription[]): ContractDefinitions {
    const callees = new Map(definitions);

    for (const description of contractDescriptions) {
        if (!description.assetName || callees.has(description.assetName)) {
            continue;
        }
        const definition = [...definitions.values()].find((candidate) => candidate.index === description.index);
        if (definition) {
            callees.set(description.assetName, definition);
        }
    }

    return callees;
}

export interface PlanMutationsOptions {
    corePath: string;
    contractPath: string;
    contractName: string;
    contractSource: string;
    testSource?: string;
    existing: (CoreIntegrationRegistration & { include: string }) | null;
    metadata: ContractMetadata;
    files: CoreFiles;
    // The three facts the plan would otherwise read off disk: what the checkout already registers, the
    // project header names that make a bare `X::` reference count as a callee, and whether a path is taken.
    definitions: ContractDefinitions;
    localHeaders: readonly string[];
    fileExists: (path: string) => boolean;
}

export interface MutationPlan {
    mutations: FileMutation[];
    contractIndex: number;
    testPath?: string;
    warnings: string[];
}

export function planMutations(options: PlanMutationsOptions): MutationPlan {
    const { corePath, contractPath, contractName, contractSource, testSource, existing, metadata, files } = options;
    const { definitions, localHeaders, fileExists } = options;
    const indexes = [...definitions.values()].map((definition) => definition.index);
    const highestIndex = Math.max(0, ...indexes);
    const contractIndex = existing?.index ?? highestIndex + 1;
    const sourceFileName = basename(contractPath);
    const include = existing?.include ?? `contracts/${sourceFileName}`;
    const windowsInclude = include.replaceAll("/", "\\");
    const contractDestination = join(corePath, "src", ...include.split("/"));
    const testFileName = `contract_${contractName.toLowerCase()}.cpp`;
    const testDestination = join(corePath, "test", testFileName);
    const definitionDescriptions = descriptions(files.contractDefinition.text);

    if (!existing) {
        const sortedIndexes = [...new Set(indexes)].sort((left, right) => left - right);
        const expectedIndexes = Array.from({ length: highestIndex }, (_, index) => index + 1);
        if (
            sortedIndexes.length !== expectedIndexes.length ||
            sortedIndexes.some((index, offset) => index !== expectedIndexes[offset]) ||
            definitionDescriptions.length !== highestIndex + 1
        ) {
            throw new Error("contract indices are not contiguous; refusing to guess the next slot");
        }

        const escapedContractName = contractName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const contractMacro = new RegExp(`#define\\s+${escapedContractName}_CONTRACT_INDEX\\b`, "i");
        const contractRegistration = new RegExp(`REGISTER_CONTRACT_FUNCTIONS_AND_PROCEDURES\\s*\\(\\s*${escapedContractName}\\s*\\)`, "i");
        if (contractMacro.test(files.contractDefinition.text)) {
            throw new Error(`contract index macro '${contractName}_CONTRACT_INDEX' already exists`);
        }
        if (contractRegistration.test(files.contractDefinition.text)) {
            throw new Error(`contract '${contractName}' has a partial Core registration`);
        }

        const nameAlias = definitionDescriptions.find((description) => description.assetName.toLowerCase() === contractName.toLowerCase());
        if (nameAlias) {
            const stateType = [...definitions.entries()].find(([, definition]) => definition.index === nameAlias.index)?.[0];
            throw new Error(`contract name '${contractName}' is already used by ` + `${stateType ?? "contract"} at index ${nameAlias.index}`);
        }

        const includeCollision = [...definitions.values()].find((definition) => normalizedWindowsPath(definition.include) === normalizedWindowsPath(include));
        if (includeCollision || fileExists(contractDestination)) {
            throw new Error(`Core contract header '${include}' already exists`);
        }
        if (hasXmlInclude(files.project.text, "ClInclude", windowsInclude) || hasXmlInclude(files.projectFilters.text, "ClInclude", windowsInclude)) {
            throw new Error(`Visual Studio already contains '${windowsInclude}'`);
        }

        const assetCollision = definitionDescriptions.find((description) => description.assetName === metadata.assetName);
        if (assetCollision) {
            throw new Error(`asset '${metadata.assetName}' is already used by contract index ${assetCollision.index}`);
        }

        if (
            fileExists(testDestination) ||
            hasXmlInclude(files.testProject.text, "ClCompile", testFileName) ||
            hasXmlInclude(files.testProjectFilters.text, "ClCompile", testFileName)
        ) {
            throw new Error(`Core test '${testFileName}' already exists`);
        }
    }

    const knownCallees = calleeDefinitions(definitions, definitionDescriptions);
    const knownTypes = new Set([...knownCallees.keys(), ...localHeaders]);
    const dependencies = scanDependencies(contractSource, testSource, contractName, knownTypes);
    for (const [reference, definition] of knownCallees) {
        if (definition.index === contractIndex) {
            dependencies.delete(reference);
        }
    }
    assertDependencyOrder(dependencies, knownCallees, contractIndex);

    const warnings: string[] = [];
    if (testSource) {
        for (const dependency of dependencies) {
            const escapedName = dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const initializesDependency = new RegExp(`\\bINIT_CONTRACT\\s*\\(\\s*${escapedName}\\s*\\)`).test(testSource);
            if (!initializesDependency) {
                warnings.push(`${testFileName} references ${dependency} without INIT_CONTRACT(${dependency})`);
            }
        }
    }

    let contractDefinition = files.contractDefinition.text;
    let project = files.project.text;
    let projectFilters = files.projectFilters.text;
    let testProject = files.testProject.text;
    let testProjectFilters = files.testProjectFilters.text;

    if (!existing) {
        const eol = files.contractDefinition.eol;
        const macroName = contractName;
        const stateBlock = [
            "#undef CONTRACT_INDEX",
            "#undef CONTRACT_STATE_TYPE",
            "#undef CONTRACT_STATE2_TYPE",
            "",
            `#define ${macroName}_CONTRACT_INDEX ${contractIndex}`,
            `#define CONTRACT_INDEX ${macroName}_CONTRACT_INDEX`,
            `#define CONTRACT_STATE_TYPE ${contractName}`,
            `#define CONTRACT_STATE2_TYPE ${contractName}2`,
            `#include "${include}"`,
            "",
        ].join(eol);
        contractDefinition = insertAtMarker(contractDefinition, 0, stateBlock, eol);

        const stateSize = `sizeof(${contractName}::StateData) < sizeof(IPO) ` + `? sizeof(IPO) : sizeof(${contractName}::StateData)`;
        const description = `    {"${metadata.assetName}", ${metadata.constructionEpoch}, ` + `${metadata.destructionEpoch}, ${stateSize}},`;
        contractDefinition = insertAtMarker(contractDefinition, 1, description, eol);
        contractDefinition = insertAtMarker(contractDefinition, 2, `    REGISTER_CONTRACT_FUNCTIONS_AND_PROCEDURES(${contractName});`, eol);

        project = addXmlEntry(project, "ClInclude", `    <ClInclude Include="${windowsInclude}" />`, files.project.eol);
        projectFilters = addXmlEntry(
            projectFilters,
            "ClInclude",
            [`    <ClInclude Include="${windowsInclude}">`, "      <Filter>contracts</Filter>", "    </ClInclude>"].join(files.projectFilters.eol),
            files.projectFilters.eol,
        );
    }

    if (testSource && !hasXmlInclude(testProject, "ClCompile", testFileName)) {
        testProject = addXmlEntry(testProject, "ClCompile", `    <ClCompile Include="${testFileName}" />`, files.testProject.eol);
    }
    if (testSource && !hasXmlInclude(testProjectFilters, "ClCompile", testFileName)) {
        testProjectFilters = addXmlEntry(testProjectFilters, "ClCompile", `    <ClCompile Include="${testFileName}" />`, files.testProjectFilters.eol);
    }

    const mutations: FileMutation[] = [
        {
            path: contractDestination,
            bytes: new TextEncoder().encode(contractSource),
        },
    ];
    const paths = coreFilePaths(corePath);
    const changedTextFiles: [string, TextFile, string][] = [
        [paths.contractDefinition, files.contractDefinition, contractDefinition],
        [paths.project, files.project, project],
        [paths.projectFilters, files.projectFilters, projectFilters],
        [paths.testProject, files.testProject, testProject],
        [paths.testProjectFilters, files.testProjectFilters, testProjectFilters],
    ];

    for (const [path, original, text] of changedTextFiles) {
        if (text !== original.text) {
            mutations.push({ path, bytes: encodeTextFile({ ...original, text }) });
        }
    }
    if (testSource) {
        mutations.push({
            path: testDestination,
            bytes: new TextEncoder().encode(testSource),
        });
    }

    return {
        mutations,
        contractIndex,
        testPath: testSource || fileExists(testDestination) ? testDestination : undefined,
        warnings,
    };
}
