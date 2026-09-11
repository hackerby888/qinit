// Programs clang refuses that the backend used to compile and run. Each row carries a control that
// clang accepts, so a fix that simply refuses more is not mistaken for a fix.
import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { wasiToolchain } from "../support/container-toolchains";

const CORE = CORE_PATH;
const HEADERS = () => loadQpiHeader(CORE);

// A file-scope enum constant sharing a name with a member function. Class scope is searched first, so
// the bare name is the function, and a function is not a value.
const hiddenByMember = (readBody: string) => `using namespace QPI;
enum Kind { Helper = 3, Solo = 4 };
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 a; };
  struct Helper_input { uint64 value; };
  struct Helper_output { uint64 doubled; };
  PRIVATE_FUNCTION(Helper) { output.doubled = input.value * 2; }
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${readBody} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

// A read-only entry reaching a mutating one. qpi.h gives a function a QpiContextFunctionCall and a
// procedure a QpiContextProcedureCall that derives from it, so the forwarded context does not convert.
const entryContext = (callerMacro: string, callerName: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 a; };
  struct Bump_input {}; struct Bump_output {};
  PRIVATE_PROCEDURE(Bump) { state.mut().a = state.get().a + 1; }
  struct ${callerName}_input {}; struct ${callerName}_output { uint64 v; };
  struct ${callerName}_locals { Bump_input bumpInput; Bump_output bumpOutput; };
  ${callerMacro}(${callerName}) { CALL(Bump, locals.bumpInput, locals.bumpOutput); output.v = state.get().a; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_${callerMacro.startsWith("PUBLIC_FUNCTION") ? "FUNCTION" : "PROCEDURE"}(${callerName}, 1); }
};`;

// A block-scoped asset iterator. qpi.h keeps the default constructor protected, so only the form that
// passes the asset constructs; the backend used to accept the bare declaration and size it at 8 bytes.
const iteratorLocal = (declaration: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 a; };
  struct Go_input {}; struct Go_output {};
  struct Go_locals { Asset asset; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Go) {
    locals.asset.issuer = SELF;
    locals.asset.assetName = 5525825ULL;
    ${declaration}
    state.mut().a = it.reachedEnd() ? 1 : 2;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

const REFUSED: Record<string, string> = {
    "a member function hiding a file-scope constant is not a value": hiddenByMember(`state.mut().a = Helper;`),
    "a read-only function cannot call a procedure": entryContext("PUBLIC_FUNCTION_WITH_LOCALS", "Peek"),
    "an asset iterator local cannot be default-constructed": iteratorLocal(`AssetOwnershipIterator it; it.begin(locals.asset);`),
};

const ACCEPTED: Record<string, string> = {
    "an enum constant no member hides still reads": hiddenByMember(`state.mut().a = Solo;`),
    "a procedure calling a procedure is the allowed direction": entryContext("PUBLIC_PROCEDURE_WITH_LOCALS", "Drive"),
    "an asset iterator local constructed from its asset": iteratorLocal(`AssetOwnershipIterator it(locals.asset, AssetOwnershipSelect::any());`),
};

const ourErrors = async (source: string) => {
    const ours = await compileContractWithTypeScript({
        source,
        contractName: "RefusalProbe",
        slot: 27,
        qpiHeader: HEADERS(),
        arenaSizeBytes: 1 << 20,
    });
    return { errors: ours.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR), wasm: ours.wasm };
};

const clangBuilds = async (source: string): Promise<boolean> => {
    const directory = mkdtempSync(join(tmpdir(), "refusal-probe-"));
    writeFileSync(join(directory, "RefusalProbe.h"), source);
    const built = await buildContractWithClang({
        contractPath: join(directory, "RefusalProbe.h"),
        contractName: "RefusalProbe",
        slot: 27,
        corePath: CORE,
        outDir: directory,
        skipVerify: true,
    });
    return built.ok;
};

const wasiOk = wasiToolchain().available;

describe.skipIf(!HAS_CORE)("differential — programs clang refuses", () => {
    beforeAll(async () => {
        await initK12();
    });

    for (const [name, source] of Object.entries(REFUSED)) {
        test(
            name,
            async () => {
                const { errors } = await ourErrors(source);
                expect(errors.length).toBeGreaterThan(0);
                if (wasiOk) expect(await clangBuilds(source)).toBe(false);
            },
            180000,
        );
    }

    for (const [name, source] of Object.entries(ACCEPTED)) {
        test(
            name,
            async () => {
                const { errors } = await ourErrors(source);
                expect(errors).toHaveLength(0);
                if (wasiOk) expect(await clangBuilds(source)).toBe(true);
            },
            180000,
        );
    }
});
