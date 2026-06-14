// @vscode/test-cli config: downloads a headless VS Code, installs the clangd dependency, loads this
// extension (--extensionDevelopmentPath defaults to cwd → needs `dist/extension.js` built first), and
// runs the mocha suite in the extension host against the fixture workspace.
import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "test-integration/**/*.itest.js",
  workspaceFolder: "test-fixtures/ws",
  // The extension declares vscode-clangd as a hard dependency; install it so activation succeeds.
  installExtensions: ["llvm-vs-code-extensions.vscode-clangd"],
  mocha: { ui: "tdd", timeout: 120000 },
});
