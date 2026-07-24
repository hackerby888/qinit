import { expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { QINIT_ROOT } from "../../../../test-utils/paths";
import { generateClient } from "../../src/gen-client";
import { testRuntimeSource } from "../../src/gen-test";
import { systemContracts } from "../../src/system-contracts";

test.skipIf(!process.env.QINIT_CORE)(
  "standalone clients for every live contract typecheck",
  () => {
    const outputDir = mkdtempSync(join(tmpdir(), "qinit-client-typecheck-"));

    try {
      const runtimePath = join(outputDir, "runtime.ts");
      writeFileSync(runtimePath, testRuntimeSource);

      const rootNames = [runtimePath];
      const catalog = systemContracts(process.env.QINIT_CORE!);
      expect(catalog.length).toBeGreaterThan(0);

      for (const contract of catalog) {
        const filename = `${contract.index}-${contract.name.toLowerCase()}.ts`;
        const clientPath = join(outputDir, filename);
        writeFileSync(
          clientPath,
          generateClient(contract.idl, contract.index, {
            runtimeImport: "./runtime",
          }),
        );
        rootNames.push(clientPath);
      }

      const configPath = join(QINIT_ROOT, "tsconfig.json");
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        QINIT_ROOT,
      );
      const program = ts.createProgram({
        rootNames,
        options: {
          ...parsed.options,
          noEmit: true,
          paths: {
            ...parsed.options.paths,
            "@qubic-lib/*": ["node_modules/@qubic-lib/*"],
          },
        },
      });
      const diagnostics = [
        ...parsed.errors,
        ...ts.getPreEmitDiagnostics(program),
      ];
      const formatted = ts.formatDiagnosticsWithColorAndContext(
        diagnostics,
        {
          getCanonicalFileName: (filename) => filename,
          getCurrentDirectory: () => QINIT_ROOT,
          getNewLine: () => "\n",
        },
      );

      expect(formatted).toBe("");
    } finally {
      rmSync(outputDir, {
        recursive: true,
        force: true,
      });
    }
  },
  30_000,
);
