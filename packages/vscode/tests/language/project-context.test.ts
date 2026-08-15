import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analyzeContract, DiagnosticSeverity } from "@qinit/compiler/analyzer";
import { loadCoreWasmSlotLayout } from "@qinit/core/wasm/slot-layout-node";
import { generateClangdConfig } from "../../src/clangd-config";
import { planEditorProjectSlots, resolveProjectSourceDetails } from "../../src/project-context";

const CORE = process.env.QINIT_CORE ?? "";
const PROXY = resolve("fixtures", "Proxy.h");
const COUNTER = resolve("fixtures", "Counter.h");
const hasCore = existsSync(join(CORE, "src", "qpi", "qpi.h"));

test("editor slot planning keeps custom callees below callers", () => {
    const nodes = [
        {
            kind: "custom" as const,
            name: "Counter",
            stateType: "Counter",
            sourcePath: "/project/contracts/Counter.h",
            source: "",
            dependencies: [],
        },
        {
            kind: "custom" as const,
            name: "Proxy",
            stateType: "Proxy",
            sourcePath: "/project/contracts/Proxy.h",
            source: "",
            dependencies: ["Counter"],
        },
    ];

    const planned = planEditorProjectSlots(nodes, {
        slotBase: 29,
        slotCount: 4,
    });

    expect(planned.map((contract) => [contract.name, contract.index])).toEqual([
        ["Counter", 29],
        ["Proxy", 30],
    ]);
});

test.if(hasCore)("Proxy resolves Counter from contracts and configures clangd without a node", () => {
    const workspace = mkdtempSync(join(tmpdir(), "qpi-project-context-"));
    try {
        const contracts = join(workspace, "contracts");
        mkdirSync(contracts);
        const bundledCore = join(workspace, "bundled-core");
        const bundledSysroot = join(bundledCore, "wasi-sdk", "share", "wasi-sysroot");
        mkdirSync(bundledSysroot, { recursive: true });
        const proxyPath = join(contracts, "Proxy.h");
        const counterPath = join(contracts, "Counter.h");
        writeFileSync(proxyPath, readFileSync(PROXY, "utf8"));
        writeFileSync(counterPath, readFileSync(COUNTER, "utf8"));
        writeFileSync(
            join(workspace, "qinit.json"),
            JSON.stringify({
                contractName: "Proxy",
                contract: "contracts/Proxy.h",
                coreDir: CORE,
            }),
        );

        const details = resolveProjectSourceDetails({
            filePath: proxyPath,
            workspaceRoot: workspace,
            fallbackCorePath: bundledCore,
        });
        const layout = loadCoreWasmSlotLayout(CORE);
        expect(details.corePath).toBe(resolve(CORE));
        expect(details.wasiSysrootPath).toBe(bundledSysroot);
        expect(details.name).toBe("Proxy");
        expect(details.slot).toBe(layout.slotBase + 1);
        expect(details.dynCallees).toEqual({
            Counter: {
                header: counterPath.replace(/\\/g, "/"),
                index: layout.slotBase,
            },
        });

        const { cacheKey: _cacheKey, ...analysisOptions } = details.analysis;
        const analysis = analyzeContract({
            source: readFileSync(proxyPath, "utf8"),
            ...analysisOptions,
        });
        expect(analysis.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toEqual([]);

        const clangd = generateClangdConfig({
            contractPath: proxyPath,
            corePath: CORE,
            workspaceRoot: workspace,
            name: details.name,
            slot: details.slot,
            dynCallees: details.dynCallees,
            wasiSysrootPath: details.wasiSysrootPath,
        });
        expect(clangd.args).toContain(`--sysroot=${bundledSysroot.replace(/\\/g, "/")}`);
        expect(clangd.args).toContain(CORE.replace(/\\/g, "/"));
        const prefix = readFileSync(clangd.prefixPath, "utf8");
        expect(prefix).toContain("#define CONTRACT_STATE_TYPE Counter");
        expect(prefix).toContain(`#define CONTRACT_INDEX ${layout.slotBase}`);
        expect(prefix).toContain(`#include "${counterPath.replace(/\\/g, "/")}"`);
        expect(prefix).toContain("#define CONTRACT_STATE_TYPE Proxy");
        expect(prefix).toContain(`#define CONTRACT_INDEX ${layout.slotBase + 1}`);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});
