import { CORE_PATH } from "../../../../test-utils/paths";
// A system contract's ticker can differ from its C++ state type, such as QTRY and QUOTTERY.
// The wrapper must use the state type in its contract-state defines.
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemContract, systemContractClosure } from "../../src/index";
import { generateWasmWrapperSource } from "../../src/recipe";
import { systemContracts } from "../../src/system-contracts";

const base = { contractPath: "/x/Quottery.h", slot: 2, corePath: "/core", outDir: "/out" };

test("generateWasmWrapperSource uses stateType for the C++ struct #defines when it differs from name", () => {
    const w = generateWasmWrapperSource({ ...base, name: "QTRY", stateType: "QUOTTERY" });
    expect(w).toContain("#define CONTRACT_STATE_TYPE QUOTTERY");
    expect(w).toContain("#define CONTRACT_STATE2_TYPE QUOTTERY2");
    expect(w).toContain("#define QUOTTERY_CONTRACT_INDEX 2");
    expect(w).not.toContain("#define CONTRACT_STATE_TYPE QTRY"); // the ticker must not be used as the struct type
});

test("generateWasmWrapperSource defaults stateType to name (user contracts where they match)", () => {
    const w = generateWasmWrapperSource({ ...base, name: "Counter" });
    expect(w).toContain("#define CONTRACT_STATE_TYPE Counter");
    expect(w).toContain("#define Counter_CONTRACT_INDEX 2");
});

const CORE = CORE_PATH;
test.skipIf(!existsSync(`${CORE}/src/contract_core/contract_def.h`))("system catalog records the struct type distinct from the ticker", () => {
    const cat = systemContracts(CORE);
    const qtry = cat.find((c) => c.name === "QTRY");
    expect(qtry).toBeTruthy();
    expect(qtry!.stateType).toBe("QUOTTERY"); // ticker QTRY, struct QUOTTERY
    expect(qtry!.idl.name).toBe("QTRY");
    expect(qtry!.idl.slot).toBe(qtry!.index);
    // contracts whose ticker == struct type still carry a matching stateType
    const qx = cat.find((c) => c.name === "QX");
    expect(qx?.stateType).toBe("QX");
});

test.skipIf(!existsSync(`${CORE}/src/contracts/QUtil.h`))("system dependency closure follows canonical slot order", () => {
    expect(
        systemContractClosure(CORE, "QUTIL").map((contract) => ({
            name: contract.name,
            index: contract.index,
        })),
    ).toEqual([
        { name: "QX", index: 1 },
        { name: "QUTIL", index: 4 },
    ]);
});

test.skipIf(!existsSync(`${CORE}/src/contracts/MsVault.h`))("system dependency closure includes ABI-only references", () => {
    expect(systemContractClosure(CORE, "MSVAULT").map((contract) => contract.name)).toContain("QX");
});

test.skipIf(!existsSync(`${CORE}/src/contracts/Quottery.h`))(
    "TypeScript system build uses the state type and keeps the ticker IDL",
    async () => {
        const outDir = mkdtempSync(join(tmpdir(), "qinit-system-typescript-"));
        try {
            const built = await buildSystemContract("QTRY", CORE, {
                compiler: "typescript",
                outDir,
            });

            expect(built.ok).toBe(true);
            expect(built.index).toBe(2);
            expect(built.idl?.name).toBe("QTRY");
            expect(built.wasmPath).toBe(join(outDir, "QTRY.wasm"));
            expect(built.wasmSizeBytes).toBeGreaterThan(0);
        } finally {
            rmSync(outDir, { recursive: true, force: true });
        }
    },
    60_000,
);

test.skipIf(!existsSync(`${CORE}/src/contracts/QUtil.h`))(
    "TypeScript system build analyzes transitive callees before the target",
    async () => {
        const outDir = mkdtempSync(join(tmpdir(), "qinit-system-closure-"));
        try {
            const built = await buildSystemContract("QUTIL", CORE, {
                compiler: "typescript",
                outDir,
            });

            expect(built.ok).toBe(true);
            expect(built.index).toBe(4);
            expect(built.wasmPath).toBe(join(outDir, "QUTIL.wasm"));
        } finally {
            rmSync(outDir, { recursive: true, force: true });
        }
    },
    60_000,
);

test.skipIf(!existsSync(`${CORE}/src/contracts/Qx.h`))(
    "TypeScript system build compiles QX",
    async () => {
        const outDir = mkdtempSync(join(tmpdir(), "qinit-system-qx-"));
        try {
            const built = await buildSystemContract("QX", CORE, {
                compiler: "typescript",
                outDir,
            });

            expect(built.ok).toBe(true);
            expect(built.wasmPath).toBe(join(outDir, "QX.wasm"));
        } finally {
            rmSync(outDir, { recursive: true, force: true });
        }
    },
    60_000,
);
