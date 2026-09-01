import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { loadQpiHeader } from "@qinit/compiler";
import { detectContractName } from "@qinit/compiler/analyzer";
import { scanCallees } from "./intercontract";
import { systemContracts, type SystemContract } from "./system-contracts";

export interface ProjectCalleeInput {
    header: string;
    index?: number;
}

export interface ProjectContractNode {
    kind: "custom" | "system";
    name: string;
    stateType: string;
    sourcePath: string;
    source: string;
    index?: number;
    dependencies: string[];
    // Pulled in by includeWorkspaceSiblings rather than by a reference from the contract being resolved.
    eager?: boolean;
}

export interface ResolveProjectDependenciesOptions {
    projectRoot: string;
    corePath: string;
    contractName: string;
    contractPath: string;
    contractIndex?: number;
    explicitCallees?: Readonly<Record<string, ProjectCalleeInput>>;
    additionalRootSource?: string;
    // Editors want every contract in the workspace, not only the ones the root already references.
    includeWorkspaceSiblings?: boolean;
}

function headerPaths(directory: string): string[] {
    if (!existsSync(directory)) {
        return [];
    }

    const paths: string[] = [];
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory()) {
            paths.push(...headerPaths(entryPath));
        } else if (entry.isFile() && entry.name.endsWith(".h")) {
            paths.push(entryPath);
        }
    }

    return paths;
}

function workspaceHeaders(projectRoot: string): Map<string, string[]> {
    const headers = new Map<string, string[]>();

    for (const headerPath of headerPaths(join(projectRoot, "contracts"))) {
        const name = basename(headerPath, ".h");
        const matching = headers.get(name) ?? [];
        matching.push(headerPath);
        headers.set(name, matching);
    }

    return headers;
}

function readCustomNode(name: string, sourcePath: string, index?: number): ProjectContractNode {
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
        throw new Error(`callee '${name}' source is missing: ${sourcePath}`);
    }

    return {
        kind: "custom",
        name,
        stateType: name,
        sourcePath,
        source: readFileSync(sourcePath, "utf8"),
        index,
        dependencies: [],
    };
}

function systemNode(corePath: string, contract: SystemContract): ProjectContractNode {
    return {
        kind: "system",
        name: contract.name,
        stateType: contract.stateType,
        sourcePath: join(corePath, "src", "contracts", contract.file),
        source: contract.source,
        index: contract.index,
        dependencies: [],
    };
}

export function resolveProjectDependencies(options: ResolveProjectDependenciesOptions): ProjectContractNode[] {
    const projectRoot = resolve(options.projectRoot);
    const corePath = resolve(projectRoot, options.corePath);
    const contractPath = resolve(projectRoot, options.contractPath);
    const explicitCallees = options.explicitCallees ?? {};
    const catalog = systemContracts(corePath);
    const systemByReference = new Map<string, SystemContract>();
    const reservedSystemNames = new Map<string, SystemContract>();

    for (const contract of catalog) {
        systemByReference.set(contract.name, contract);
        systemByReference.set(contract.stateType, contract);
        reservedSystemNames.set(contract.name.toLowerCase(), contract);
        reservedSystemNames.set(contract.stateType.toLowerCase(), contract);
    }

    const reservedRoot = reservedSystemNames.get(options.contractName.toLowerCase());
    if (reservedRoot) {
        throw new Error(`contract name '${options.contractName}' is reserved by system contract ${reservedRoot.name} at slot ${reservedRoot.index}`);
    }

    for (const name of Object.keys(explicitCallees).sort()) {
        const reserved = reservedSystemNames.get(name.toLowerCase());
        if (reserved) {
            throw new Error(`--callee '${name}' cannot override system contract ${reserved.name} at slot ${reserved.index}`);
        }
        if (name === options.contractName) {
            throw new Error(`--callee '${name}' duplicates the main contract`);
        }
    }

    const qpiHeader = loadQpiHeader(corePath);
    const headers = workspaceHeaders(projectRoot);
    const knownCallees = new Set([...systemByReference.keys(), ...Object.keys(explicitCallees), ...headers.keys()]);
    const nodes = new Map<string, ProjectContractNode>();
    const visitState = new Map<string, "visiting" | "visited">();
    const stack: string[] = [];
    const ordered: ProjectContractNode[] = [];
    const root = readCustomNode(options.contractName, contractPath, options.contractIndex);
    nodes.set(root.stateType, root);

    const resolveCallee = (reference: string, caller: ProjectContractNode): ProjectContractNode => {
        const known = nodes.get(reference);
        if (known) {
            return known;
        }

        const explicit = explicitCallees[reference];
        if (explicit) {
            const node = readCustomNode(reference, resolve(projectRoot, explicit.header), explicit.index);
            nodes.set(node.stateType, node);
            return node;
        }

        const system = systemByReference.get(reference);
        if (system) {
            const existing = nodes.get(system.stateType);
            if (existing) {
                return existing;
            }
            const node = systemNode(corePath, system);
            nodes.set(node.stateType, node);
            return node;
        }

        const candidates = headers.get(reference) ?? [];
        if (candidates.length > 1) {
            const listed = candidates
                .map((candidate) => relative(projectRoot, candidate).replaceAll("\\", "/"))
                .sort()
                .join(", ");
            throw new Error(`callee '${reference}' referenced by ${caller.stateType} is ambiguous: ${listed}`);
        }
        if (candidates.length === 1) {
            const node = readCustomNode(reference, candidates[0]);
            nodes.set(node.stateType, node);
            return node;
        }

        throw new Error(
            `unknown callee '${reference}' referenced by ${caller.stateType}; expected --callee ${reference}=path[@index] or contracts/**/${reference}.h`,
        );
    };

    const visit = (node: ProjectContractNode): void => {
        const state = visitState.get(node.stateType);
        if (state === "visited") {
            return;
        }
        if (state === "visiting") {
            const cycleStart = stack.indexOf(node.stateType);
            const cycle = [...stack.slice(cycleStart), node.stateType];
            throw new Error(`inter-contract dependency cycle: ${cycle.join(" -> ")}`);
        }

        visitState.set(node.stateType, "visiting");
        stack.push(node.stateType);

        const source = node === root && options.additionalRootSource ? `${node.source}\n${options.additionalRootSource}` : node.source;
        const references = [
            ...scanCallees(
                source,
                {
                    contractName: node.stateType,
                    slot: node.index,
                    qpiHeader,
                },
                knownCallees,
            ),
        ].sort();
        const dependencies = references.map((reference) => resolveCallee(reference, node));
        node.dependencies = dependencies.map((dependency) => dependency.stateType);

        for (const dependency of dependencies) {
            visit(dependency);
        }

        stack.pop();
        visitState.set(node.stateType, "visited");
        ordered.push(node);
    };

    visit(root);

    if (options.includeWorkspaceSiblings) {
        visitWorkspaceSiblings({ headers, nodes, visitState, stack, ordered, visit, reservedSystemNames });
    }

    return ordered;
}

interface SiblingVisit {
    headers: Map<string, string[]>;
    nodes: Map<string, ProjectContractNode>;
    visitState: Map<string, "visiting" | "visited">;
    stack: string[];
    ordered: ProjectContractNode[];
    visit: (node: ProjectContractNode) => void;
    reservedSystemNames: Map<string, SystemContract>;
}

// Append every workspace contract the root never referenced, after the reachable set so slot planning
// leaves the reachable contracts where they were. A sibling that fails to resolve is rolled back whole.
function visitWorkspaceSiblings(o: SiblingVisit): void {
    for (const [name, paths] of [...o.headers].sort(([left], [right]) => left.localeCompare(right))) {
        if (paths.length !== 1 || o.nodes.has(name) || o.reservedSystemNames.has(name.toLowerCase())) {
            continue;
        }

        const knownNodes = new Set(o.nodes.keys());
        const knownVisits = new Set(o.visitState.keys());
        const orderedLength = o.ordered.length;

        try {
            const sibling = readCustomNode(name, paths[0]);
            // A plain helper header under contracts/ is not a contract and must not take a slot.
            if (!detectContractName(sibling.source)) {
                continue;
            }
            o.nodes.set(sibling.stateType, sibling);
            o.visit(sibling);
            for (const node of o.ordered.slice(orderedLength)) {
                node.eager = true;
            }
        } catch {
            o.stack.length = 0;
            o.ordered.length = orderedLength;
            for (const key of [...o.nodes.keys()].filter((key) => !knownNodes.has(key))) {
                o.nodes.delete(key);
            }
            for (const key of [...o.visitState.keys()].filter((key) => !knownVisits.has(key))) {
                o.visitState.delete(key);
            }
        }
    }
}
