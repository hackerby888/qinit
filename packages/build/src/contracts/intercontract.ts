import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeContract, DiagnosticSeverity, Lexer, TokenKind, type AnalyzeContractOptions } from "@qinit/compiler/analyzer";
import { loadQpiHeader } from "@qinit/compiler";
import { parseContractDefinitionSource, type ParsedContractDefinitionSource } from "./contract-def";

export interface CalleeDef {
    type: string;
    index: number;
    include: string;
}

function readContractDefinitions(corePath: string): ParsedContractDefinitionSource {
    return parseContractDefinitionSource(readFileSync(join(corePath, "src/contract_core/contract_def.h"), "utf8"));
}

function calleeDefinitions(parsed: ParsedContractDefinitionSource): Map<string, CalleeDef> {
    const indexes = new Map<string, number>();

    for (const constant of parsed.indexConstants) {
        indexes.set(constant.name, constant.index);
    }

    const definitions = new Map<string, CalleeDef>();
    for (const block of parsed.contractStateBlocks) {
        const index = indexes.get(block.indexName);
        if (index !== undefined) {
            definitions.set(block.stateType, {
                type: block.stateType,
                index,
                include: block.include,
            });
        }
    }

    return definitions;
}

export function parseContractDef(corePath: string): Map<string, CalleeDef> {
    return calleeDefinitions(readContractDefinitions(corePath));
}

type SourceOptions = Pick<AnalyzeContractOptions, "contractName" | "slot" | "qpiHeader">;

export function scanCallees(source: string, options: SourceOptions = {}, knownCallees: Iterable<string> = []): Set<string> {
    const analysis = analyzeContract({ source, ...options });
    const callees = new Set(analysis.calls.map((call) => call.callee));
    if (options.contractName) {
        callees.delete(options.contractName);
    }
    const candidates = [...knownCallees].filter((candidate) => candidate !== options.contractName);
    const candidateSet = new Set(candidates);

    if (candidates.length === 0) {
        return callees;
    }

    const tokens = new Lexer(source).tokenize();
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind !== TokenKind.IDENTIFIER) {
            continue;
        }

        const initializedContract =
            token.text === "INIT_CONTRACT" && tokens[index + 1]?.kind === TokenKind.L_PAREN && tokens[index + 2]?.kind === TokenKind.IDENTIFIER
                ? tokens[index + 2].text
                : undefined;
        if (initializedContract && candidateSet.has(initializedContract)) {
            callees.add(initializedContract);
        }

        for (const candidate of candidates) {
            const qualifiedReference = token.text === candidate && tokens[index + 1]?.kind === TokenKind.D_COLON;
            const constantReference = token.text.startsWith(`${candidate}_`) && /^[A-Z]/.test(token.text[candidate.length + 1] ?? "");
            if (qualifiedReference || constantReference) {
                callees.add(candidate);
            }
        }
    }

    return callees;
}

export function parseRegisters(source: string, options: SourceOptions = {}): { fn: string; n: number }[] {
    const analysis = analyzeContract({ source, ...options });

    if (!analysis.idl) {
        const message = analysis.diagnostics
            .filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)
            .map((diagnostic) => diagnostic.message)
            .join("; ");
        throw new Error(message || "compiler did not produce contract IDL");
    }
    return [...analysis.idl.functions, ...analysis.idl.procedures].map((entry) => ({
        fn: entry.name,
        n: entry.inputType,
    }));
}

export type DynCallees = Record<string, { header: string; index: number }>;

function indexDefines(parsed: ParsedContractDefinitionSource): string {
    let output = "// ---- all contract indices (contract_def.h) so a directly-#included sibling resolves ----\n";
    for (const constant of parsed.indexConstants) {
        output += `#ifndef ${constant.name}_CONTRACT_INDEX\n#define ${constant.name}_CONTRACT_INDEX ${constant.index}\n#endif\n`;
    }

    return output;
}

export function contractIndexDefines(corePath: string): string {
    try {
        return indexDefines(readContractDefinitions(corePath));
    } catch {
        return "";
    }
}

export function buildCalleePrelude(
    corePath: string,
    contractSource: string,
    dynamicCallees: DynCallees = {},
    selfType?: string,
    // Editors index every sibling contract, so a callee the source has not referenced yet still resolves.
    includeUnreferencedCallees = false,
): string {
    let indexBlock = "";
    let definitions = new Map<string, CalleeDef>();

    try {
        const parsed = readContractDefinitions(corePath);
        indexBlock = indexDefines(parsed);
        definitions = calleeDefinitions(parsed);
    } catch {
        // Builds without static callees do not require a core contract registry.
    }

    const knownCallees = new Set([...definitions.keys(), ...Object.keys(dynamicCallees)]);
    const unreferenced = includeUnreferencedCallees ? Object.keys(dynamicCallees).filter((type) => type !== selfType) : [];
    let wanted = new Set([...scanCallees(contractSource, { contractName: selfType }, knownCallees), ...unreferenced]);

    if (wanted.size === 0) {
        return indexBlock;
    }

    let qpiHeader: string | undefined;

    try {
        qpiHeader = loadQpiHeader(corePath);
    } catch (error) {
        if (![...wanted].every((type) => dynamicCallees[type])) {
            throw error;
        }
    }

    const sourceOptions = {
        name: selfType,
        qpiHeader,
    };
    wanted = new Set([...scanCallees(contractSource, sourceOptions, knownCallees), ...unreferenced]);

    interface ResolvedCallee {
        type: string;
        index: number;
        include: string;
        src: string;
        registrations: { fn: string; n: number }[];
    }

    const resolved = new Map<string, ResolvedCallee>();
    const resolveCallee = (type: string) => {
        if (type === selfType) {
            return;
        }
        if (resolved.has(type)) {
            return;
        }

        let callee: ResolvedCallee;

        if (dynamicCallees[type]) {
            callee = {
                type,
                index: dynamicCallees[type].index,
                include: dynamicCallees[type].header,
                src: readFileSync(dynamicCallees[type].header, "utf8"),
                registrations: [],
            };
        } else if (definitions.has(type)) {
            const definition = definitions.get(type)!;
            callee = {
                type,
                index: definition.index,
                include: definition.include,
                src: readFileSync(join(corePath, "src", definition.include), "utf8"),
                registrations: [],
            };
        } else {
            throw new Error(`inter-contract: unknown callee '${type}' (not in contract_def.h, not a declared dynamic callee)`);
        }

        callee.registrations = parseRegisters(callee.src, {
            contractName: type,
            slot: callee.index,
            qpiHeader,
        });
        resolved.set(type, callee);

        const nestedCallees = scanCallees(
            callee.src,
            {
                contractName: type,
                slot: callee.index,
                qpiHeader,
            },
            knownCallees,
        );
        for (const nestedType of nestedCallees) {
            resolveCallee(nestedType);
        }
    };

    for (const calleeType of wanted) {
        if (!unreferenced.includes(calleeType)) {
            resolveCallee(calleeType);
            continue;
        }

        // A sibling the source never mentions is offered for completion only, so a broken one drops
        // with whatever subtree it pulled in rather than failing the contract being edited.
        const before = new Set(resolved.keys());
        try {
            resolveCallee(calleeType);
        } catch {
            for (const type of [...resolved.keys()].filter((type) => !before.has(type))) {
                resolved.delete(type);
            }
        }
    }

    const callees = [...resolved.values()].sort((left, right) => left.index - right.index);
    let output = "// ---- inter-contract callees (auto-derived from contract_def.h) ----\n";

    for (const callee of callees) {
        output += `#define CONTRACT_STATE2_TYPE ${callee.type}2\n#define CONTRACT_STATE_TYPE ${callee.type}\n#define CONTRACT_INDEX ${callee.index}\n`;
        output += `#include "${callee.include}"\n`;
        output += `#undef CONTRACT_INDEX\n#undef CONTRACT_STATE_TYPE\n#undef CONTRACT_STATE2_TYPE\n`;
    }

    output += "// ---- callee <Type>_CONTRACT_INDEX constants ----\n";
    for (const callee of callees) {
        output += `#ifndef ${callee.type}_CONTRACT_INDEX\n#define ${callee.type}_CONTRACT_INDEX ${callee.index}\n#endif\n`;
    }

    output += "// ---- generated <Type>_<fn>_inputType constants ----\n";
    for (const callee of callees) {
        for (const registration of callee.registrations) {
            output += `static constexpr unsigned short ${callee.type}_${registration.fn}_inputType = ${registration.n};\n`;
        }
    }

    // The wrapper includes the inter-contract SDK header itself, after CONTRACT_INDEX is defined.
    return indexBlock + output;
}
