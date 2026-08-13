import {
    COMPILER_BACKENDS,
    savedCompilerBackend,
    setSavedCompilerBackend,
    type CompilerBackend,
} from "../../config";
import type { CommandArguments } from "../../args";
import { BackendPicker } from "./backend-picker";

const DESC: Record<CompilerBackend, string> = {
    clang: "clang / wasi-sdk (bit-exact; needs the toolchain installed)",
    typescript: "in-process TypeScript compiler (no toolchain; instant)",
};

export function CompilerCmd({ commandArgs }: { commandArgs: CommandArguments }) {
    return (
        <BackendPicker
            commandArgs={commandArgs}
            command="compiler"
            label="compiler"
            backends={COMPILER_BACKENDS}
            descriptions={DESC}
            current={savedCompilerBackend() ?? "clang"}
            width={8}
            save={setSavedCompilerBackend}
        />
    );
}
