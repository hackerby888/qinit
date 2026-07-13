import { QPI_PRELUDE } from "../qpi-prelude";
import { assembleQpiHeader } from "../qpi-snapshot";

export function loadQpiHeader(corePath?: string): string {
  if (typeof process !== "undefined" && (process.versions?.bun || process.versions?.node)) {
    const configured = corePath ?? process.env.QINIT_CORE;
    if (!configured) {
      throw new Error("cannot load live qpi.h: pass a core-lite path or set QINIT_CORE");
    }
    return assembleQpiHeader(configured);
  }
  throw new Error(
    "cannot load live qpi.h in a browser; use @qinit/compile/browser so the generated core snapshot is supplied",
  );
}

export function withPrelude(headers: string): string {
  return QPI_PRELUDE + "\n" + headers;
}
