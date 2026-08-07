import { QpiIncompleteReadError } from "./errors";

export interface QpiByteSource {
  readonly byteLength: number;
  readonly maxReadLength: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

function assertSourceRange(
  source: Pick<QpiByteSource, "byteLength">,
  offset: number,
  length: number,
): void {
  const end = offset + length;
  if (
    !Number.isSafeInteger(source.byteLength) ||
    source.byteLength < 0 ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    !Number.isSafeInteger(end) ||
    offset < 0 ||
    length < 0 ||
    end > source.byteLength
  ) {
    throw new QpiIncompleteReadError(
      `QPI byte range ${offset}..${end} exceeds ${source.byteLength} bytes`,
    );
  }
}

export async function readQpiBytes(
  source: QpiByteSource,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  assertSourceRange(source, offset, length);
  if (
    !Number.isSafeInteger(source.maxReadLength) ||
    source.maxReadLength <= 0
  ) {
    throw new Error("QPI byte source has an invalid maxReadLength");
  }
  if (!length) {
    return new Uint8Array();
  }

  const bytes = new Uint8Array(length);
  let completed = 0;
  while (completed < length) {
    const chunkLength = Math.min(
      source.maxReadLength,
      length - completed,
    );
    const chunk = await source.read(offset + completed, chunkLength);
    if (chunk.length !== chunkLength) {
      throw new QpiIncompleteReadError(
        `QPI byte source returned ${chunk.length} of ${chunkLength} bytes at ${offset + completed}`,
      );
    }
    bytes.set(chunk, completed);
    completed += chunkLength;
  }
  return bytes;
}

function byteArraySource(bytes: Uint8Array): QpiByteSource {
  return {
    byteLength: bytes.length,
    maxReadLength: Math.max(1, bytes.length),
    async read(offset, length) {
      assertSourceRange({ byteLength: bytes.length }, offset, length);
      return bytes.slice(offset, offset + length);
    },
  };
}

export function qpiSnapshotSource(bytes: Uint8Array): QpiByteSource {
  return byteArraySource(bytes.slice());
}

export function qpiBorrowedSource(bytes: Uint8Array): QpiByteSource {
  return byteArraySource(bytes);
}
