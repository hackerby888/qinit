export interface ContractIndexConstant {
    name: string;
    index: number;
}

export interface ContractStateBlock {
    indexName: string;
    stateType: string;
    include: string;
}

export interface ParsedContractDefinitionSource {
    files: Map<number, string>;
    names: Map<number, string>;
    epochs: Map<number, number>;
    stateTypes: Map<number, string>;
    indexConstants: ContractIndexConstant[];
    contractStateBlocks: ContractStateBlock[];
}

export function parseContractDefinitionSource(definitionSource: string): ParsedContractDefinitionSource {
    const files = new Map<number, string>();
    const names = new Map<number, string>();
    const epochs = new Map<number, number>();
    const stateTypes = new Map<number, string>();
    const indexConstants = [...definitionSource.matchAll(/#define\s+(\w+)_CONTRACT_INDEX\s+(\d+)/g)].map((match) => ({
        name: match[1],
        index: Number(match[2]),
    }));
    const contractStateBlocks = [
        ...definitionSource.matchAll(
            /#define\s+CONTRACT_INDEX\s+(\w+)_CONTRACT_INDEX\s*\n\s*#define\s+CONTRACT_STATE_TYPE\s+(\w+)\s*\n\s*#define\s+CONTRACT_STATE2_TYPE\s+\w+\s*\n(?:\s*#ifdef\s+\w+\s*\n\s*#include\s+"[^"]+"\s*\n\s*#else\s*\n)?\s*#include\s+"([^"]+)"/g,
        ),
    ].map((match) => ({
        indexName: match[1],
        stateType: match[2],
        include: match[3],
    }));
    let currentIndex = -1;

    const descriptionBlock = definitionSource.match(/contractDescriptions\s*\[\s*\]\s*=\s*\{([\s\S]*?)\r?\n\s*\};/)?.[1];
    if (descriptionBlock) {
        let descriptionIndex = 0;
        for (const description of descriptionBlock.matchAll(/\{\s*"([^"]*)"([\s\S]*?)\}/g)) {
            if (description[1]) {
                names.set(descriptionIndex, description[1]);
            }
            const epoch = description[2].match(/^\s*,\s*(\d+)/)?.[1];
            if (epoch) {
                epochs.set(descriptionIndex, Number(epoch));
            }
            descriptionIndex++;
        }
    }

    for (const line of definitionSource.split(/\r?\n/)) {
        const explicitIndex = line.match(/#define\s+\w+_CONTRACT_INDEX\s+(\d+)/);
        if (explicitIndex) {
            currentIndex = Number(explicitIndex[1]);
            continue;
        }

        const incrementsIndex = /\bconstexpr\b.*\w+_CONTRACT_INDEX\s*=\s*\(\s*CONTRACT_INDEX\s*\+\s*1\s*\)/.test(line);
        if (incrementsIndex) {
            currentIndex += 1;
            continue;
        }

        const include = line.match(/#include\s+"contracts\/(\w+\.h)"/);
        if (include && currentIndex >= 0) {
            files.set(currentIndex, include[1]);
        }

        const stateType = line.match(/#define\s+CONTRACT_STATE_TYPE\s+(\w+)/);
        if (stateType && currentIndex >= 0) {
            stateTypes.set(currentIndex, stateType[1]);
        }
    }

    return {
        files,
        names,
        epochs,
        stateTypes,
        indexConstants,
        contractStateBlocks,
    };
}
