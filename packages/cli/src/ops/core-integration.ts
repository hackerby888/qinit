import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  parseContractDef,
  scanCallees,
} from "@qinit/build/intercontract";

const CORE_REPOSITORY_URL = "https://github.com/qubic/core.git";
const CONTRACT_MARKER = "// new contracts should be added above this line";

export interface CoreIntegrationOptions {
  projectRoot: string;
  contractPath: string;
  contractName: string;
  outputPath: string;
  assetName?: string;
  constructionEpoch?: number;
  destructionEpoch?: number;
  requireDestructionEpoch?: boolean;
  repositoryUrl?: string;
}

export interface CoreIntegrationRegistration {
  index: number;
  assetName: string;
  constructionEpoch: number;
  destructionEpoch: number;
}

export interface CoreIntegrationResult {
  corePath: string;
  branch: string;
  contractIndex: number;
  mode: "created" | "updated";
  testPath?: string;
  warnings: string[];
}

export class CoreIntegrationMetadataRequiredError extends Error {
  constructor() {
    super("new Core integration requires --asset and --construction-epoch");
    this.name = "CoreIntegrationMetadataRequiredError";
  }
}

interface TextFile {
  bom: boolean;
  eol: "\n" | "\r\n";
  text: string;
}

interface ContractDescription extends CoreIntegrationRegistration {
  stateExpression: string;
}

interface CoreFiles {
  contractDefinition: TextFile;
  project: TextFile;
  projectFilters: TextFile;
  testProject: TextFile;
  testProjectFilters: TextFile;
}

interface FileMutation {
  path: string;
  bytes: Uint8Array;
}

function coreFilePaths(corePath: string) {
  return {
    contractDefinition: join(corePath, "src", "contract_core", "contract_def.h"),
    project: join(corePath, "src", "Qubic.vcxproj"),
    projectFilters: join(corePath, "src", "Qubic.vcxproj.filters"),
    testProject: join(corePath, "test", "test.vcxproj"),
    testProjectFilters: join(corePath, "test", "test.vcxproj.filters"),
  };
}

function readTextFile(path: string): TextFile {
  const bytes = readFileSync(path);
  const bom =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf;
  const text = bytes.subarray(bom ? 3 : 0).toString("utf8");

  return {
    bom,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    text,
  };
}

function encodeTextFile(file: TextFile): Uint8Array {
  const text = file.bom ? `\ufeff${file.text}` : file.text;
  return new TextEncoder().encode(text);
}

function loadCoreFiles(corePath: string): CoreFiles {
  const paths = coreFilePaths(corePath);

  for (const path of Object.values(paths)) {
    if (!existsSync(path)) {
      throw new Error(`not a supported qubic/core checkout: missing ${path}`);
    }
  }

  return {
    contractDefinition: readTextFile(paths.contractDefinition),
    project: readTextFile(paths.project),
    projectFilters: readTextFile(paths.projectFilters),
    testProject: readTextFile(paths.testProject),
    testProjectFilters: readTextFile(paths.testProjectFilters),
  };
}

function contractMarkers(source: string): number[] {
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

function descriptions(source: string): ContractDescription[] {
  const markers = contractMarkers(source);
  if (markers.length !== 3) {
    throw new Error(
      `unsupported contract_def.h: expected 3 contract markers, found ${markers.length}`,
    );
  }

  const descriptionSource = source.slice(
    markers[0] + CONTRACT_MARKER.length,
    markers[1],
  );
  const rows: ContractDescription[] = [];

  for (const line of descriptionSource.split(/\r?\n/)) {
    const match = line.match(
      /^\s*\{\s*"([^"]*)"\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(.*?)\s*\}\s*,?(?:\s*\/\/.*)?$/,
    );
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

function registrationCount(source: string, contractName: string): number {
  const escapedName = contractName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...source.matchAll(
    new RegExp(
      `REGISTER_CONTRACT_FUNCTIONS_AND_PROCEDURES\\s*\\(\\s*${escapedName}\\s*\\)`,
      "g",
    ),
  )].length;
}

function xmlIncludes(source: string, tag: "ClInclude" | "ClCompile"): string[] {
  return [...source.matchAll(new RegExp(`<${tag}\\s+Include="([^"]+)"`, "g"))]
    .map((match) => match[1]);
}

function normalizedWindowsPath(path: string): string {
  return path.replaceAll("/", "\\").toLowerCase();
}

function hasXmlInclude(
  source: string,
  tag: "ClInclude" | "ClCompile",
  include: string,
): boolean {
  const wanted = normalizedWindowsPath(include);
  return xmlIncludes(source, tag)
    .some((candidate) => normalizedWindowsPath(candidate) === wanted);
}

function findRegistration(
  corePath: string,
  contractName: string,
  files: CoreFiles,
): (CoreIntegrationRegistration & { include: string }) | null {
  const definitions = parseContractDef(corePath);
  const caseInsensitiveMatch = [...definitions.entries()].find(
    ([stateType]) => stateType.toLowerCase() === contractName.toLowerCase(),
  );

  if (!caseInsensitiveMatch) {
    return null;
  }
  if (caseInsensitiveMatch[0] !== contractName) {
    throw new Error(
      `contract name '${contractName}' collides with registered '${caseInsensitiveMatch[0]}'`,
    );
  }

  const definition = caseInsensitiveMatch[1];
  const description = descriptions(files.contractDefinition.text)[definition.index];
  const registered = registrationCount(files.contractDefinition.text, contractName);
  const projectInclude = definition.include.replaceAll("/", "\\");

  if (
    !description ||
    registered !== 1 ||
    !hasXmlInclude(files.project.text, "ClInclude", projectInclude) ||
    !hasXmlInclude(files.projectFilters.text, "ClInclude", projectInclude)
  ) {
    throw new Error(
      `contract '${contractName}' is only partially registered in this Core checkout`,
    );
  }

  return {
    index: definition.index,
    assetName: description.assetName,
    constructionEpoch: description.constructionEpoch,
    destructionEpoch: description.destructionEpoch,
    include: definition.include,
  };
}

export function inspectCoreIntegration(
  corePath: string,
  contractName: string,
): CoreIntegrationRegistration | null {
  const resolvedCorePath = resolve(corePath);
  const files = loadCoreFiles(resolvedCorePath);
  const registration = findRegistration(
    resolvedCorePath,
    contractName,
    files,
  );

  if (!registration) {
    return null;
  }

  return {
    index: registration.index,
    assetName: registration.assetName,
    constructionEpoch: registration.constructionEpoch,
    destructionEpoch: registration.destructionEpoch,
  };
}

function validateContractName(contractName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(contractName)) {
    throw new Error(`invalid contract name '${contractName}'`);
  }
}

function validateMetadata(
  options: CoreIntegrationOptions,
  existing: CoreIntegrationRegistration | null,
): void {
  const metadata = {
    assetName: options.assetName ?? existing?.assetName,
    constructionEpoch: options.constructionEpoch ?? existing?.constructionEpoch,
    destructionEpoch:
      options.destructionEpoch ??
      existing?.destructionEpoch ??
      (options.requireDestructionEpoch ? undefined : 10_000),
  };

  if (
    metadata.assetName === undefined ||
    metadata.constructionEpoch === undefined ||
    metadata.destructionEpoch === undefined
  ) {
    throw new CoreIntegrationMetadataRequiredError();
  }
  if (!/^[A-Z][A-Z0-9]{0,6}$/.test(metadata.assetName)) {
    throw new Error(
      "asset must be 1-7 uppercase letters or digits and start with a letter",
    );
  }
  if (
    !Number.isInteger(metadata.constructionEpoch) ||
    metadata.constructionEpoch < 1 ||
    metadata.constructionEpoch > 65_535
  ) {
    throw new Error("construction epoch must be an integer from 1 to 65535");
  }
  if (
    !Number.isInteger(metadata.destructionEpoch) ||
    metadata.destructionEpoch <= metadata.constructionEpoch ||
    metadata.destructionEpoch > 65_535
  ) {
    throw new Error(
      "destruction epoch must be an integer after construction and at most 65535",
    );
  }

  if (!existing) {
    return;
  }

  for (const key of [
    "assetName",
    "constructionEpoch",
    "destructionEpoch",
  ] as const) {
    const supplied = options[key];
    if (supplied !== undefined && supplied !== existing[key]) {
      throw new Error(
        `${key} does not match the registered value '${existing[key]}'`,
      );
    }
  }
}

async function runGit(
  args: string[],
  cwd?: string,
  allowFailure = false,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (exitCode !== 0 && !allowFailure) {
    const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }

  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function requireCleanCheckout(corePath: string): Promise<void> {
  const status = await runGit(["status", "--porcelain"], corePath);
  if (status.stdout) {
    throw new Error(`Core checkout is dirty: ${corePath}`);
  }
}

async function branchExists(corePath: string, branch: string): Promise<boolean> {
  const result = await runGit(
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    corePath,
    true,
  );
  return result.exitCode === 0;
}

function resolveFromProject(projectRoot: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
}

function localHeaderNames(projectRoot: string, contractPath: string): string[] {
  const directories = new Set([
    join(projectRoot, "contracts"),
    resolve(contractPath, ".."),
  ]);
  const names = new Set<string>();

  for (const directory of directories) {
    if (!existsSync(directory)) {
      continue;
    }

    const pendingDirectories = [directory];
    while (pendingDirectories.length > 0) {
      const currentDirectory = pendingDirectories.pop()!;
      for (const entry of readdirSync(currentDirectory, {
        withFileTypes: true,
      })) {
        if (entry.isDirectory()) {
          pendingDirectories.push(join(currentDirectory, entry.name));
        } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".h") {
          names.add(basename(entry.name, extname(entry.name)));
        }
      }
    }
  }

  return [...names];
}

function scanDependencies(
  contractSource: string,
  testSource: string | undefined,
  contractName: string,
  knownTypes: Iterable<string>,
): Set<string> {
  const dependencies = scanCallees(
    contractSource,
    { contractName },
    knownTypes,
  );

  if (testSource) {
    const testDependencies = scanCallees(
      testSource,
      { contractName },
      knownTypes,
    );
    for (const dependency of testDependencies) {
      dependencies.add(dependency);
    }
  }

  dependencies.delete(contractName);
  return dependencies;
}

function assertDependencyOrder(
  dependencies: Iterable<string>,
  definitions: ReturnType<typeof parseContractDef>,
  contractIndex: number,
): void {
  for (const dependency of dependencies) {
    const registered = definitions.get(dependency);
    if (!registered) {
      throw new Error(
        `callee '${dependency}' must already be registered in this Core checkout`,
      );
    }
    if (registered.index >= contractIndex) {
      throw new Error(
        `callee '${dependency}' must use a lower contract index than ${contractIndex}`,
      );
    }
  }
}

function calleeDefinitions(
  definitions: ReturnType<typeof parseContractDef>,
  contractDescriptions: readonly ContractDescription[],
): ReturnType<typeof parseContractDef> {
  const callees = new Map(definitions);

  for (const description of contractDescriptions) {
    if (!description.assetName || callees.has(description.assetName)) {
      continue;
    }
    const definition = [...definitions.values()].find(
      (candidate) => candidate.index === description.index,
    );
    if (definition) {
      callees.set(description.assetName, definition);
    }
  }

  return callees;
}

function insertAtMarker(
  source: string,
  markerNumber: number,
  block: string,
  eol: string,
): string {
  const markers = contractMarkers(source);
  if (markers.length !== 3) {
    throw new Error(
      `unsupported contract_def.h: expected 3 contract markers, found ${markers.length}`,
    );
  }

  const markerOffset = markers[markerNumber];
  const markerLineOffset = source.lastIndexOf("\n", markerOffset - 1) + 1;
  return source.slice(0, markerLineOffset) + block + eol + source.slice(markerLineOffset);
}

function addXmlEntry(
  source: string,
  tag: "ClInclude" | "ClCompile",
  entry: string,
  eol: string,
): string {
  const groupStart = source.indexOf(`<${tag} `);
  const groupEnd = source.indexOf("  </ItemGroup>", groupStart);
  if (groupStart < 0 || groupEnd < 0) {
    throw new Error(`unsupported Visual Studio project: no ${tag} item group`);
  }

  return source.slice(0, groupEnd) + entry + eol + source.slice(groupEnd);
}

function metadataFor(
  options: CoreIntegrationOptions,
  existing: CoreIntegrationRegistration | null,
): Required<Pick<
  CoreIntegrationOptions,
  "assetName" | "constructionEpoch" | "destructionEpoch"
>> {
  return {
    assetName: options.assetName ?? existing!.assetName,
    constructionEpoch: options.constructionEpoch ?? existing!.constructionEpoch,
    destructionEpoch:
      options.destructionEpoch ?? existing?.destructionEpoch ?? 10_000,
  };
}

function planMutations(options: {
  corePath: string;
  projectRoot: string;
  contractPath: string;
  contractName: string;
  contractSource: string;
  testSource?: string;
  existing: (CoreIntegrationRegistration & { include: string }) | null;
  metadata: ReturnType<typeof metadataFor>;
  files: CoreFiles;
}): {
  mutations: FileMutation[];
  contractIndex: number;
  testPath?: string;
  warnings: string[];
} {
  const {
    corePath,
    projectRoot,
    contractPath,
    contractName,
    contractSource,
    testSource,
    existing,
    metadata,
    files,
  } = options;
  const definitions = parseContractDef(corePath);
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
    const expectedIndexes = Array.from(
      { length: highestIndex },
      (_, index) => index + 1,
    );
    if (
      sortedIndexes.length !== expectedIndexes.length ||
      sortedIndexes.some((index, offset) => index !== expectedIndexes[offset]) ||
      definitionDescriptions.length !== highestIndex + 1
    ) {
      throw new Error(
        "contract indices are not contiguous; refusing to guess the next slot",
      );
    }

    const escapedContractName = contractName.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const contractMacro = new RegExp(
      `#define\\s+${escapedContractName}_CONTRACT_INDEX\\b`,
      "i",
    );
    const contractRegistration = new RegExp(
      `REGISTER_CONTRACT_FUNCTIONS_AND_PROCEDURES\\s*\\(\\s*${escapedContractName}\\s*\\)`,
      "i",
    );
    if (contractMacro.test(files.contractDefinition.text)) {
      throw new Error(
        `contract index macro '${contractName}_CONTRACT_INDEX' already exists`,
      );
    }
    if (contractRegistration.test(files.contractDefinition.text)) {
      throw new Error(
        `contract '${contractName}' has a partial Core registration`,
      );
    }

    const nameAlias = definitionDescriptions.find(
      (description) =>
        description.assetName.toLowerCase() === contractName.toLowerCase(),
    );
    if (nameAlias) {
      const stateType = [...definitions.entries()].find(
        ([, definition]) => definition.index === nameAlias.index,
      )?.[0];
      throw new Error(
        `contract name '${contractName}' is already used by ` +
          `${stateType ?? "contract"} at index ${nameAlias.index}`,
      );
    }

    const includeCollision = [...definitions.values()].find(
      (definition) =>
        normalizedWindowsPath(definition.include) === normalizedWindowsPath(include),
    );
    if (includeCollision || existsSync(contractDestination)) {
      throw new Error(`Core contract header '${include}' already exists`);
    }
    if (
      hasXmlInclude(files.project.text, "ClInclude", windowsInclude) ||
      hasXmlInclude(files.projectFilters.text, "ClInclude", windowsInclude)
    ) {
      throw new Error(`Visual Studio already contains '${windowsInclude}'`);
    }

    const assetCollision = definitionDescriptions.find(
      (description) => description.assetName === metadata.assetName,
    );
    if (assetCollision) {
      throw new Error(
        `asset '${metadata.assetName}' is already used by contract index ${assetCollision.index}`,
      );
    }

    if (
      existsSync(testDestination) ||
      hasXmlInclude(files.testProject.text, "ClCompile", testFileName) ||
      hasXmlInclude(files.testProjectFilters.text, "ClCompile", testFileName)
    ) {
      throw new Error(`Core test '${testFileName}' already exists`);
    }
  }

  const knownCallees = calleeDefinitions(definitions, definitionDescriptions);
  const knownTypes = new Set([
    ...knownCallees.keys(),
    ...localHeaderNames(projectRoot, contractPath),
  ]);
  const dependencies = scanDependencies(
    contractSource,
    testSource,
    contractName,
    knownTypes,
  );
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
      const initializesDependency = new RegExp(
        `\\bINIT_CONTRACT\\s*\\(\\s*${escapedName}\\s*\\)`,
      ).test(testSource);
      if (!initializesDependency) {
        warnings.push(
          `${testFileName} references ${dependency} without INIT_CONTRACT(${dependency})`,
        );
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

    const stateSize =
      `sizeof(${contractName}::StateData) < sizeof(IPO) ` +
      `? sizeof(IPO) : sizeof(${contractName}::StateData)`;
    const description =
      `    {"${metadata.assetName}", ${metadata.constructionEpoch}, ` +
      `${metadata.destructionEpoch}, ${stateSize}},`;
    contractDefinition = insertAtMarker(
      contractDefinition,
      1,
      description,
      eol,
    );
    contractDefinition = insertAtMarker(
      contractDefinition,
      2,
      `    REGISTER_CONTRACT_FUNCTIONS_AND_PROCEDURES(${contractName});`,
      eol,
    );

    project = addXmlEntry(
      project,
      "ClInclude",
      `    <ClInclude Include="${windowsInclude}" />`,
      files.project.eol,
    );
    projectFilters = addXmlEntry(
      projectFilters,
      "ClInclude",
      [
        `    <ClInclude Include="${windowsInclude}">`,
        "      <Filter>contracts</Filter>",
        "    </ClInclude>",
      ].join(files.projectFilters.eol),
      files.projectFilters.eol,
    );
  }

  if (testSource && !hasXmlInclude(testProject, "ClCompile", testFileName)) {
    testProject = addXmlEntry(
      testProject,
      "ClCompile",
      `    <ClCompile Include="${testFileName}" />`,
      files.testProject.eol,
    );
  }
  if (
    testSource &&
    !hasXmlInclude(testProjectFilters, "ClCompile", testFileName)
  ) {
    testProjectFilters = addXmlEntry(
      testProjectFilters,
      "ClCompile",
      `    <ClCompile Include="${testFileName}" />`,
      files.testProjectFilters.eol,
    );
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
    testPath:
      testSource || existsSync(testDestination) ? testDestination : undefined,
    warnings,
  };
}

export async function runCoreIntegration(
  options: CoreIntegrationOptions,
): Promise<CoreIntegrationResult> {
  const projectRoot = resolve(options.projectRoot);
  const contractPath = resolveFromProject(projectRoot, options.contractPath);
  const corePath = resolveFromProject(projectRoot, options.outputPath);
  const contractName = options.contractName;

  validateContractName(contractName);
  if (
    !existsSync(contractPath) ||
    !statSync(contractPath).isFile() ||
    extname(contractPath).toLowerCase() !== ".h"
  ) {
    throw new Error(`contract header not found: ${contractPath}`);
  }
  const sourceFileName = basename(contractPath);
  if (!/^[A-Za-z_][A-Za-z0-9_-]*\.h$/.test(sourceFileName)) {
    throw new Error(`contract header has an unsafe file name: ${sourceFileName}`);
  }
  const sourceFromOutput = relative(corePath, contractPath);
  const sourceOutsideOutput =
    sourceFromOutput === ".." || sourceFromOutput.startsWith(`..${sep}`);
  if (
    sourceFromOutput === "" ||
    (!sourceOutsideOutput && !isAbsolute(sourceFromOutput))
  ) {
    throw new Error("contract source must be outside the Core output checkout");
  }

  const contractSource = readFileSync(contractPath, "utf8");
  const localTestPath = join(projectRoot, "tests", `${contractName}.test.cpp`);
  const testSource = existsSync(localTestPath)
    ? readFileSync(localTestPath, "utf8")
    : undefined;
  const checkoutExists = existsSync(corePath);

  if (checkoutExists) {
    if (!existsSync(join(corePath, ".git"))) {
      throw new Error(`output path exists but is not a git checkout: ${corePath}`);
    }
    await requireCleanCheckout(corePath);
  } else {
    await runGit([
      "clone",
      "--branch",
      "main",
      "--single-branch",
      options.repositoryUrl ?? CORE_REPOSITORY_URL,
      corePath,
    ]);
  }

  let files = loadCoreFiles(corePath);
  let branch = (await runGit(["branch", "--show-current"], corePath)).stdout;
  if (!branch) {
    throw new Error("Core checkout has a detached HEAD");
  }

  if (checkoutExists && branch === "main") {
    await runGit(["fetch", "origin", "main"], corePath);
    await runGit(["merge", "--ff-only", "origin/main"], corePath);
    await requireCleanCheckout(corePath);
    files = loadCoreFiles(corePath);
  }

  const existing = findRegistration(corePath, contractName, files);
  if (checkoutExists && branch !== "main" && !existing) {
    throw new Error(
      `contract '${contractName}' is not registered on existing branch '${branch}'`,
    );
  }
  validateMetadata(options, existing);

  const metadata = metadataFor(options, existing);
  const plan = planMutations({
    corePath,
    projectRoot,
    contractPath,
    contractName,
    contractSource,
    testSource,
    existing,
    metadata,
    files,
  });

  if (branch === "main") {
    const suffix = existing ? "-update" : "";
    branch = `qinit/${contractName.toLowerCase()}${suffix}`;
    if (await branchExists(corePath, branch)) {
      throw new Error(`local branch '${branch}' already exists`);
    }
    await runGit(["switch", "-c", branch], corePath);
  }

  for (const mutation of plan.mutations) {
    writeFileSync(mutation.path, mutation.bytes);
  }

  return {
    corePath,
    branch,
    contractIndex: plan.contractIndex,
    mode: existing ? "updated" : "created",
    testPath: plan.testPath,
    warnings: plan.warnings,
  };
}
