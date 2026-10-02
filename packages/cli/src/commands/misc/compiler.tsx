import { COMPILER_BACKENDS, DEFAULT_COMPILER_BACKEND, savedCompilerBackend, setSavedCompilerBackend, type CompilerBackend } from "../../config";
import type { CommandArguments } from "../../args";
import { BackendPicker } from "./backend-picker";

const DESC: Record<CompilerBackend, string> = {
    clang: "clang / wasi-sdk (bit-exact; needs the toolchain installed)",
    typescript: "qinit typescript compiler (no toolchain; instant)",
};

export function CompilerCmd({ commandArgs }: { commandArgs: CommandArguments }) {
    return (
        <BackendPicker
            commandArgs={commandArgs}
            command="compiler"
            label="compiler"
            backends={COMPILER_BACKENDS}
            descriptions={DESC}
            current={savedCompilerBackend() ?? DEFAULT_COMPILER_BACKEND}
            width={8}
            save={setSavedCompilerBackend}
        />
    );
}
