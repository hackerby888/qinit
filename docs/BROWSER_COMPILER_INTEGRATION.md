# Browser Compiler Packaging

## Browser entry

Browser applications import:

```ts
import {
  compileContract,
  compilerInfo,
  qpiSnapshot,
} from "@qinit/compile/browser";
```

The entry embeds `packages/compile/src/generated/qpi-snapshot.ts`; it does not
read files, spawn a compiler, or require a core-lite checkout at runtime.
`compileContract()` accepts an optional `qpiHeader` only for compatibility tests
and compiler development.

`compilerInfo` identifies the Qinit version, core commit, snapshot hash,
generator version, and compiler protocol version used by the bundle.

## Snapshot ownership

`config/repositories.json` selects the core source used by compatibility CI.
`packages/compile/core-snapshot.json` records the snapshot's source commit,
generator version, and expected hash. Qinit's snapshot generator is the only
supported way to update the generated module:

```bash
bun packages/compile/tools/gen-qpi-snapshot.ts \
  --core-dir /path/to/core-lite \
  --verify
```

Commit the manifest and generated module together. Normal browser contributors
do not need core-lite because both files are tracked.

## Local build

Use Bun 1.3.14:

```bash
bun install
(cd packages/core && bun run build)
(cd packages/proto && bun run build)
(cd packages/compile && bun run build)
bun packages/compile/tools/ci-browser-smoke.ts
```

The compile build emits ESM entry files under `dist/`. Browser compilation does
not execute Node-only file or process APIs.

The monorepo TypeScript configuration maps workspace imports to source during
development. Package export conditions resolve to built files in `dist/`.

## Distribution

The compile workspace is currently private and npm publication is paused.
Consumers should use the Qinit workspace or an explicitly pinned Qinit source
checkout. Reintroducing npm publication requires a reviewed public package
surface, a self-contained declaration contract, and a release workflow.

## Verification

CI and local packaging checks must verify:

- the tracked QPI snapshot matches its manifest;
- a browser can import and execute the compiler without Node APIs;
- a representative contract compiles and executes;
- `browser.d.ts` is emitted with the browser bundle;
- all source revisions used for compatibility checks are recorded.
