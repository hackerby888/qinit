# Browser Compiler Packaging and Local Source Development

## Summary

Qinit commits only a pinned core manifest. CI and local development generate the QPI header
snapshot from a core-lite checkout. Qinit-web uses the same `@qinit/compile/browser` import
everywhere: Vite resolves it directly to the sibling Qinit source in local development and to
the pinned npm package in production.

## Qinit changes

- Add `packages/compile/core-snapshot.json` containing the immutable core repository, commit
  SHA, generator version, and expected snapshot hash.
- Extract the existing header assembly logic into one Node-only snapshot generator shared by
  `loadQpiHeader`, local preparation, and release CI. It must include the prelude, contract
  indices, oracle includes, and implementation chunks.
- Generate `packages/compile/.generated/qpi-snapshot.txt`; gitignore it and fail clearly when a
  browser build starts without it.
- Add `@qinit/compile/browser`, which embeds the generated snapshot and calls the compiler
  without requiring callers to provide `qpiHeader`.
- Export compiler metadata containing the Qinit version, core commit, actual snapshot hash, and
  compiler protocol version.
- Keep explicit `qpiHeader` override support for compiler tests and compatibility experiments.

## Development and production resolution

- Qinit-web always imports `@qinit/compile/browser`.
- Local Vite dev defaults to `QINIT_SOURCE=local`, aliases the import to
  `${QINIT_LOCAL}/packages/compile/src/browser.ts`, and allows that sibling directory through
  Vite's filesystem configuration.
- `QINIT_LOCAL` defaults to the existing sibling `../../Qinit`; `QINIT_CORE` defaults to the
  sibling `../../qubic-core-lite`. Either may be overridden.
- Qinit-web's local dev command first invokes Qinit's snapshot preparation using `QINIT_CORE`,
  then starts Vite. Missing repositories are hard errors; it must not silently fall back to npm
  or a handwritten QPI header stub.
- Snapshot preparation caches by actual input-content hash so dirty local core header edits are
  detected. A watch mode regenerates the snapshot when relevant headers change.
- Production builds use `QINIT_SOURCE=package`, disable the compiler source alias, and resolve
  an exact, lockfile-pinned `@qinit/compile` npm version.
- The compiler is imported inside a Vite Web Worker. Vite and Cloudflare Pages produce and serve
  the content-hashed worker chunk; no runtime compiler manifest or separate header request is
  required.

## Release CI and IDE integration

- A `qinit-compile-v*` workflow checks out the exact core commit from `core-snapshot.json`,
  regenerates and verifies the snapshot, runs compiler parity/corpus tests, builds the browser
  package, runs a browser compile smoke test, and publishes `@qinit/compile`.
- CI fails if the generated snapshot hash differs from the manifest, the browser bundle accesses
  Node APIs, or a representative contract cannot compile and execute.
- Qinit-web production CI installs the exact npm release, builds the SPA, runs its IDE smoke
  test, and deploys `frontend/dist` to Cloudflare Pages with Wrangler.
- The IDE compile facade routes contract builds and core-lite `ContractTesting` gtests through the local
  worker. `TEST` bodies and fixture methods use the normal parser, typed IR, and Wasm codegen; only virtual-node
  operations use the private `qtest` host ABI. Native clang remains the authoritative CLI/CI gtest backend.
- Local WASM crosses the worker boundary as a transferable ArrayBuffer. The worker result is
  normalized to the IDE's existing rich IDL instead of casting the compiler's minimal ABI
  metadata.

## Test plan

- Verify local Vite resolution loads the sibling Qinit source and reflects compiler changes
  without npm publication.
- Verify production resolution uses node_modules and succeeds without Qinit or core-lite
  sibling checkouts.
- Compile and execute Counter through the worker; validate diagnostics, WASM, rich IDL, and
  exported snapshot metadata.
- Test multi-contract callee metadata and header-dependent containers/oracle types.
- Confirm missing local paths, missing generated snapshots, hash mismatch, and worker startup
  failure produce clear errors or the defined backend fallback.
- Run a headless Cloudflare-style production build smoke using the published package.

## Assumptions

- Only `core-snapshot.json` is committed; generated header content and browser bundles are not.
- npm is used only for production/production-parity builds; normal local development imports
  the sibling Qinit checkout directly.
- Core release pins are immutable commit SHAs, never moving branches.
- Existing unrelated changes in the Qinit compiler worktree remain untouched.
