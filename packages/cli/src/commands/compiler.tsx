import {
  COMPILER_BACKENDS,
  savedCompilerBackend,
  setSavedCompilerBackend,
  type CompilerBackend,
} from "../config";
import { BackendPicker } from "./backend-picker";

const DESC: Record<CompilerBackend, string> = {
  clang: "clang / wasi-sdk (bit-exact; needs the toolchain installed)",
  typescript: "in-process TypeScript compiler (no toolchain; instant)",
};

export function CompilerCmd({ args }: { args: string[] }) {
  return (
    <BackendPicker
      args={args}
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
