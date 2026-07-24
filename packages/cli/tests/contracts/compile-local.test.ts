import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_PATH } from "../../../../test-utils/paths";
import { compileLocal } from "../../src/compile-local";

const MAIN = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct Read_input { Relay::Payload value; };
  struct Read_output { uint64 value; };
  struct Read_locals {
    Relay::Read_input relayInput;
    Relay::Read_output relayOutput;
  };
  PUBLIC_FUNCTION_WITH_LOCALS(Read) {
    CALL_OTHER_CONTRACT_FUNCTION(Relay, Read, locals.relayInput, locals.relayOutput);
    output.value = locals.relayOutput.value;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
  }
};`;

const RELAY = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct Payload { Array<uint8, CONTRACT_INDEX> bytes; };
  struct Read_input { Mirror::Payload value; };
  struct Read_output { uint64 value; };
  struct Read_locals {
    Mirror::Read_input mirrorInput;
    Mirror::Read_output mirrorOutput;
  };
  PUBLIC_FUNCTION_WITH_LOCALS(Read) {
    CALL_OTHER_CONTRACT_FUNCTION(Mirror, Read, locals.mirrorInput, locals.mirrorOutput);
    output.value = locals.mirrorOutput.value;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
  }
};`;

const MIRROR = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct Payload { Array<uint8, CONTRACT_INDEX> bytes; };
  struct Read_input { Relay::Payload value; };
  struct Read_output { uint64 value; };
  struct Read_locals {
    Relay::Read_input relayInput;
    Relay::Read_output relayOutput;
  };
  PUBLIC_FUNCTION_WITH_LOCALS(Read) {
    CALL_OTHER_CONTRACT_FUNCTION(Relay, Read, locals.relayInput, locals.relayOutput);
    output.value = locals.relayOutput.value;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
  }
};`;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compileLocal analyzes transitive cyclic callees before one main build", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qinit-compile-local-"));
  temporaryDirectories.push(directory);

  const mainPath = join(directory, "Main.h");
  const relayPath = join(directory, "Relay.h");
  const mirrorPath = join(directory, "Mirror.h");
  const outDir = join(directory, "out");
  writeFileSync(mainPath, MAIN);
  writeFileSync(relayPath, RELAY);
  writeFileSync(mirrorPath, MIRROR);

  const result = await compileLocal({
    contractPath: mainPath,
    name: "Main",
    slot: 31,
    core: CORE_PATH,
    outDir,
    dynCallees: {
      Mirror: { header: mirrorPath, index: 30 },
      Relay: { header: relayPath, index: 29 },
    },
  });

  expect(result.stderr).toBeUndefined();
  expect(result.ok).toBe(true);
  expect(result.idl?.dependencies).toEqual(["Relay"]);
  expect(result.idl?.functions[0]?.inSize).toBe(29);
  expect(result.so).toBe(join(outDir, "Main.wasm"));
  expect(existsSync(result.so!)).toBe(true);
  expect(result.size).toBeGreaterThan(0);
}, 60_000);
