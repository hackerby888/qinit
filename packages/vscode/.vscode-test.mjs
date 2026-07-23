import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "test-integration/**/*.itest.js",
  workspaceFolder: "test-fixtures/ws",
  installExtensions: ["llvm-vs-code-extensions.vscode-clangd"],
  mocha: { ui: "tdd", timeout: 120000 },
});
