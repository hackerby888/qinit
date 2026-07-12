import { QPI_PRELUDE } from "../qpi-prelude";
import { QPI_STUB } from "../qpi-stub";
import { assembleQpiHeader } from "../qpi-snapshot";

export function loadQpiHeader(corePath?: string): string {
  if (typeof process !== "undefined" && (process.versions?.bun || process.versions?.node)) {
    const configured = corePath ?? process.env.QINIT_CORE;
    if (!configured) {
      throw new Error("cannot load live qpi.h: pass a core-lite path or set QINIT_CORE");
    }
    return assembleQpiHeader(configured);
  }
  return QPI_PRELUDE + "\n" + QPI_STUB;
}

export function withPrelude(headers: string): string {
  return QPI_PRELUDE + "\n" + headers;
}
