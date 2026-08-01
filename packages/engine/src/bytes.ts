const ZERO_ID = new Uint8Array(32);

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

export function first32BytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  for (let index = 0; index < 32; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

export function isZeroId(id: Uint8Array): boolean {
  return first32BytesEqual(id, ZERO_ID);
}
