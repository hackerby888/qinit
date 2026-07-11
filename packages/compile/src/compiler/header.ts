import { QPI_PRELUDE } from "../qpi-prelude";
import { QPI_STUB } from "../qpi-stub";
import { assembleQpiHeader } from "../qpi-snapshot";

export function loadQpiHeader(corePath?: string): string {
  if (typeof process !== "undefined" && (process.versions?.bun || process.versions?.node)) {
    return assembleQpiHeader(corePath ?? "/home/kali/Projects/core-lite");
  }
  return QPI_PRELUDE + "\n" + QPI_STUB;
}

export function withPrelude(headers: string): string {
  return QPI_PRELUDE + "\n" + headers;
}
