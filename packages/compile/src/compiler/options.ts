import { DiagnosticSeverity } from "../enums";
import type { Diagnostic as ParserDiagnostic } from "../parser";
import type { CompileOptions } from "./types";

const UINT32_MAX = 0xffff_ffff;
const MIN_INPUT_TYPE = 1;
const MAX_INPUT_TYPE = 65535;
const WASM32_SIZE = 0x1_0000_0000;
const MAX_COMPILER_NAME_LENGTH = 255;
const COMPILER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function optionDiagnostic(message: string): ParserDiagnostic {
  return {
    severity: DiagnosticSeverity.ERROR,
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
  const validInputType = (value: number) =>
    Number.isSafeInteger(value) &&
    value >= MIN_INPUT_TYPE &&
    value <= MAX_INPUT_TYPE;

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
    if (!validUint32(callee.slot))
      reject(`callee '${callee.name}' slot must be a uint32 integer`);
    if (calleeNames.has(callee.name)) reject(`duplicate callee name '${callee.name}'`);
    if (calleeIndices.has(callee.slot)) reject(`duplicate callee slot ${callee.slot}`);
    calleeNames.add(callee.name);
    calleeIndices.add(callee.slot);

    const entryNames = new Set<string>();
    for (const [kind, entries] of [
      ["function", callee.functions],
      ["procedure", callee.procedures],
    ] as const) {
      for (const entry of entries) {
        if (!validCompilerName(entry.name))
          reject(`${kind} name '${callee.name}::${entry.name}' is invalid`);
        if (entryNames.has(entry.name))
          reject(`duplicate callee entry '${callee.name}::${entry.name}'`);
        entryNames.add(entry.name);
        if (!validInputType(entry.inputType))
          reject(`${kind} '${callee.name}::${entry.name}' inputType must be in the range 1..65535`);
        if (!validSize(entry.inSize))
          reject(`${kind} '${callee.name}::${entry.name}' inSize must be a uint32 integer`);
        if (!validSize(entry.outSize))
          reject(`${kind} '${callee.name}::${entry.name}' outSize must be a uint32 integer`);
        if (entry.input?.size !== entry.inSize)
          reject(`${kind} '${callee.name}::${entry.name}' inSize does not match input layout`);
        if (entry.output?.size !== entry.outSize)
          reject(`${kind} '${callee.name}::${entry.name}' outSize does not match output layout`);
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
    if (
      calleeSource.slot !== undefined &&
      !validUint32(calleeSource.slot)
    ) {
      reject(
        `callee source '${calleeSource.name}' slot must be a uint32 integer`,
      );
    }

    const matchingCallee = (options.callees ?? []).find(
      (callee) => callee.name === calleeSource.name,
    );
    if (
      calleeSource.slot !== undefined &&
      matchingCallee &&
      calleeSource.slot !== matchingCallee.slot
    ) {
      reject(
        `callee source '${calleeSource.name}' slot does not match its callee IDL`,
      );
    }
  }

  return diagnostics;
}
