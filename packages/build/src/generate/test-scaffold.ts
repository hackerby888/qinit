// Self-contained test SDK source (codec + tx + rpc + call + provider), generated from the canonical sources
// and inlined by Bun while it bundles Qinit. The generated client therefore has no dependencies at all.
import { generateRuntimeMacro } from "../../scripts/gen-runtime" with { type: "macro" };

export const testRuntimeSource: string = generateRuntimeMacro();
