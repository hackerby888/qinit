export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(input: string, expectedLength?: number): Uint8Array {
  const hex = input.startsWith("0x") ? input.slice(2) : input;
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error(`invalid hex: '${input}'`);
  }

  const length = hex.length / 2;
  if (expectedLength !== undefined && length !== expectedLength) {
    throw new Error(`expected ${expectedLength}-byte hex, got ${length}`);
  }

  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
