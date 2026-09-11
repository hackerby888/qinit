import { defineConfig } from "@vscode/test-cli";

// One entry per workspace: a config pins exactly one workspaceFolder, and the campaign needs several.
// Select one with `vscode-test --label zoo`.
export default defineConfig([
    {
        label: "ws",
        files: "test-integration/*.itest.js",
        workspaceFolder: "test-fixtures/ws",
        installExtensions: ["llvm-vs-code-extensions.vscode-clangd"],
        mocha: { ui: "tdd", timeout: 120000 },
    },
    {
        label: "zoo",
        files: "test-integration/campaign/*.itest.js",
        workspaceFolder: "test-fixtures/zoo",
        installExtensions: ["llvm-vs-code-extensions.vscode-clangd"],
        mocha: { ui: "tdd", timeout: 180000 },
    },
]);
