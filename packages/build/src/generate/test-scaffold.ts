// Self-contained test SDK source (codec + tx + rpc + call + provider), generated from canonical sources and inlined by Bun, so the client has no dependencies.
import { generateRuntimeMacro } from "../../scripts/gen-runtime" with { type: "macro" };

export const testRuntimeSource: string = generateRuntimeMacro();
