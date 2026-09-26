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

// A const view of state. ContractState::get, Array::get, HashMap::value and LinkedList::element return
// `const T&`, so a non-const member call on anything reached through them is ill-formed. The backend used
// to check assignment only, and by the spelling `get` rather than by the declared return type.
const constView = (body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Entry { uint64 tag; BitArray<64> flags; };
  struct StateData { uint64 a; Array<uint64, 4> arr; BitArray<8> flags; HashMap<id, Entry, 16> m; Array<Entry, 4> entries; LinkedList<Entry, 8> l; Collection<Entry, 8> coll; };
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;
const READ_ONLY = /read-only/;

const REFUSED: Record<
    string,
    {
        source: string;
        diagnostic?: RegExp;
    }
> = {
    "a member function hiding a file-scope constant is not a value": { source: hiddenByMember(`state.mut().a = Helper;`) },
    "a read-only function cannot call a procedure": { source: entryContext("PUBLIC_FUNCTION_WITH_LOCALS", "Peek") },
    "an asset iterator local cannot be default-constructed": { source: iteratorLocal(`AssetOwnershipIterator it; it.begin(locals.asset);`) },
    "a scalar write through state.get()": { source: constView(`state.get().a = 77;`), diagnostic: READ_ONLY },
    "a container mutator through state.get()": { source: constView(`state.get().arr.set(0, 1);`), diagnostic: READ_ONLY },
    "a bit set through state.get()": { source: constView(`state.get().flags.set(3, true);`), diagnostic: READ_ONLY },
    "a mutator on a HashMap value reference": { source: constView(`state.mut().m.value(0).flags.set(40, true);`), diagnostic: READ_ONLY },
    "a mutator on an Array element reference": { source: constView(`state.mut().entries.get(0).flags.set(1, true);`), diagnostic: READ_ONLY },
    "a mutator on a LinkedList element reference": { source: constView(`state.mut().l.element(0).flags.set(40, true);`), diagnostic: READ_ONLY },
};

const ACCEPTED: Record<string, string> = {
    "an enum constant no member hides still reads": hiddenByMember(`state.mut().a = Solo;`),
    "a procedure calling a procedure is the allowed direction": entryContext("PUBLIC_PROCEDURE_WITH_LOCALS", "Drive"),
    "an asset iterator local constructed from its asset": iteratorLocal(`AssetOwnershipIterator it(locals.asset, AssetOwnershipSelect::any());`),
    "the same mutators through state.mut()": constView(`state.mut().arr.set(0, 1); state.mut().flags.set(3, true); state.mut().a = 1;`),
    "const reads and a static call through state.get()": constView(
        `state.mut().a = state.get().arr.get(0) + state.get().arr.capacity() + (state.get().flags.get(3) ? 1 : 0) + (state.get().m.value(0).flags.get(40) ? 1 : 0) + state.get().l.element(0).tag;`,
    ),
    "a by-value element is a temporary, so its members stay mutable": constView(`state.mut().coll.element(0).flags.set(1, true);`),
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

    for (const [name, { source, diagnostic }] of Object.entries(REFUSED)) {
        test(
            name,
            async () => {
                const { errors } = await ourErrors(source);
                expect(errors.length).toBeGreaterThan(0);
                // Refused for the stated reason, not by an unrelated lowering failure.
                if (diagnostic) expect(errors.map((error) => error.message).join("\n")).toMatch(diagnostic);
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
