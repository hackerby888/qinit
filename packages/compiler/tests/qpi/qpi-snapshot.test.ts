import { CORE_PATH } from "../../../../test-utils/paths";
// Verifies the assembled header, manifest hash, and generated browser module.
import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_WASM_HEADERS } from "@qinit/core/wasm/headers";
import { loadQpiHeader } from "../../src/index";
import {
    assembleQpiHeader,
    GENERATOR_VERSION,
    qpiHeadersEquivalent,
    snapshotInputFiles,
} from "../../src/driver/qpi/snapshot";
import { IMPL_BOUNDARY, WASM_ABI_MARKER } from "../../src/driver/qpi/snapshot-format";
import { QPI_SNAPSHOT, QPI_SNAPSHOT_META } from "../../src/generated/qpi-snapshot";
import { QPI_PROTOCOL_PRELUDE } from "../../src/generated/qpi-protocol-prelude";
import { assembleQpiProtocolPrelude } from "../../src/driver/qpi/prelude";

const CORE = CORE_PATH;
const coreOk = existsSync(join(CORE, "src", "qpi", "qpi.h"));
const snapshotManifest = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "..", "core-snapshot.json"), "utf8"),
) as { coreCommit: string };

const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 n; };
  struct Bump_input { uint64 by; };
  struct Bump_output {};
  PUBLIC_PROCEDURE(Bump)
  {
    state.mut().n += input.by;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Bump, 1); }
};`;

const FORMATTED_HEADER = `${WASM_ABI_MARKER}{"abiVersion":1,"lhost":[],"systemProcedures":[],"records":{}}
#define SUM(a, b) ((a) + (b))
int add(
  int left,
  int right);

${IMPL_BOUNDARY}
int add(
  int left,
  int right)
{
  return left + right;
}
`;

const COMPACT_HEADER = `${WASM_ABI_MARKER}{"abiVersion":1,"lhost":[],"systemProcedures":[],"records":{}}
#define SUM(a,b) ((a)+(b))
int add(int left,int right);
${IMPL_BOUNDARY}
int add(int left,int right){return left+right;}
`;

describe("qpi header equivalence", () => {
    test("ignores endlines, spaces, and empty lines", () => {
        expect(qpiHeadersEquivalent(FORMATTED_HEADER, COMPACT_HEADER)).toBe(true);
        expect(qpiHeadersEquivalent(FORMATTED_HEADER.replace(/\n/g, "\r\n"), COMPACT_HEADER)).toBe(
            true,
        );
    });

    test("preserves semantic tokens", () => {
        expect(
            qpiHeadersEquivalent(
                FORMATTED_HEADER,
                COMPACT_HEADER.replace("left+right", "left-right"),
            ),
        ).toBe(false);
        expect(
            qpiHeadersEquivalent(
                COMPACT_HEADER.replace("left+right", "left + +right"),
                COMPACT_HEADER.replace("left+right", "left++right"),
            ),
        ).toBe(false);
        expect(
            qpiHeadersEquivalent(
                FORMATTED_HEADER,
                COMPACT_HEADER.replace('"abiVersion":1', '"abiVersion":2'),
            ),
        ).toBe(false);
    });
});

describe.if(coreOk)("qpi snapshot assembly", () => {
    test("loadQpiHeader delegates to assembleQpiHeader byte-identically", () => {
        expect(assembleQpiHeader(CORE)).toBe(loadQpiHeader(CORE));
    });

    test("assembly is deterministic", () => {
        expect(assembleQpiHeader(CORE)).toBe(assembleQpiHeader(CORE));
    });

    test("input tracking follows the canonical split SDK layout", () => {
        const inputs = snapshotInputFiles(CORE);
        const wasmInputs = [
            CORE_WASM_HEADERS.shared.abiMetadata,
            CORE_WASM_HEADERS.shared.abiTypes,
            CORE_WASM_HEADERS.sdk.lhostImports,
            CORE_WASM_HEADERS.sdk.qpiForwarders,
            CORE_WASM_HEADERS.sdk.moduleStorage,
        ];
        for (const relativePath of wasmInputs) {
            expect(inputs).toContain(join(CORE, "src", relativePath));
        }
        expect(
            inputs
                .filter((path) => path.startsWith(join(CORE, "src", CORE_WASM_HEADERS.root)))
                .sort(),
        ).toEqual(wasmInputs.map((path) => join(CORE, "src", path)).sort());
        expect(inputs).toContain(join(CORE, "src", "oc_interfaces", "Mock.h"));
        expect(inputs).toContain(join(CORE, "src", "network_messages", "common_def.h"));
        expect(inputs).toContain(join(CORE, "src", "qpi", "impl", "qpi_trivial_impl.h"));
    });

    test("protocol prelude is generated from core common definitions", () => {
        const source = readFileSync(join(CORE, "src", "network_messages", "common_def.h"), "utf8");
        expect(QPI_PROTOCOL_PRELUDE).toBe(assembleQpiProtocolPrelude(source));
        expect(QPI_SNAPSHOT).toContain(QPI_PROTOCOL_PRELUDE);
    });

    test("non-core path throws instead of returning a stub", () => {
        expect(() => assembleQpiHeader("/nonexistent")).toThrow(/not a core checkout/);
    });
});

const browserModule = "../../src/browser";

describe("tracked snapshot + browser entry", () => {
    test("protocol prelude extraction rejects drift and preserves source values", () => {
        const changed = QPI_PROTOCOL_PRELUDE.replace(
            "#define MAX_NUMBER_OF_CONTRACTS 1024",
            "#define MAX_NUMBER_OF_CONTRACTS 2048",
        );
        expect(assembleQpiProtocolPrelude(changed)).toContain(
            "#define MAX_NUMBER_OF_CONTRACTS 2048",
        );
        expect(() =>
            assembleQpiProtocolPrelude(QPI_PROTOCOL_PRELUDE.replace(/^.*MAX_AMOUNT.*\n/m, "")),
        ).toThrow(/MAX_AMOUNT/);
    });

    test("generated module matches the assembly semantically with an exact byte hash", async () => {
        if (coreOk) {
            expect(qpiHeadersEquivalent(QPI_SNAPSHOT, assembleQpiHeader(CORE))).toBe(true);
        }
        const hash = "sha256:" + createHash("sha256").update(QPI_SNAPSHOT).digest("hex");
        expect(QPI_SNAPSHOT_META.snapshotHash as string).toBe(hash);
        expect(QPI_SNAPSHOT_META.generatorVersion).toBe(GENERATOR_VERSION);
        expect(QPI_SNAPSHOT_META.coreCommit as string).toBe(snapshotManifest.coreCommit);
    });

    test("browser entry compiles without a caller-provided qpiHeader", async () => {
        const browser = await import(browserModule);
        const res = await browser.compileContract({
            source: SOURCE,
            contractName: "SNAP",
            slot: 27,
            arenaSizeBytes: 1 << 20,
        });
        expect(
            res.diagnostics.filter((d: { severity: string }) => d.severity === "error"),
        ).toHaveLength(0);
        expect(res.wasm.byteLength).toBeGreaterThan(0);
        expect(res.idl.procedures.map((p: { name: string }) => p.name)).toContain("Bump");

        expect(browser.compilerInfo.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(browser.compilerInfo.protocolVersion).toBe(browser.COMPILER_PROTOCOL_VERSION);
        expect(browser.compilerInfo.qinitVersion.length).toBeGreaterThan(0);
        expect(browser.compilerInfo.coreCommit.length).toBeGreaterThan(0);
    });
});
