// Run the extension-host suite with headless VS Code and clangd.
// Build `dist/extension.js` before starting the tests.
import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "test-integration/**/*.itest.js",
  workspaceFolder: "test-fixtures/ws",
  // The extension declares vscode-clangd as a hard dependency; install it so activation succeeds.
  installExtensions: ["llvm-vs-code-extensions.vscode-clangd"],
  mocha: { ui: "tdd", timeout: 120000 },
});
