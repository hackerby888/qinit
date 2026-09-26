# Log tag ambiguity — problem and fix

## Problem

A log is a numeric struct ending in `sint8 _terminator`. The bytes carry no name, so `decodeLog` identifies
the struct by **logged size**, then breaks ties on the `_type` word (`packages/proto/src/decode-log.ts:37-38`).
If two candidates survive, it returns hex with `name: null, fields: null` (`:64`).

Two same-size log structs that cannot be told apart by `_type` are therefore **permanently undecodable** —
no reader fix is possible. Measured across the 14 core-lite contracts that declare logs:

```
VOTTUNBRIDGE  EthBridgeLogger / TokensLogger        both 24 bytes, NEITHER has a _type field
QRAFFLE       RevenueLogger   / TokenRaffleLogger   both 56 bytes, _type set but not seen by the compiler
```

VottunBridge is broken today, in a shipped contract, silently.

QRaffle is a compiler bug, not a contract bug. Both structs set distinct `_type` constants, but via brace
initialization:

```cpp
locals.revenueLog = RevenueLogger{ QRAFFLE_CONTRACT_INDEX, QRAFFLE_revenueDistributed, ... };
```

`collectLogTypeValues` matches only `AstKind.ASSIGN` on `x._type = v`
(`packages/compiler/src/backend/wasm/idl/log-type-values.ts:40-48`), so brace init is invisible and
`types` stays empty. An empty set keeps the struct a candidate for every same-size log
(`decode-log.ts:71`).

A third case comes from one mislabelled call. `_type` values are collected by observation, so
`AlphaLog._type = KindBeta` in any procedure adds Beta's tag to `AlphaLog`, and the correct `BetaLog`
stops decoding contract-wide — even if that procedure never runs. Probe: `LogZoo.h` / `LogClean.h`.

## Fix

**1. Read brace-init `_type` values** in `log-type-values.ts:40-48`. Do this first — step 2 falsely rejects
QRaffle otherwise.

**2. Reject at build** in `contractLogs()`
(`packages/compiler/src/backend/wasm/idl/enums-and-logs.ts:50`), which already holds each log's name,
logged size (`terminator.offset`) and collected `types`. Per group of equal logged size, error if any pair
is indistinguishable:

```
neither struct has a _type field         -> error   (VottunBridge)
_type present but no foldable value      -> error
resolvable _type sets intersect          -> error   (the LogZoo mislabel)
```

**3. Report ambiguity in the decoder.** `decode-log.ts:64` returns the same empty record for "2 candidates",
"0 candidates" and "decode threw", so a caller reads an ambiguous tag as a malformed log. Already-deployed
contracts keep hitting this, so the reader still has to say which.

## Cost of step 2 on the real tree

14 contracts with logs, **0 tag collisions** — nothing that works today is rejected. Two contracts are
flagged: QRaffle (cured by step 1) and VottunBridge (genuinely unparseable, needs a contract change).

## Verify

- `LogZoo.h` fails the build; `LogClean.h` builds and decodes `AlphaLog`, `BetaLog`, `GammaLog`.
- QRaffle builds after step 1, and its two 56-byte logs decode to distinct names.
- VottunBridge fails the build, naming both structs and the shared size.
- Re-run the scan over all 14 contracts: no new rejections.
