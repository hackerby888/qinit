import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { loadQpiHeader } from "@qinit/compiler";
import { detectContractName } from "@qinit/compiler/analyzer";
import { scanCallees } from "./intercontract";
import { systemContracts, type SystemContract } from "./system-contracts";

export interface CalleeInput {
    header: string;
    slot?: number;
}

export interface ResolvedContract {
    kind: "custom" | "system";
    name: string;
    stateType: string;
    sourcePath: string;
    source: string;
    slot?: number;
    callees: string[];
    // Pulled in by includeWorkspaceSiblings rather than by a reference from the contract being resolved.
    workspaceSibling?: boolean;
}

export interface ResolveContractsOptions {
    projectRoot: string;
    corePath: string;
    contractName: string;
    contractPath: string;
    slot?: number;
    explicitCallees?: Readonly<Record<string, CalleeInput>>;
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

function readCustomNode(name: string, sourcePath: string, slot?: number): ResolvedContract {
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
        throw new Error(`callee '${name}' source is missing: ${sourcePath}`);
    }

    return {
        kind: "custom",
        name,
        stateType: name,
        sourcePath,
        source: readFileSync(sourcePath, "utf8"),
        slot,
        callees: [],
    };
}

function systemNode(corePath: string, contract: SystemContract): ResolvedContract {
    return {
        kind: "system",
        name: contract.name,
        stateType: contract.stateType,
        sourcePath: join(corePath, "src", "contracts", contract.file),
        source: contract.source,
        slot: contract.index,
        callees: [],
    };
}

export function resolveContracts(options: ResolveContractsOptions): ResolvedContract[] {
    const projectRoot = resolve(options.projectRoot);
    const corePath = resolve(projectRoot, options.corePath);
    const contractPath = resolve(projectRoot, options.contractPath);
    const explicitCallees = options.explicitCallees ?? {};
    const catalog = systemContracts(corePath);
    // Two maps keep the resolution order explicit: a reference is a struct type (stateType) first,
    // and only falls back to the on-chain name / header basename when no type matches.
    const systemsByStateType = new Map<string, SystemContract>();
    const systemsByName = new Map<string, SystemContract>();
    const reservedSystemNames = new Map<string, SystemContract>();

    for (const contract of catalog) {
        systemsByStateType.set(contract.stateType, contract);
        systemsByName.set(contract.name, contract);
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
    const knownCallees = new Set([...systemsByStateType.keys(), ...systemsByName.keys(), ...Object.keys(explicitCallees), ...headers.keys()]);
    const nodes = new Map<string, ResolvedContract>();
    const visitState = new Map<string, "visiting" | "visited">();
    const stack: string[] = [];
    const ordered: ResolvedContract[] = [];
    const root = readCustomNode(options.contractName, contractPath, options.slot);
    nodes.set(root.stateType, root);

    const resolveSystem = (system: SystemContract): ResolvedContract => {
        const existing = nodes.get(system.stateType);
        if (existing) {
            return existing;
        }
        const node = systemNode(corePath, system);
        nodes.set(node.stateType, node);
        return node;
    };

    const resolveCallee = (reference: string, caller: ResolvedContract): ResolvedContract => {
        const known = nodes.get(reference);
        if (known) {
            return known;
        }

        // stateType is the primary key: scanCallees emits struct type names.
        const system = systemsByStateType.get(reference);
        if (system) {
            return resolveSystem(system);
        }

        const explicit = explicitCallees[reference];
        if (explicit) {
            const node = readCustomNode(reference, resolve(projectRoot, explicit.header), explicit.slot);
            nodes.set(node.stateType, node);
            return node;
        }

        // name fallback: a system contract's on-chain name, or a workspace name.h header.
        const systemByName = systemsByName.get(reference);
        if (systemByName) {
            return resolveSystem(systemByName);
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

    const visit = (node: ResolvedContract): void => {
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
                    slot: node.slot,
                    qpiHeader,
                },
                knownCallees,
            ),
        ].sort();
        const callees = references.map((reference) => resolveCallee(reference, node));
        node.callees = callees.map((callee) => callee.stateType);

        for (const callee of callees) {
            visit(callee);
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
    nodes: Map<string, ResolvedContract>;
    visitState: Map<string, "visiting" | "visited">;
    stack: string[];
    ordered: ResolvedContract[];
    visit: (node: ResolvedContract) => void;
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
                node.workspaceSibling = true;
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
