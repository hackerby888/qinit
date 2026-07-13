import type { Diagnostic as ParserDiagnostic } from "../parser";
import type { CompileOptions } from "./types";

const UINT32_MAX = 0xffff_ffff;
const WASM32_SIZE = 0x1_0000_0000;
const MAX_COMPILER_NAME_LENGTH = 255;
const COMPILER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function optionDiagnostic(message: string): ParserDiagnostic {
  return {
    severity: "error",
    message: `Invalid compiler option: ${message}`,
    span: { start: 0, end: 0, line: 0, column: 0 },
  };
}

function validCompilerName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_COMPILER_NAME_LENGTH && COMPILER_NAME.test(name);
}

export function validateCompileOpts(options: CompileOptions): ParserDiagnostic[] {
  const diagnostics: ParserDiagnostic[] = [];
  const reject = (message: string) => diagnostics.push(optionDiagnostic(message));
  const validUint32 = (value: number) =>
    Number.isSafeInteger(value) && value >= 0 && value <= UINT32_MAX;
  const validSize = (value: number) =>
    Number.isSafeInteger(value) && value >= 0 && value <= UINT32_MAX;

  if (typeof options.source !== "string") reject("source must be a string");
  if (!validCompilerName(options.name)) {
    reject(`name must be a C++ identifier of at most ${MAX_COMPILER_NAME_LENGTH} characters`);
  }
  if (!validUint32(options.slot)) reject("slot must be a uint32 integer");

  const arenaSz = options.arenaSz ?? 1024 * 1024 * 1024;
  if (!validSize(arenaSz) || arenaSz === 0) reject("arenaSz must be a positive wasm32 byte size");

  if (options.sharedMemBase !== undefined) {
    if (!validSize(options.sharedMemBase)) {
      reject("sharedMemBase must be a wasm32 byte offset");
    } else {
      if ((options.sharedMemBase & 7) !== 0) reject("sharedMemBase must be 8-byte aligned");
      if (validSize(arenaSz) && options.sharedMemBase + arenaSz > WASM32_SIZE) {
        reject("sharedMemBase plus arenaSz exceeds wasm32 address space");
      }
    }
  }

  const calleeNames = new Set<string>();
  const calleeIndices = new Set<number>();
  for (const callee of options.callees ?? []) {
    if (!validCompilerName(callee.name)) reject(`callee name '${callee.name}' is invalid`);
    if (!validUint32(callee.index))
      reject(`callee '${callee.name}' index must be a uint32 integer`);
    if (calleeNames.has(callee.name)) reject(`duplicate callee name '${callee.name}'`);
    if (calleeIndices.has(callee.index)) reject(`duplicate callee index ${callee.index}`);
    calleeNames.add(callee.name);
    calleeIndices.add(callee.index);

    const entryNames = new Set<string>();
    for (const [kind, entries] of [
      ["function", callee.functions],
      ["procedure", callee.procedures],
    ] as const) {
      for (const [entryName, entry] of Object.entries(entries)) {
        if (!validCompilerName(entryName))
          reject(`${kind} name '${callee.name}::${entryName}' is invalid`);
        if (entryNames.has(entryName))
          reject(`duplicate callee entry '${callee.name}::${entryName}'`);
        entryNames.add(entryName);
        if (!validUint32(entry.inputType))
          reject(`${kind} '${callee.name}::${entryName}' inputType must be a uint32 integer`);
        if (!validSize(entry.inSize))
          reject(`${kind} '${callee.name}::${entryName}' inSize must be a uint32 integer`);
        if (!validSize(entry.outSize))
          reject(`${kind} '${callee.name}::${entryName}' outSize must be a uint32 integer`);
      }
    }
  }

  const sourceNames = new Set<string>();
  for (const calleeSource of options.calleeSources ?? []) {
    if (!validCompilerName(calleeSource.name))
      reject(`callee source name '${calleeSource.name}' is invalid`);
    if (sourceNames.has(calleeSource.name))
      reject(`duplicate callee source '${calleeSource.name}'`);
    sourceNames.add(calleeSource.name);
    if (!calleeNames.has(calleeSource.name))
      reject(`callee source '${calleeSource.name}' has no matching callee IDL`);
    if (typeof calleeSource.source !== "string")
      reject(`callee source '${calleeSource.name}' must be a string`);
  }

  return diagnostics;
}
