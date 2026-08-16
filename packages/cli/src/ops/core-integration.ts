import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseContractDef } from "@qinit/build/contracts/intercontract";
import {
    coreFilePaths,
    descriptions,
    hasXmlInclude,
    planMutations,
    registrationCount,
    type ContractMetadata,
    type CoreFiles,
    type CoreIntegrationRegistration,
    type TextFile,
} from "./core-integration-plan";

export type { CoreIntegrationRegistration } from "./core-integration-plan";

const CORE_REPOSITORY_URL = "https://github.com/qubic/core.git";

export type CoreIntegrationStep = "contract" | "checkout" | "wire";

export interface CoreIntegrationProgress {
    step: CoreIntegrationStep;
    state: "active" | "ok" | "fail";
    detail?: string;
    elapsedMs?: number;
}

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
    onProgress?: (event: CoreIntegrationProgress) => void;
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

async function runProgressStep<T>(
    options: CoreIntegrationOptions,
    step: CoreIntegrationStep,
    initialDetail: string,
    operation: (updateDetail: (detail: string) => void) => Promise<{ value: T; detail: string }> | { value: T; detail: string },
): Promise<T> {
    const startedAt = Date.now();
    let activeDetail = initialDetail;

    const emit = (state: CoreIntegrationProgress["state"], detail: string): void => {
        options.onProgress?.({
            step,
            state,
            detail,
            elapsedMs: state === "active" ? undefined : Date.now() - startedAt,
        });
    };
    const updateDetail = (detail: string): void => {
        activeDetail = detail;
        emit("active", detail);
    };

    emit("active", initialDetail);
    try {
        const result = await operation(updateDetail);
        emit("ok", result.detail);
        return result.value;
    } catch (error) {
        if (!(error instanceof CoreIntegrationMetadataRequiredError)) {
            emit("fail", activeDetail);
        }
        throw error;
    }
}

function readTextFile(path: string): TextFile {
    const bytes = readFileSync(path);
    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const text = bytes.subarray(bom ? 3 : 0).toString("utf8");

    return {
        bom,
        eol: text.includes("\r\n") ? "\r\n" : "\n",
        text,
    };
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

function findRegistration(corePath: string, contractName: string, files: CoreFiles): (CoreIntegrationRegistration & { include: string }) | null {
    const definitions = parseContractDef(corePath);
    const caseInsensitiveMatch = [...definitions.entries()].find(([stateType]) => stateType.toLowerCase() === contractName.toLowerCase());

    if (!caseInsensitiveMatch) {
        return null;
    }
    if (caseInsensitiveMatch[0] !== contractName) {
        throw new Error(`contract name '${contractName}' collides with registered '${caseInsensitiveMatch[0]}'`);
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
        throw new Error(`contract '${contractName}' is only partially registered in this Core checkout`);
    }

    return {
        index: definition.index,
        assetName: description.assetName,
        constructionEpoch: description.constructionEpoch,
        destructionEpoch: description.destructionEpoch,
        include: definition.include,
    };
}

export function inspectCoreIntegration(corePath: string, contractName: string): CoreIntegrationRegistration | null {
    const resolvedCorePath = resolve(corePath);
    const files = loadCoreFiles(resolvedCorePath);
    const registration = findRegistration(resolvedCorePath, contractName, files);

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

function validateMetadata(options: CoreIntegrationOptions, existing: CoreIntegrationRegistration | null): void {
    const metadata = {
        assetName: options.assetName ?? existing?.assetName,
        constructionEpoch: options.constructionEpoch ?? existing?.constructionEpoch,
        destructionEpoch: options.destructionEpoch ?? existing?.destructionEpoch ?? (options.requireDestructionEpoch ? undefined : 10_000),
    };

    if (metadata.assetName === undefined || metadata.constructionEpoch === undefined || metadata.destructionEpoch === undefined) {
        throw new CoreIntegrationMetadataRequiredError();
    }
    if (!/^[A-Z][A-Z0-9]{0,6}$/.test(metadata.assetName)) {
        throw new Error("asset must be 1-7 uppercase letters or digits and start with a letter");
    }
    if (!Number.isInteger(metadata.constructionEpoch) || metadata.constructionEpoch < 1 || metadata.constructionEpoch > 65_535) {
        throw new Error("construction epoch must be an integer from 1 to 65535");
    }
    if (!Number.isInteger(metadata.destructionEpoch) || metadata.destructionEpoch <= metadata.constructionEpoch || metadata.destructionEpoch > 65_535) {
        throw new Error("destruction epoch must be an integer after construction and at most 65535");
    }

    if (!existing) {
        return;
    }

    for (const key of ["assetName", "constructionEpoch", "destructionEpoch"] as const) {
        const supplied = options[key];
        if (supplied !== undefined && supplied !== existing[key]) {
            throw new Error(`${key} does not match the registered value '${existing[key]}'`);
        }
    }
}

async function runGit(args: string[], cwd?: string, allowFailure = false): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const child = Bun.spawn(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

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
    const result = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], corePath, true);
    return result.exitCode === 0;
}

function resolveFromProject(projectRoot: string, path: string): string {
    return isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
}

function localHeaderNames(projectRoot: string, contractPath: string): string[] {
    const directories = new Set([join(projectRoot, "contracts"), resolve(contractPath, "..")]);
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

function metadataFor(options: CoreIntegrationOptions, existing: CoreIntegrationRegistration | null): ContractMetadata {
    return {
        assetName: options.assetName ?? existing!.assetName,
        constructionEpoch: options.constructionEpoch ?? existing!.constructionEpoch,
        destructionEpoch: options.destructionEpoch ?? existing?.destructionEpoch ?? 10_000,
    };
}

export async function runCoreIntegration(options: CoreIntegrationOptions): Promise<CoreIntegrationResult> {
    const projectRoot = resolve(options.projectRoot);
    const contractPath = resolveFromProject(projectRoot, options.contractPath);
    const corePath = resolveFromProject(projectRoot, options.outputPath);
    const contractName = options.contractName;
    const sourceFileName = basename(contractPath);
    const contract = await runProgressStep(options, "contract", sourceFileName, () => {
        validateContractName(contractName);
        if (!existsSync(contractPath) || !statSync(contractPath).isFile() || extname(contractPath).toLowerCase() !== ".h") {
            throw new Error(`contract header not found: ${contractPath}`);
        }
        if (!/^[A-Za-z_][A-Za-z0-9_-]*\.h$/.test(sourceFileName)) {
            throw new Error(`contract header has an unsafe file name: ${sourceFileName}`);
        }

        const sourceFromOutput = relative(corePath, contractPath);
        const sourceOutsideOutput = sourceFromOutput === ".." || sourceFromOutput.startsWith(`..${sep}`);
        if (sourceFromOutput === "" || (!sourceOutsideOutput && !isAbsolute(sourceFromOutput))) {
            throw new Error("contract source must be outside the Core output checkout");
        }

        const contractSource = readFileSync(contractPath, "utf8");
        const localTestPath = join(projectRoot, "tests", `${contractName}.test.cpp`);
        const testSource = existsSync(localTestPath) ? readFileSync(localTestPath, "utf8") : undefined;

        return {
            value: { contractSource, testSource },
            detail: sourceFileName,
        };
    });
    const checkoutExists = existsSync(corePath);
    const checkout = await runProgressStep(options, "checkout", checkoutExists ? "checking checkout" : "cloning main", async (updateDetail) => {
        if (checkoutExists) {
            if (!existsSync(join(corePath, ".git"))) {
                throw new Error(`output path exists but is not a git checkout: ${corePath}`);
            }
            await requireCleanCheckout(corePath);
        } else {
            await runGit(["clone", "--branch", "main", "--single-branch", options.repositoryUrl ?? CORE_REPOSITORY_URL, corePath]);
        }

        let files = loadCoreFiles(corePath);
        const branch = (await runGit(["branch", "--show-current"], corePath)).stdout;
        if (!branch) {
            throw new Error("Core checkout has a detached HEAD");
        }

        let detail = "cloned main";
        if (checkoutExists && branch === "main") {
            updateDetail("updating main");
            await runGit(["fetch", "origin", "main"], corePath);
            await runGit(["merge", "--ff-only", "origin/main"], corePath);
            await requireCleanCheckout(corePath);
            files = loadCoreFiles(corePath);
            detail = "updated main";
        } else if (checkoutExists) {
            detail = `using ${branch}`;
            updateDetail(detail);
        }

        return {
            value: { files, branch },
            detail,
        };
    });

    return runProgressStep(options, "wire", "checking registration", async (updateDetail) => {
        const existing = findRegistration(corePath, contractName, checkout.files);
        if (checkoutExists && checkout.branch !== "main" && !existing) {
            throw new Error(`contract '${contractName}' is not registered on existing branch ` + `'${checkout.branch}'`);
        }
        validateMetadata(options, existing);

        const metadata = metadataFor(options, existing);
        const plan = planMutations({
            corePath,
            contractPath,
            contractName,
            contractSource: contract.contractSource,
            testSource: contract.testSource,
            existing,
            metadata,
            files: checkout.files,
            definitions: parseContractDef(corePath),
            localHeaders: localHeaderNames(projectRoot, contractPath),
            fileExists: existsSync,
        });

        let branch = checkout.branch;
        if (branch === "main") {
            const suffix = existing ? "-update" : "";
            branch = `qinit/${contractName.toLowerCase()}${suffix}`;
            updateDetail(`creating ${branch}`);
            if (await branchExists(corePath, branch)) {
                throw new Error(`local branch '${branch}' already exists`);
            }
            await runGit(["switch", "-c", branch], corePath);
        } else {
            updateDetail(`using ${branch}`);
        }

        for (const mutation of plan.mutations) {
            writeFileSync(mutation.path, mutation.bytes);
        }

        const mode = existing ? "updated" : "created";
        return {
            value: {
                corePath,
                branch,
                contractIndex: plan.contractIndex,
                mode,
                testPath: plan.testPath,
                warnings: plan.warnings,
            },
            detail: `${mode} index ${plan.contractIndex}`,
        };
    });
}
