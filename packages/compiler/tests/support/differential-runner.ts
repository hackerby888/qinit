import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCorpusRunner } from "@qinit/build";

interface DifferentialRunnerOptions {
    corePath: string;
    source: string;
    testSource: string;
    name: string;
    tempPrefix: string;
    slot?: number;
}

export async function buildDifferentialRunner(options: DifferentialRunnerOptions): Promise<Uint8Array> {
    const dir = mkdtempSync(join(tmpdir(), options.tempPrefix));
    const contractPath = join(dir, `${options.name}.h`);
    const testPath = join(dir, `${options.name}.test.cpp`);
    const slot = options.slot ?? 28;

    writeFileSync(contractPath, options.source);
    writeFileSync(testPath, options.testSource);

    const built = await buildCorpusRunner({
        corpusPath: testPath,
        contractPath,
        contractName: options.name,
        stateType: options.name,
        slot,
        corePath: options.corePath,
        outDir: dir,
    });
    if (!built.ok || !built.wasmPath) {
        throw new Error(built.stderr ?? `failed to build ${options.name} differential runner`);
    }

    return new Uint8Array(readFileSync(built.wasmPath));
}
