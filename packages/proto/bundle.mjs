// Build @qinit/proto to dist/ for Node consumers (the `import` export condition; Bun/vite use the TS source
// directly). @qinit/core is aliased to its node-free browser entry and bundled in (proto only uses core's
// codec/identity/rpc surface, all of which browser.ts exports); the sync signer is stubbed out so the dist
// has no dependencies. Types are emitted separately by tsc (see the build script).
import { resolve } from "node:path";

const coreBrowser = resolve(import.meta.dir, "../core/src/browser.ts");
const signSyncStub = resolve(import.meta.dir, "../core/src/crypto/sign-sync-stub.ts");

const aliasCoreBrowser = {
    name: "alias-qinit-core-browser",
    setup(build) {
        build.onResolve({ filter: /^@qinit\/core$/ }, () => ({ path: coreBrowser }));
        build.onResolve({ filter: /sign-sync-esm$/ }, () => ({ path: signSyncStub }));
    },
};

const r = await Bun.build({
    entrypoints: ["src/index.ts", "src/qpi-layout.ts", "src/contract-idl.ts"],
    outdir: "dist",
    format: "esm",
    target: "node",
    external: [],
    plugins: [aliasCoreBrowser],
});

if (!r.success) {
    for (const log of r.logs) {
        console.error(log);
    }
    process.exit(1);
}

console.log("built dist/index.js + dist/qpi-layout.js + dist/contract-idl.js");
