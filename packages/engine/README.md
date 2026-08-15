# @qinit/engine

The Qinit contract simulation engine. It runs compiled QPI Wasm contracts
in-process in browsers, Node, and Bun. The package models ticks and epochs,
contract calls, balances, assets, oracles, consensus digests, logging, and the
dynamic-contract deployment protocol.

This workspace package is private while its standalone distribution contract is
being stabilized.

## Basic use

```ts
import { VirtualNode } from "@qinit/engine";

const node = await VirtualNode.create({ mempool: false });
const contract = node.deploy(wasmBytes, {
    name: "Counter",
    slot: 28,
});

const before = node.query(contract.slot, 1);
node.procedure(contract.slot, 1);
const after = node.query(contract.slot, 1);

node.advanceTick(1);
const digest = node.sim.digest(contract.slot);
```

`VirtualNode.create()` initializes the cryptography backend before returning.
Use `QubicSimulator` directly when a test only needs contract execution and does not need
the `NodeTransport` or deployment-wire surface.

## Entries

- `@qinit/engine` exports `VirtualNode`, `QubicSimulator`, contract runtime types, the
  contract-testing runners, crypto helpers, consensus types, and wire records.
- `@qinit/engine/server` exports the Bun HTTP adapter.
- `@qinit/engine/peer` exports the Bun TCP peer-protocol adapter.

The default entry is browser- and Node-safe. Server and peer entries use Bun
runtime APIs and are intentionally separate.

## Contract ABI

An executable contract module exports:

- `state_size() -> i32`
- `dispatch(kind, inputType, inOff, outOff, localsOff)`
- its shared Wasm memory

The engine writes the QPI call context and input into Wasm memory, invokes the
dispatcher, and reads the output. Host imports provide tick/epoch data,
balances, assets, inter-contract calls, logging, hashing, and abort handling.

## Build

From the repository root:

```bash
(cd packages/core && bun run build)
(cd packages/proto && bun run build)
(cd packages/engine && bun run build)
```

The build emits the browser-safe default bundle, Bun server and peer bundles,
and declarations under `dist/`.
