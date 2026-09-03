// A diff window and a state layout built from a source snippet, shared by the diff tests: a case can sit
// anywhere in a 545 MB state without allocating one, and a new shape costs one line of C++.
import { extractIdl } from "@qinit/build";
import type { DebugStateRegion } from "@qinit/core";
import { stateFieldsOf, type StateField } from "../../src/trace/state-format";

export const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export function writeLe(bytes: Uint8Array, offset: number, value: number | bigint, width = 8) {
    let rest = BigInt.asUintN(width * 8, BigInt(value));
    for (let index = 0; index < width; index++) {
        bytes[offset + index] = Number(rest & 0xffn);
        rest >>= 8n;
    }
}

// A window carries its own bytes. `seed` fills the before image and `write` the after image, both at
// offsets relative to the window.
export function diffWindow(off: number, length: number, seed?: (bytes: Uint8Array) => void, write?: (bytes: Uint8Array) => void): DebugStateRegion {
    const before = new Uint8Array(length);
    seed?.(before);

    const after = before.slice();
    write?.(after);

    return { off, before: hex(before), after: hex(after) };
}

// A contract that holds only the state: `declarations` are the struct types the members need.
export const stateSource = (members: string, declarations = "") => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  ${declarations}
  struct StateData { ${members} };
  INITIALIZE() {}
};`;

export function fieldsOf(name: string, members: string, declarations = ""): StateField[] {
    return stateFieldsOf(extractIdl(stateSource(members, declarations), name, { slot: 7 }));
}

export const offsetOf = (fields: StateField[], name: string) => fields.find((field) => field.name === name)!.off;
