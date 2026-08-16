import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ContractSourceInput {
    contractPath?: string;
    source?: string;
    contractName: string;
    outDir: string;
}

// Both backends accept either a path or source text, so one options object drives either. Clang needs a real
// file for #include resolution, #line mapping and the protocol verifier, so text is staged into outDir.
export function resolveContractSource(o: ContractSourceInput): { source: string; contractPath: string } {
    if (o.contractPath) {
        return { source: readFileSync(o.contractPath, "utf8"), contractPath: o.contractPath };
    }
    if (o.source === undefined) {
        throw new Error("contract build needs either `contractPath` or `source`");
    }
    mkdirSync(o.outDir, { recursive: true });
    const contractPath = join(o.outDir, `${o.contractName}.h`);
    writeFileSync(contractPath, o.source);
    return { source: o.source, contractPath };
}
