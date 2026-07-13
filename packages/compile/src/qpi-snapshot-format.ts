import type { LiteAbiSource } from "@qinit/core/lite-abi-source";

// v6 embeds canonical core ABI metadata and orders parsed imports from that table.
export const GENERATOR_VERSION = 6;

export const IMPL_BOUNDARY = "//__QINIT_IMPL_BOUNDARY__";
export const LITE_ABI_MARKER = "//__QINIT_LITE_ABI__";

export function embeddedLiteAbi(headers: string): LiteAbiSource {
  const line = headers.split(/\r?\n/).find((value) => value.startsWith(LITE_ABI_MARKER));
  if (!line) throw new Error("QPI headers are missing embedded core ABI metadata");
  return JSON.parse(line.slice(LITE_ABI_MARKER.length)) as LiteAbiSource;
}
