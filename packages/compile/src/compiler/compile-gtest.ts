import type { CompileOptions } from "./types";
import type { GtestCompileResult } from "./types";
import { compileCoreGtest } from "./gtest";

export function compileGtest(options: CompileOptions & {
    testSource: string;
}): Promise<GtestCompileResult> {
    return compileCoreGtest(options);
}
