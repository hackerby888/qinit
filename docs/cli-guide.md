# Qinit CLI Maintainer Guide

> **Scope** — everything `packages/cli` does, from `process.argv` to the exit code, plus the
> `@qinit/core` RPC and cache boundaries it leans on.
> **Read when** — changing a command, an option, deployment, state/trace decoding, node startup, or
> anything whose failure mode is "works under `bun run dev`, breaks in the binary".
> **Related** — [compiler walkthrough](./compiler-walkthrough.md) for what `build` invokes;
> [browser packaging](./browser-packaging.md) for the non-CLI compiler entry.

This guide explains the CLI as a maintainer would need to understand it: where a
command enters, how its arguments become typed options, which package owns each
piece of work, what touches the filesystem or node, how results reach the
terminal, and which invariants are easy to break.

It describes the current `main` behavior. Paths and current sharp edges are
intentionally explicit so future changes can be checked against this baseline.

The TypeScript compiler itself is covered separately in the
[compiler walkthrough](./compiler-walkthrough.md). This document follows
the CLI down to package boundaries, but does not repeat the compiler internals.

## 1. The whole CLI in one picture

For an ordinary command, the control flow is:

```text
shell argv
    |
    v
packages/cli/src/index.tsx
    |  split command from remaining args
    |  load theme and output mode
    v
packages/cli/src/app.tsx
    |  aliases, parseCommandInvocation(), help interception, HANDLERS lookup
    v
packages/cli/src/commands/<group>/<command>.tsx
    |  receives the already-parsed CommandArguments
    |  resolve project and user configuration
    |  run work from a React effect or input handler
    v
CLI domain folders
    |  ops/, contracts/, trace/, ui/, config
    v
workspace packages
    |  @qinit/build, @qinit/compiler, @qinit/proto,
    |  @qinit/core, @qinit/engine
    v
node RPC / child process / filesystem
    |
    v
command state -> Ink view or explicit JSON -> exit code -> Ink exit()
```

The hidden simulator command is the exception:

```text
qinit __serve
    -> index.tsx parses its private flags
    -> serveEngine()
    -> EngineServer + VirtualNode
    -> no Ink, no normal command router, no normal exit
```

### Package ownership

| Package                                     | What the CLI expects it to own                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [`packages/cli`](../packages/cli)           | Command routing, argument policy, configuration, terminal UI, orchestration                                          |
| [`packages/core`](../packages/core)         | RPC client, signing, Qubic primitives, cache/downloads, core path resolution                                         |
| [`packages/build`](../packages/build)       | Clang and TypeScript build adapters, dependency graphs, slot planning, IDL, source generation, protocol verification |
| [`packages/compiler`](../packages/compiler) | In-process TypeScript-to-Wasm compiler and source analysis                                                           |
| [`packages/proto`](../packages/proto)       | ABI input/output codecs and deployment/call wire formats                                                             |
| [`packages/engine`](../packages/engine)     | In-process simulator, HTTP server, and gtest execution                                                               |

The CLI should orchestrate these packages rather than duplicate their domain
logic. For example, `commands/deploy-interact/deploy.tsx` owns display state,
while `ops/deploy/` owns the deployment state machine and `@qinit/proto` owns
the wire encoding.

### Source layout

`packages/cli/src` separates four concerns: entry/routing at the root, one
folder per command group, and sibling domain folders for everything a command
should not implement itself.

```text
packages/cli/src/
  index.tsx  app.tsx  meta.ts  args.ts  config.ts  version.ts
  commands/setup/             setup doctor clean update uninstall
  commands/node/              node node-run tick epoch
  commands/develop/           new integrate dev build gen verify
  commands/deploy-interact/   deploy call call-interactive ls state debug seed system test gtest
                              explorer/{index,chrome,find,overview,tick,identity,contracts}
  commands/editor/            ext
  commands/misc/              runtime compiler theme cheat smoke version help backend-picker
  ops/                        deploy/{index,steps,upload} project-build project-deploy
                              node node-core cache update serve corpus-run typescript-build
  contracts/                  registry templates idl-file idl-lookup callees state-digest system-wasm
  trace/                      format views
  ui/                         index (barrel) theme format hooks layout feedback data prompt
```

A command directory is the kebab-cased `META[command].group`, so the tree
matches the groups `qinit help` prints. Rendering belongs in
`commands/<group>/*.tsx`; anything two commands share belongs in `ops/`,
`contracts/`, `trace/`, or `ui/`.

`packages/core/src` follows the same shape:

```text
packages/core/src/
  index.ts  browser.ts  project.ts
  codec/struct.ts
  crypto/{qubic,tx,bytes}.ts
  debug/{log,backtrace}.ts
  net/{http,transport}.ts   net/rpc/{types,client}.ts
  cache/{paths,download,manifest,cli-release,verify-tool,wasi-sdk}.ts
  wasm/{lhost-abi,headers,abi-source,abi-node,slot-layout,slot-layout-node,slot-layout-source}.ts
  wasm/generated/{wasm-abi,wasm-slot-layout}.ts
```

`packages/core/package.json` exports `"./*": "./src/*.ts"`, so a deep import
names the folder: `@qinit/core/wasm/headers`, `@qinit/core/crypto/tx`.
`project.ts` deliberately stays at the root and re-exports `readCurrent`,
`currentPath`, `cacheRoot`, and `wasiSdkPaths` because it is the Bun-free entry
the VS Code extension imports.

## 2. Process startup and routing

The executable entry is [`packages/cli/src/index.tsx`](../packages/cli/src/index.tsx).
The standalone binary is built from this same file.

### 2.1 Splitting `process.argv`

The key line is:

```ts
const [, , command = "help", ...args] = process.argv;
```

For:

```bash
qinit build contracts/Counter.h --json
```

the values are:

```ts
command === "build";
args === ["contracts/Counter.h", "--json"];
```

This explains a commonly confusing call:

```ts
parseCommandInvocation("build", args);
```

`"build"` is not being parsed as another command-line token. It is the key used
to find `META.build` and therefore learn which options are valid. `args` contains
the actual tokens that remain after the executable and command were removed.

Commands no longer parse their own arguments: `app.tsx` parses once and passes
the resulting `CommandArguments` down as a prop.

### 2.2 Startup order

`index.tsx` performs these operations in order:

1. Install process-level handlers for unhandled rejections and uncaught
   exceptions.
2. Apply the saved theme before the first render.
3. Split `command` and `args`.
4. Short-circuit into `__serve` when starting the detached simulator.
5. Call `initOutput(args)` so components know whether they are rendering for a
   TTY, plain stream, or JSON consumer.
6. Render `<App command={command} args={args} />` with Ink.
7. Await Ink's `waitUntilExit()`.

The process-level error handler writes one line to stderr and calls
`process.exit(1)`. It is the last safety net, not the preferred command error
path.

### 2.3 The router

[`packages/cli/src/app.tsx`](../packages/cli/src/app.tsx) resolves a canonical
name, parses once, then looks the component up in `HANDLERS` — a record keyed by
`CommandName` and constrained by
`satisfies Record<CommandName, CommandHandler>`, so a command in `META` with no
handler is a type error.

`CommandRoute` does, in order:

- `canonicalCommand()` — the name itself, or an `ALIASES` entry (`cheat` and
  `--cheat-sheet` to `cheat-sheet`, `--version`/`-v` to `version`,
  `--help`/`-h` to `help`);
- an unknown name renders help plus a suggestion: the removed `up` command maps
  to `node run`, everything else uses edit distance over canonical names;
- `parseCommandInvocation(canonical, args)` — subcommand detection and strict
  option parsing for every command, including ones whose handler ignores args;
- `--help`/`-h` on any command renders metadata-derived usage for the resolved
  command and subcommand;
- `HANDLERS[canonical](invocation)`.

Because parsing happens before the help check, an unknown option is rejected
even alongside `--help`:

```bash
qinit build --help --not-a-real-flag
# ✗ invalid arguments: Unknown option '--not-a-real-flag'
```

Routing and metadata are two separate registries. Adding a command requires both
a `META` entry and an import plus a `HANDLERS` entry in `app.tsx`.

### 2.4 Render errors versus asynchronous errors

`App` wraps the selected component in a React error boundary.

- Strict parser errors and other render-time throws are displayed by `Crash`.
- Errors whose code starts with `ERR_PARSE_ARGS_` become a clean
  `invalid arguments` message and a help hint.
- Other render-time failures become `qinit crashed`.
- The boundary sets exit code 1 and exits Ink.

React error boundaries do not catch a rejected promise from an effect or input
handler. Commands are expected to catch their asynchronous work themselves. If
they do not, the process-level handlers in `index.tsx` terminate the process.

## 3. Command metadata and strict arguments

[`packages/cli/src/meta.ts`](../packages/cli/src/meta.ts) defines every canonical
command's summary, group, usage, options, examples, and advertised JSON support.

Metadata currently drives three things:

1. Option definitions for strict parsing.
2. Global and per-command help.
3. Canonical names used by typo suggestions.

It does not route commands or implement JSON output.

### 3.1 What `parseCommandInvocation()` does

[`packages/cli/src/args.ts`](../packages/cli/src/args.ts) contains:

```ts
parseCommandInvocation(command, args);
```

It detects the subcommand, calls `commandOptions(command, subcommand)`,
partitions the metadata into ordinary strings, booleans, and repeatable strings,
then calls `parseArgs()`. `parseArgs()` adds three universal definitions:

- `--help` and `-h`;
- `--json`;
- `--plain`.

Parsing itself is delegated to strict `node:util.parseArgs` with positionals
allowed. Unknown flags and missing string values throw.

The return shape is:

```ts
interface CommandInvocation {
    readonly command: CommandName;
    readonly subcommand?: string;
    readonly commandArgs: CommandArguments;
}

interface CommandArguments {
    readonly positionals: readonly string[];
    has(name: string): boolean;
    get(name: string): string | undefined;
    getAll(name: string): readonly string[];
}
```

`CommandArguments` is accessor-only: there is no `flags` or `multi` object to
read directly, and `get()` has no default-value parameter — commands write
`commandArgs.get("rpc") || DEFAULT_RPC_BASE`.

Subcommand detection is `findSubcommandCandidate()`: for a command whose `META`
entry has `subcommands`, it runs a non-strict tokenizing pass over the union of
the command's and every subcommand's options, then takes the first positional
token. That token becomes the subcommand only if `META` declares it, and it is
removed from the args before the strict pass. So options may precede the
subcommand, and `--restart` is still correctly rejected for `node status`.

### 3.2 A complete parsing example

Given:

```bash
qinit build contracts/Counter.h \
  --contract-name Counter \
  --rpc http://127.0.0.1:8080 \
  --callee Token=contracts/Token.h@7 \
  --callee=Oracle=contracts/Oracle.h@8 \
  --skip-verify \
  --json
```

`app.tsx` parses once and renders `<Build commandArgs={commandArgs} />`. The
component reads:

```ts
commandArgs.positionals; // ["contracts/Counter.h"]
commandArgs.get("contract-name"); // "Counter"
commandArgs.get("rpc"); // "http://127.0.0.1:8080"
commandArgs.has("skip-verify"); // true
commandArgs.has("json"); // true
commandArgs.getAll("callee");
// ["Token=contracts/Token.h@7", "Oracle=contracts/Oracle.h@8"]
```

The invariants to remember are:

- Positionals remain ordered in `positionals`.
- A boolean is presence-only. Test it with `has()`; `get()` never returns a
  value for one.
- Repeatable strings are read with `getAll()`, which returns `[]` when absent.
  `get()` never returns a repeatable option's value.
- An option that was not supplied is absent from all three accessors; there is
  no `undefined` versus empty-string distinction to defend against.
- `help` is part of the invocation, not the command's business: `app.tsx`
  intercepts it before the handler runs.
- `--` ends option parsing.
- Only help has a short form.

### 3.3 The command groups

`GROUP_ORDER` in `meta.ts` is the print order, and the directory is the kebab-cased group.

| Workflow                   | `META` group        | Directory                   | Commands                                                                                |
| -------------------------- | ------------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| Install and maintain qinit | `setup`             | `commands/setup/`           | `setup`, `doctor`, `clean`, `self-update`, `uninstall`                                  |
| Run the dev chain          | `node`              | `commands/node/`            | `node`, `tick`, `epoch`                                                                 |
| Develop                    | `develop`           | `commands/develop/`         | `new`, `integrate`, `dev`, `build`, `gen`, `verify`                                     |
| Deploy and interact        | `deploy & interact` | `commands/deploy-interact/` | `deploy`, `call`, `seed`, `ls`, `state`, `explorer`, `debug`, `test`, `gtest`, `system` |
| Editor integration         | `editor`            | `commands/editor/`          | `ext`                                                                                   |
| Miscellaneous              | `misc`              | `commands/misc/`            | `runtime`, `compiler`, `theme`, `cheat-sheet`, `version`, `help` (plus hidden `smoke`)  |

Within a group, commands print in `META` declaration order — `Help` filters `COMMANDS`, which is
`Object.keys(META)`. Keep a new entry beside its group's other entries.

`hidden: true` on a `META` entry keeps a command out of the help listing and out of typo suggestions
while leaving it routed and strictly parsed — for internals nobody should discover, like `smoke`, the
guard that proves wasm crypto still works in the compiled binary.

## 4. Configuration and persistent state

There is no single merged configuration object. Each command owns its precedence
rules using helpers from [`packages/cli/src/config.ts`](../packages/cli/src/config.ts)
and [`packages/core/src/project.ts`](../packages/core/src/project.ts).

### 4.1 Project configuration

`loadConfig()` reads exactly `./qinit.json`; it does not search parent
directories. Its current shape is:

```ts
interface QinitConfig {
    contractName?: string;
    contract?: string;
    slot?: number;
    coreDir?: string;
    rpc?: string;
    system?: string[];
}
```

Missing or malformed JSON silently produces `{}`, and values are not schema
validated. Typical command precedence is:

```text
CLI option -> positional where supported -> qinit.json -> built-in default
```

Exact details remain command-owned. For example, build's contract default is
`fixtures/Counter.h`, while deploy requires a path from CLI or config.

Core headers resolve through `resolveCoreDir()` in this order:

```text
--core-dir
-> qinit.json coreDir
-> QINIT_CORE
-> current.coreHeaders in the Qinit cache
-> actionable error
```

### 4.2 User preferences

The user configuration directory is:

```text
$XDG_CONFIG_HOME/qinit                     when XDG_CONFIG_HOME is set
%APPDATA%/qinit                            on Windows
~/.config/qinit                            otherwise
```

It contains independent files:

| File               | Meaning                         | Default       |
| ------------------ | ------------------------------- | ------------- |
| `seed`             | Saved 55-character signing seed | none          |
| `theme`            | Ink color theme                 | default theme |
| `runtime`          | `core` or `simulator`           | `core`        |
| `compiler-backend` | `clang` or `typescript`         | `clang`       |

The seed is written with mode `0600` where the platform honors Unix modes.
Signing seed resolution is:

```text
explicit validated seed
-> saved seed
-> node's development funded seed
-> "a" repeated 55 times
```

The final value is a development fallback, not a production secret.

Before signing, `deploy` and `call --proc` read the resolved signer's balance
([`resolveFundedSigner()`](../packages/cli/src/ops/signer.ts)). A node accepts a
transaction from an identity with no balance and then drops it at tick assembly, so an
empty signer used to surface only as work that never landed. A balance of zero now
switches to the node's funded seed with a note — except for a seed passed as `--seed`,
which is reported rather than replaced. An unreadable balance changes nothing.

### 4.3 Cache and current pointer

The cache root is `$QINIT_CACHE` or `~/.cache/qinit`. `current.json` separately
tracks header, node, and verifier versions and paths so updating one does not
erase the others.

Typical contents are:

```text
~/.cache/qinit/
  current.json
  <version>/core-headers/
  <version>/node/Qubic[.exe]
  <headersVersion>/system-wasm/<compiler>/
  wasi-sdk/
  tools/contractverify[.exe]
  run/
```

`qinit clean` removes this cache. It does not remove the user configuration
directory or saved seed.

## 5. Ink, plain output, JSON, and exit status

[`packages/cli/src/ui/index.ts`](../packages/cli/src/ui/index.ts) owns shared terminal
components and the mutable theme. It is a deliberate barrel over
`theme`/`format`/`hooks`/`layout`/`feedback`/`data`/`prompt`: those modules are
seams, not separate entry points, so commands import from `…/ui` and get the
whole kit. [`packages/cli/src/trace/views.tsx`](../packages/cli/src/trace/views.tsx)
owns the shared decoded trace and state views.

`ui/` stays generic. A widget that needs contract or IDL types belongs to the
command instead — which is why the generic `Select` and `TextPrompt` live in
`ui/prompt.tsx` while `SchemaBox`, `completerFor`, and `tmplOf` stay in
`call-interactive.tsx`.

`initOutput()` mutates one shared object before rendering:

```text
--json       -> output.json = true, output.plain = true
--plain      -> output.plain = true
non-TTY      -> output.plain = true
NO_COLOR     -> output.plain = true
```

Plain mode still renders through Ink. It removes decorative treatments and
animated frame timers; it does not turn every command into a line-oriented or
structured command.

JSON is also not automatic. A command must explicitly:

1. Check `output.json`.
2. Write exactly one JSON result to stdout.
3. Return no Ink view for that mode.
4. Set the correct exit status.
5. Exit Ink.

The common one-shot component lifecycle is:

```text
render
  -> parse arguments synchronously
  -> initial spinner state
  -> mount effect performs async work inside try/catch
  -> result is placed in component state
  -> completion effect optionally writes JSON
  -> process.exitCode is set
  -> useApp().exit()
  -> index.tsx waitUntilExit() resolves
```

Interactive components instead remain mounted and use `useInput()`. Important
examples are `call` without an explicit mode, `state` without a target, `debug`,
`explorer`, the runtime/theme/compiler selectors, and `seed`. `dev` is
deliberately long-lived.

Only one component may own the keyboard at a time, so a view that mounts a
prompt has to stop handling keys itself while the prompt is up — see the
`searching` flag in the explorer shell.

`Select` is the strict case: it owns every key while mounted, escape
included, because `/` opens a filter that escape has to close. Ink delivers
each keypress to every mounted `useInput`, so a caller that also bound escape
would pop its own stage on the keypress that was only meant to leave the
search. Both callers therefore stand down — `call-interactive` narrows its
handler to the three prompt stages, `state` returns outright while
`phase === "pick"` — and get escape back through `Select`'s required
`onCancel`. That is also why `q` no longer quits `state`'s picker: it was an
alias for escape, and a filter needs the letter.

The list is windowed to `rows - 1 - reserve - 4` (`windowOf` in
`ui/format.ts`), because ink clears and reprints the whole screen once a frame
reaches the terminal height — `>=`, not `>`. That budget assumes one terminal
row per item, so every row carries `wrap="truncate"`; a wrapped row would
silently cost two. `reserve` is what the caller draws above the picker,
defaulting to a `Header` and its margin.

`TextPrompt` takes an `isActive` prop for the case where a single screen shows
several fields at once: every field stays mounted and rendered, but only the
focused one subscribes to `useInput`. The explorer's wallet is the first form
built this way, and it also shows the other two prompt props — `onChange`, which
lifts the live value out so the owner can validate as the user types, and
`hint`, the line drawn under the field.

Exit behavior is decentralized. Every new or changed command must be reviewed
for success, handled failure, parser failure, JSON mode, and non-TTY behavior.

## 6. How the CLI knows about contracts

Most interaction commands need three different kinds of metadata:

1. A slot and runtime registration from the node.
2. Source code for names and layouts.
3. A typed IDL for input, output, state, and logs.

### 6.1 User and system contract catalogs

[`packages/cli/src/contracts/registry.ts`](../packages/cli/src/contracts/registry.ts) exposes
`loadContracts()`:

```text
user contracts
  <- LiteRpc.dynRegistry()
  <- only armed entries

system contracts
  <- @qinit/build systemContracts(resolvedCoreDir)
  <- parsed from the local/cached core source snapshot
```

If RPC is down, the system catalog can still load. User contracts cannot.
`resolveContract()` searches user contracts first, then system contracts, and
accepts a case-insensitive name or numeric slot.

### 6.2 The local IDL artifact

Successful deployment writes [`qinit.idl.json`](../packages/cli/src/contracts/idl-file.ts)
in the current project. Each slot entry may contain:

- the contract IDL;
- deployed code hash;
- debug Wasm path;
- source line-map path.

Call and debug lookup reject a local artifact when both the local and deployed
code hashes exist and differ. This prevents an upgraded slot from being decoded
with stale local metadata.

### 6.3 Source-derived IDL

When local IDL is unavailable, call/debug can run `extractIdl()` over source:

- user source comes from `dynRegistry.source`;
- system source comes from the resolved core catalog.

Successful deploy makes this fallback possible by best-effort posting the
contract header back to the node with `putContractSource()`.

Raw numeric calls can still work without IDL when the caller supplies explicit
input/output formats. Named entries and `--args` JSON require a schema.

State decoding is intentionally different: it does not consult
`qinit.idl.json`. It always derives the current state layout from contract source
and the resolved QPI headers.

## 7. Project and build commands

### 7.1 `qinit new`

The implementation is [`packages/cli/src/commands/develop/new.tsx`](../packages/cli/src/commands/develop/new.tsx).

```text
New
  -> parse name and template
  -> validate identifier and collisions
  -> templateSource()
  -> best-effort extractIdl() + genStdGtest()
  -> write project files
```

It writes:

```text
<project>/
  contracts/<Name>.h
  tests/<Name>.test.cpp       when IDL/gtest generation succeeds
  qinit.json
  .gitignore
  README.md
```

The inter-contract template also writes `contracts/Counter.h`. The shared
dependency resolver discovers it from the caller source. Nested scaffolding is
refused when `qinit.json` already exists in the working directory.

Gtest generation is best-effort: project creation continues if IDL extraction
fails.

### 7.2 `qinit integrate`

The implementation is
[`commands/develop/integrate.tsx`](../packages/cli/src/commands/develop/integrate.tsx),
with filesystem and Git work in
[`ops/core-integration.ts`](../packages/cli/src/ops/core-integration.ts).

```text
qinit integrate [<contract.h>]
  [--contract <path>]
  [--contract-name <name>]
  [--out <core-dir>]
  [--asset <name>]
  [--construction-epoch <epoch>]
  [--destruction-epoch <epoch>]
```

Contract selection is `--contract`, then the positional, then `qinit.json`.
Name selection is `--contract-name`, then `qinit.json`, then the header basename.
Output defaults to `../<ContractName>-core`. A new output is a full,
single-branch clone of the latest `qubic/core` `main`, followed by a
`qinit/<lowercase-name>` integration branch. In a TTY, initial integration
prompts for:

- an asset name matching `[A-Z][A-Z0-9]{0,6}`;
- the construction epoch (the IPO is normally one epoch earlier);
- the destruction epoch, prefilled with `10000`.

Non-TTY use must pass `--asset` and `--construction-epoch`; destruction still
defaults to `10000`. Epochs must fit Core's unsigned 16-bit fields, and the
destruction epoch must be later than construction.

An existing target must be a clean Core checkout. On `main`, Qinit fast-forwards
from `origin/main` before creating the integration branch; an already-wired
feature branch is updated in place. Re-runs recognize the existing registration
and synchronize source instead of allocating another contract index. Its asset,
construction epoch, and destruction epoch are immutable: omitted flags reuse
them, while conflicting flags fail before writes. Qinit never resets, cleans,
commits, pushes, or overwrites a dirty checkout.

The command wires exactly one selected contract. It does not recursively add
local custom callees: every referenced custom callee must already be registered
in the target Core checkout at a lower index. A same-name local header alone is
not enough. A referenced callee in the GTest should also have
`INIT_CONTRACT(Callee)`.

Qinit updates only the files Core currently needs:

- `src/contracts/<Name>.h`;
- the three registration sections in `src/contract_core/contract_def.h`;
- `src/Qubic.vcxproj` and `src/Qubic.vcxproj.filters`;
- `test/contract_<name>.cpp`, `test/test.vcxproj`, and
  `test/test.vcxproj.filters` when `tests/<Name>.test.cpp` exists locally.

The GTest is optional. A missing local test does not fail initial integration
and does not delete an already-wired Core test during an update. The command
does not edit `Qubic.sln` or any CMake file, and preserves the BOM and CRLF
format used by Core's Visual Studio project files.

Core currently supports this generated build path on Windows:

```powershell
nuget restore Qubic.sln
msbuild /m /p:Configuration=Release Qubic.sln /t:Qubic:Rebuild /warnaserror
msbuild /m /p:Configuration=Release Qubic.sln /t:test:Rebuild /warnaserror
.\x64\Release\test.exe --gtest_filter=<Contract>.*
```

The `qinit integrate` preparation itself may run on any Qinit-supported OS; it
prints these commands rather than invoking them.

### 7.3 `qinit compiler`

This command selects a backend; it does not compile a contract. The selection is
saved as `clang` or `typescript`. Build, deploy, dev, test, gtest, `system`,
and simulator startup resolve:

```text
--compiler -> saved compiler-backend -> clang
```

### 7.4 `qinit build`

The UI component is [`commands/develop/build.tsx`](../packages/cli/src/commands/develop/build.tsx).
It resolves:

| Value    | Resolution                                                            |
| -------- | --------------------------------------------------------------------- |
| Contract | `--contract` -> first positional -> config -> `fixtures/Counter.h`    |
| Name     | `--contract-name` -> config -> filename without extension             |
| Output   | `--out` -> `dist/contracts`                                           |
| Slot     | `--slot` -> config -> live registry plan -> offline hypothetical plan |
| Core     | normal `resolveCoreDir()` chain                                       |
| Compiler | `--compiler` -> saved choice -> clang                                 |

Build never mutates the node. It resolves the complete source graph first:

```text
Build
  -> parse optional --callee Name=header[@index] overrides
  -> recursively scan Main and its callees
  -> resolve system contracts from Core
  -> resolve custom contracts from one unique contracts/**/*.h basename
  -> read the live registry when reachable, otherwise use the Core slot layout
  -> assign every custom callee below its caller
  -> compile custom contracts dependency-first
```

An unavailable node is therefore a normal offline build: Qinit assigns
deterministic hypothetical slots and still compiles every local dependency.
When a node is reachable, existing same-name slots and unrelated occupied slots
are respected.

The selected backend is used for every custom contract in the graph.

#### Clang path

```text
buildContractWithClang()
       -> analyze source calls
       -> protocol verification
       -> generate inter-contract prelude
       -> generate C++ Wasm wrapper
       -> compile with WASI clang
       -> optionally generate DWARF sidecar and line map
       -> strip deployed Wasm debug data
       -> K12 hash
       -> extract source IDL
```

The build recipe lives in [`packages/build/src/compile/pipeline.ts`](../packages/build/src/compile/pipeline.ts)
and [`packages/build/src/compile/clang.ts`](../packages/build/src/compile/clang.ts).

#### TypeScript path

```text
buildContractWithTypeScript()
       -> load resolved qpi.h
       -> analyze transitive custom and system callee sources
       -> compileContractWithTypeScript()
       -> write returned Wasm
       -> compute K12 hash
```

The shared implementation is
[`packages/build/src/compile/typescript.ts`](../packages/build/src/compile/typescript.ts); the
CLI compatibility export remains in `ops/typescript-build.ts`.

Successful build artifacts normally include:

```text
dist/contracts/<Name>.wasm
dist/contracts/<Name>.idl.json
dist/contracts/<Name>.wasm.wrapper.cpp     clang path
dist/contracts/<Name>.debug.wasm           when debug tools succeed
dist/contracts/<Name>.lines.json            when line-map generation succeeds
```

The built Wasm's K12 digest is shown and included in build JSON.

### 7.5 Dynamic callee resolution

[`packages/cli/src/contracts/callees.ts`](../packages/cli/src/contracts/callees.ts) parses:

```text
--callee Counter=contracts/Counter.h[@100]
```

The name must be a C++ identifier, an explicit index must be an unsigned 32-bit
integer, and duplicate names fail parsing. The index is optional until the slot
planner assigns one.

`resolveProjectDependencies()` scans the caller source, then recursively
resolves each referenced contract from an explicit `--callee`, the Core system
catalog, or one unique `contracts/**/*.h` basename. It returns system and custom
contracts in dependency-first order and reports missing contracts, ambiguous
workspace matches, reserved system names, and dependency cycles.

### 7.6 `qinit gen`, `qinit verify`, and `qinit dev`

`gen` does not compile or contact the node:

```text
source + resolved qpi.h
  -> extractIdl()
  -> generateClient()
  -> dist/clients/runtime.ts + <Name>.ts
```

`verify` locates `contractverify`, prepares the selected contract and callee
allow-list, then invokes the external verifier. Tool lookup is:

```text
QINIT_VERIFY
-> current cache pointer
-> default cached verifier path
-> PATH
```

An absent or unrecognizable verifier is reported as unavailable/skipped, not as
a protocol failure. Unlike build/deploy, the standalone verify command does not
auto-download the verifier.

`dev` polls source modification times because filesystem watchers are not
reliable in the compiled binary. A change resolves and synchronizes the same
project graph as `deploy`. The command remains mounted until the user quits.

## 8. Deployment, step by step

The display component is [`commands/deploy-interact/deploy.tsx`](../packages/cli/src/commands/deploy-interact/deploy.tsx).
Project orchestration is
[`ops/project-deploy.ts`](../packages/cli/src/ops/project-deploy.ts); the
single-contract protocol state machine remains in
[`ops/deploy/`](../packages/cli/src/ops/deploy/index.ts).

Before the first mutation, project deployment:

```text
GET /live/v1/whoami + dyn-registry
  -> resolve and slot the complete dependency graph
  -> build every custom contract
  -> simulator: build required system Wasm with the selected compiler
  -> core: treat native system contracts as already present
  -> preflight system canonical slots
  -> skip unchanged custom/system dependencies by code hash
  -> deploy changed dependencies in dependency-first order
  -> always deploy Main last
```

If a later deployment fails, Qinit stops and reports the dependencies that
already landed; it does not attempt an unsafe rollback.

The state machine reports these steps:

```text
node ticking -> resolve slot -> build Wasm -> upload -> deploy -> confirm
```

The full flow is:

```text
preflight active upload
  -> reject a reserved system-contract name
  -> report header/node version drift
  -> best-effort update contractverify
  -> prove the node advances by more than three ticks
  -> resolve signing seed
  -> resolve target slot
  -> compile or validate a prebuilt artifact
  -> calculate code K12
  |
  +-- simulator direct route
  |     -> POST /live/v1/dev/deploy
  |     -> store source metadata
  |     -> save local IDL
  |     -> ready
  |
  +-- core node protocol route
        -> reject a node ticking too slowly for the upload budget
        -> sign and send UPLOAD_BEGIN
        -> confirm upload-session ownership
        -> sign and send every UPLOAD_CHUNK
        -> retry failed broadcasts
        -> query dyn-upload and resend missing chunks
        -> sign and send DEPLOY
        -> poll dyn-registry for expected slot and code hash
        -> verify armed/constructed/registration state
        -> store source metadata
        -> save local IDL
```

### 8.1 Slot selection

`resolveDeploymentSlot()` in [`packages/proto/src/call.ts`](../packages/proto/src/call.ts)
uses:

1. An explicit slot, when supplied.
2. The armed slot with the exact same contract name, for an upgrade.
3. The first unarmed dynamic slot.
4. An error when no slot is free.

Explicit slots must be inside the advertised dynamic window. Qinit rejects a
different-name occupant and rejects moving a same-named deployed contract to a
second slot. The graph planner applies the same rules to all custom contracts
and additionally enforces `callee slot < caller slot`.

### 8.2 Simulator versus protocol deployment

The simulator exposes a direct development endpoint, so it does not need upload
transactions. A core node does not expose that route and uses the on-chain
chunked protocol encoded by [`packages/proto/src/deploy.ts`](../packages/proto/src/deploy.ts).

The protocol path does not equate a successful HTTP broadcast with inclusion.
It verifies upload ownership, assembly, registry presence, and the code hash.

### 8.3 Metadata after success

Source upload and local IDL persistence are best-effort metadata operations. A
failure there must not change a deployment that the node already accepted.

The local artifact records the code hash so later calls and backtraces can reject
stale schemas. If the contract is armed but initialization has not settled,
deploy succeeds with a warning that early calls may observe pre-initialized
state.

## 9. Calls and procedures

[`commands/deploy-interact/call.tsx`](../packages/cli/src/commands/deploy-interact/call.tsx) has two modes:

```text
no --fn or --proc
  -> CallInteractive -> CollectedCall -> CallOneShot

--fn or --proc
  -> CallOneShot
```

Passing both flags or omitting the required contract/entry positionals is a
custom parser error.

### 9.1 Contract and entry resolution

One-shot mode:

1. Loads armed user contracts and the system catalog.
2. Resolves the contract by case-insensitive name or numeric slot.
3. Loads a code-hash-compatible entry from `qinit.idl.json` when possible.
4. Otherwise derives IDL from available contract source.
5. Resolves the entry by numeric input type or case-insensitive name.

`--args <json>` uses the IDL's structured ABI type. `--in` uses Qinit's raw
format language. A numeric entry can be called without IDL if raw formats are
provided; a named entry cannot.

For `BitArray<N>`, typed `--args` and generated clients use an exact-length JSON
array of `0` and `1` values in logical bit order. Raw `--in` remains the physical
`uint64`-word representation. `Collection`, `HashMap`, `HashSet`, and `LinkedList`
are state-only: Qinit rejects them recursively in public function and procedure
inputs and outputs, matching the QPI restriction that only integers, `bit`, `id`,
`Array`, `BitArray`, and `SlowAnySizeArray` may cross the call boundary.

### 9.2 Function flow

```text
--args JSON or --in format
  -> encodeInputJson() or encodeInput()
  -> callFunction()
  -> LiteRpc.querySmartContract()
  -> POST /live/v1/querySmartContract
  -> decodeOutput()
  -> fmtVal()
  -> terminal
```

Functions are read-only RPC queries and do not use a signing seed.

### 9.3 Procedure flow

```text
tickInfo().tick + TX_TICK_OFFSET
  -> resolve signing seed
  -> encode procedure input
  -> buildSignedTx()
  -> broadcast transaction
  -> optionally poll txStatus()
       -> exact processed/included verdict
       -> fall back to watching tick advancement when addon is absent
  -> processed / dropped / unconfirmed result
```

`--no-settle` returns after broadcast. Otherwise `invokeProcedure()` waits up to
its confirmation deadline and reports whether the target tick was processed and
the transaction was found.

### 9.4 `--trace`

One-shot tracing wraps the actual dispatch:

```text
setDebug(true)
  -> read current maximum trace sequence
  -> call function/procedure
  -> poll for a newer matching slot/kind/entry
  -> describeTrace()
```

Entry sequences are 1-based on both runtimes and `since` is exclusive, so the poll
starts at `0` and still sees the first entry of a freshly enabled ring.

`--trace-full` implies `--trace` and prints the state block with its container
internals, the same view `ctrl+t` toggles in `qinit debug` (section 11).

Trap enrichment reads the active Qinit node's `node.log` and the matching local
line-map artifact. This only works when Qinit knows the launched node's scratch
directory and still has compatible debug artifacts.

### 9.5 Interactive flow

[`commands/deploy-interact/call-interactive.tsx`](../packages/cli/src/commands/deploy-interact/call-interactive.tsx)
is a state machine:

```text
loading -> contract -> entry -> input -> output or amount -> CollectedCall
```

It enriches registry entries from local IDL first, then source-derived IDL, then
falls back to numeric registry metadata. It never dispatches: the last prompt
hands a `CollectedCall` to `Call`, which mounts `CallOneShot` with the answers
overlaid on the typed flags, so both invocation styles render the same result
view. `done` is now only the terminal state for a wizard that never reached a
call — an unreadable registry, or no contracts at all — and it exits 1.

Because the overlay layers on the original invocation, `--trace`, `--all`,
`--rpc`, `--seed`, and `--no-settle` now reach an interactive call; the wizard
previously hard-coded `confirm: true`. The prompts it does own mask their flags,
so a typed `--args`, `--in`, `--out`, or `--amount` cannot outlive the answer
that replaced it. Bare `qinit call --json` is rejected, because the wizard draws
frames on the stream the JSON document would go to.

The equivalent one-shot command survives as a hint rendered below the shared
result view, keeping the interactive path a discoverability layer over the same
protocol helpers.

## 10. Sparse state decoding

This is the most important flow to understand because the terminal never reads
C++ state directly. It derives a layout, requests bytes, decodes them, and only
then renders names and values.

Assume a contract contains:

```cpp
struct StateData {
  uint64 counter;
  HashMap<id, uint64, 4> balances;
};
```

Assume it is deployed in slot `100`, `counter` is `7`, and slot 0 of `balances`
contains the all-zero `id` mapped to `42`.

The implementation begins in [`commands/deploy-interact/state.tsx`](../packages/cli/src/commands/deploy-interact/state.tsx):

```text
qinit state Counter
  -> parse target/rpc/digest
  -> load user and system contracts
  -> resolve Counter
  -> require source
  -> tickInfo() reachability check
  -> readState()
  -> StateView
```

Top-level QPI containers receive stable one-based indexes in declaration order.
Containers under 10 MiB load immediately. Containers at least 10 MiB start as
summaries so opening QX or QUTIL does not scan hundreds of megabytes before the
first screen appears:

```text
[1] balances · 1 entry · 3/4 slots unoccupied
[2] voters · 402,653,184 bytes · press 2 to load
    not read
```

In an interactive terminal, type an index to load or hide that container. A
500 ms pause commits multi-digit indexes; Enter commits immediately, Backspace
edits, and Escape clears the pending index before quitting. For scripts and
non-interactive output, select containers explicitly:

```bash
qinit state QUTIL --container 2
qinit state QUTIL --container 2 --container 4
qinit state QUTIL --all
```

### Step 1: find source

For a user contract, `loadContracts()` gets source from the dynamic registry.
For a system contract, it gets source from the resolved core catalog. If there
is no source, decoded state fails even if `qinit.idl.json` exists.

### Step 2: derive the IDL layout

[`readState()`](../packages/cli/src/trace/format.ts) calls:

```ts
extractIdl(source, name, {
    slot: contractIndex,
    qpiHeader,
});
```

For this example, the relevant layout is effectively:

```text
counter
  offset   0
  size     8
  type     uint64

balances
  offset   8
  size     184
  type     HashMap<id, uint64, 4>
  capacity 4
```

The exact sizes come from the ABI/type layout, not a hardcoded CLI table.

Container decoding lives in
[`packages/proto/src/qpi-container-view/`](../packages/proto/src/qpi-container-view/).
Each read-only view receives an ABI type and a `QpiByteSource`, then exposes
logical `get()` or `entries()` operations. The state command supplies an RPC
source that reads exact relative ranges; trace decoding supplies a bounded byte
snapshot. These views interpret QPI's stored layout. They do not execute C++ or
reimplement the mutable QPI container API.

Array and BitArray keep dense `entries()` for normal ABI decoding. State output
uses their sparse iterators, which test zero bytes before decoding values and do
not retain empty elements.

The strict views are the sole logical container decoder. They reject incomplete
or internally inconsistent layouts instead of presenting them as empty state.

### Step 3: read and decode scalar fields

`stateFieldsOf()` marks `balances` as a container, so the first loop skips it
and reads only `counter`:

```text
GET /live/v1/dev/state-read?slot=100&off=0&len=8
  -> response hex: 0700000000000000
  -> hexToBytes()
  -> decodeOutput(bytes, uint64)
  -> 7
  -> { name: "counter", value: "7" }
```

Fields are separate HTTP reads. Large arrays and compact `BitArray` words are
read in 4 MiB pages. An `Array` field is not a scalar row: it becomes a block
of its own, one row per nonzero element, in the position its field is declared.
Bit arrays use the same indexed block model and display every set bit in logical
LSB-first order, collapsing zero runs and ignoring unused padding bits above
their declared length. A failed read is reported as incomplete rather than
being mistaken for empty state.

### Step 4: read the occupied HashMap bytes

`readState()` first reads the container population counter. If it is zero, no
entry storage is transferred and the full slot range is shown as unoccupied.
Otherwise it reads the compact two-bit occupation flags, then requests only
the occupied entry ranges.

```text
population 1
flags      slot 0 occupied; slots 1..3 unoccupied
read       entry slot 0 only
```

For `HashMap<id, uint64, 4>`:

```text
id key size        32 bytes
uint64 alignment    8 bytes
value offset       32 bytes
entry stride       40 bytes
4 entry slots     160 bytes
occupation flags   start at relative offset 160
```

Each slot has a two-bit flag. A flag value of `1` means occupied. For occupied
slot 0, `readState()` decodes the fetched record:

```text
key   bytes [0, 32)   -> all-zero id
value bytes [32, 40)  -> 2a00000000000000 -> 42
```

It returns a semantic entry rather than exposing the storage offsets:

```ts
{
  slot: 0,
  key: /* decoded id */,
  value: 42n,
}
```

`readState()` formats that as one row per slot:

```text
slot[0]     <identity> = 42
slots[1..3] (unoccupied ×3; skipped)
```

HashSet uses the same occupation-flag idea without values. Collection uses QPI's
PoV records and walks each occupied PoV's priority tree in order. Both fetch
only occupied storage and show unoccupied ranges explicitly.

LinkedList first reads only its population. For a nonempty list it reads the
one-bit occupation flags, head and tail, then only occupied node records. Entries
are shown in logical head-to-tail order with both item and physical slot indexes;
unoccupied physical slot ranges follow. Free-list bookkeeping is not fetched.

### Step 5: render the decoded model

`readState()` returns:

```ts
{
  fields: [
    { name: "counter", value: "7" },
  ],
  containers: [
    {
      index: 1,
      name: "balances",
      kind: "hashmap",
      status: "loaded",
      size: 184,
      capacity: 4,
      occupiedSlots: 1,
      totalEntries: 1,
      lines: [
        { label: "slot[0]", text: "<identity> = 42", filled: true },
        { label: "slots[1..3]", text: "(unoccupied ×3; skipped)", filled: false },
      ],
    },
  ],
  complete: true,
}
```

`label` is the bracket token the view paints and pads into a column; `filled`
separates an occupied slot from a skipped range, and is the only thing the
highlight depends on. An `Array` block uses the same shape with `kind: "array"`,
`[index]` labels, and `capacity` set to the declared element count.

[`StateView`](../packages/cli/src/trace/views.tsx) only renders this model. It does not
know field offsets, make RPC calls, or decode container layouts.

### Lazy sparse output and consistency

- Containers below 10 MiB load by default. Containers 10 MiB and larger remain
  collapsed until selected by index or `--all`; a collapsed block is neither an
  error nor an incomplete read.
- Individual RPC requests use up to 4 MiB and larger fields are paged. Qinit
  continues paging when an older node returns a shorter nonempty chunk.
- Arrays display every nonzero element, and BitArray displays every set bit;
  zero ranges are marked as skipped.
- Every block row is its own line, and its bracket token is highlighted when the
  row is an occupied slot rather than a skipped range.
- HashMap, HashSet, Collection, and LinkedList display every occupied entry and mark
  unoccupied slot ranges as skipped, without transferring empty entry storage.
- Nested BitArray and LinkedList values are decoded semantically, including
  values stored in the existing QPI containers.
- Container views validate populations, occupation flags, and linked topology.
  A consistency failure is retried once because separate range reads may span a
  state update.
- Scalar fields and containers are read in separate requests. Ticks may advance
  between them, and the node's range endpoint does not lock the whole state
  across requests. Decoded output is therefore a best-effort live view, not an
  atomic snapshot.
- State values wrap across terminal lines instead of being truncated.

### Canonical digest is a different path

```bash
qinit state Counter --digest
```

does not derive IDL or read fields. [`readStateDigest()`](../packages/cli/src/contracts/state-digest.ts)
resolves an armed dynamic name or a numeric slot, then calls:

```text
GET /live/v1/dev/contract-digest?slot=100
```

The node returns the state size and canonical full-state K12 digest.

### Raw state dump

```bash
qinit state Counter --dump              # -> <cwd>/state/Counter_dump.bin
qinit state 29 --dump --out dumps/      # a directory keeps the generated filename
qinit state 29 --dump --out before.bin  # anything else is the file path
```

[`dumpContractState()`](../packages/cli/src/contracts/state-dump.ts) pages
`GET /live/v1/dev/state-read` 4 MiB at a time and streams each chunk to the file, so
a multi-megabyte state never has to fit in memory. It prints the absolute path and the
byte count, which equals the `stateSize` that `--digest` reports. The file is the raw
state image with no header, and a failed read deletes the partial file rather than
leaving a truncated one.

Dumping derives no IDL and reads no `.h`, so a **numeric** target that the registry
does not list is still dumpable — the filename is then `<slot>_dump.bin`. `--dump` wins
over `--digest` when both are given, and `--out` without `--dump` is an argument error.

## 11. Live debugging

[`commands/deploy-interact/debug.tsx`](../packages/cli/src/commands/deploy-interact/debug.tsx) is a long-running
trace browser:

```text
setDebug(true)
  -> every 1.2 seconds:
       dynRegistry()
       debugTrace(since, 200)
  -> merge by sequence and retain the latest 500 entries, newest first
  -> resolve visible tick timestamps through getTickData()
  -> select an entry
  -> describeTrace()
  -> TraceView
```

The first table column shows age relative to the latest resolved chain timestamp, so
the deterministic TypeScript engine and core-lite use the same clock semantics. A tick
without available `TickData` shows `—`. Pressing `x` hides the selected record for this
`qinit debug` session only; it does not clear the node's trace ring.

`describeTrace()` in [`trace/format.ts`](../packages/cli/src/trace/format.ts):

1. Starts with raw input and output hex.
2. Converts a procedure's invocator bytes to an identity.
3. Derives IDL from source when possible.
4. Decodes registered input and output.
5. Resolves each changed byte window to the element it covers (`trace/state-diff.ts`).
6. Decodes structured logs and enum names.
7. Leaves raw bytes available when schema derivation fails.

Step 5 is what makes a diff readable. `stateDiffLines()` walks the ABI type from the
containing field down to the element the bytes belong to, using the geometry helpers
and member tables in [`qpi-layout.ts`](../packages/proto/src/qpi-layout.ts) — so a
HashMap write reports the entry, `map._occupationFlags[31]` and `map._population`
rather than byte offsets. Internals are named the way core declares
them in `qpi_containers.h`, which a test pins against the bundled `qpi.h` snapshot.
Indexed collections always resolve per element; a struct is reported
whole when the region covers all of it. Occupation flags and `BitArray` fields report
the indices that flipped instead of the raw words, including when the changed window
opens partway into a run of flags too long to fit one window.

A `HashMap` or `HashSet` record goes one step further: its rows collapse onto a single
line named by the key the contract wrote, rather than by the bucket the entry hashed
into — a placement detail no contract author picks. So `map.slot[31].key  0 → 45` and
`map.slot[31].value  0 → 46` read as one `map[45]  = 46 (new)`. The key is read from
the changed window rather than from the rows, because an update leaves the key bytes
alone and they never produce a row of their own. The occupation flag is what separates
`(new)`, `(removed)` and a plain update, so a window carrying neither the flag nor the
key leaves the row on its resolved path instead of guessing. `Collection` and
`LinkedList` are addressed by index and already read short, so they keep their rows.

Resolving that deep also finds bookkeeping a contract author never wrote — free-list
heads, BST links, per-PoV counters — so each row is classified and the default view
keeps only two of the three classes:

| Class    | Rows                                                                                                                                                                            | Default |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| payload  | scalars, struct members, `Array`/`BitArray` elements, a keyed container's entry line, node and element values, a `Collection` element's `priority`, a PoV id                    | shown   |
| count    | a container's `_population`, rendered as `trail  1 → 2 entries`                                                                                                                 | shown   |
| internal | occupation flags, `_headIndex`/`_tailIndex`/`_freeHeadIndex`/`_nextUnusedIndex`, `bst*Index`, `povIndex`, per-PoV counters, `_markRemovalCounter`, node `nextIndex`/`prevIndex`, a collapsed entry's own `slot[i].key` | hidden  |

Each row therefore carries two labels: the shown one drops the internal path segments
(`trail._nodes[1].value` reads as `trail[1]`, `map.slot[31].value` as `map[45]`), and
the full path returns with the internal rows under `ctrl+t` in `qinit debug` or
`--trace-full` on `qinit call`.
Hidden rows are always counted in a tail line, so a call that touched only bookkeeping
never reads as "no change". `qinit call --trace` prints every row; `qinit debug` bounds
the block to what is left of the terminal after the rows around it and pages through the
rest with `pgup`/`pgdn`. That bound is not cosmetic: Ink cannot erase a frame taller than
the screen, so an overflowing block leaves its own stale rows on the next render — which
is what made `ctrl+t` look like it only worked one way.

`qinit debug` therefore uses the explorer's fixed-height shell — `useTerminalSize()`, an
outer `height={rows - 1}`, and a row budget handed to both panes. Passing `width` to
`TraceView` is what makes that budget arithmetic rather than a guess: it truncates against
the pane instead of `termCols()` and pins every row to a single line, so a row is a line.
Without it a 60-character identity sets the detail pane's min-content width, and since an
Ink `Box` shrinks by default, the list pane gives way and every table row wraps. The list
pane is `flexShrink={0}` and floored at `LIST_MIN_WIDTH`, below which `Table` cannot
render its columns without wrapping either. `qinit call --trace` passes no `width` and
keeps wrapping, so the caller stays a full copy-pasteable id there.

Both runtimes report changed bytes as 256-byte aligned windows rather than as
minimal runs, because a small value written into zeroed state dirties too few bytes to
decode. Contiguous regions are joined before resolving, so a record split across two
dirty pages still decodes whole. A region that still does not cover a whole value keeps
its bytes as hex under the resolved path rather than guessing the rest.

Neither runtime caps how much of a call's state changes it reports: the simulator
snapshots the whole state, and core-lite sizes its dirty-page buffer from the contract's
state. `stateTruncated` therefore means bytes were genuinely dropped.

The captured `stateDiff` belongs to that invocation. Trace rendering never reads
live contract state; use `qinit state` to inspect current container contents.

Host calls and trap text already arrive in each `DebugEntry`. For a failed call,
the detail view also attempts a source-mapped backtrace from `node.log` and the
local line map.

A node records by default — core-lite's ring starts armed and `EngineServer.start()`
enables the simulator's, so a `debug` session opened after the fact still finds the
calls that already ran. `qinit node run` also arms the node over RPC, which covers a
node release older than that default. No CLI path turns capture off; the toggle is
global, so one that did would blind every other client. `GET /live/v1/dev/debug?on=0`
remains for anyone who wants the cycles back.

The ring holds 8192 entries on both runtimes, and a slot is spent per _dispatch_
rather than per tick: a contract registering `BEGIN_TICK`/`END_TICK` spends two every
tick whether or not anything happened, which turns the depth into a time window.

### 11.1 The chain explorer

`qinit explorer` is a separate long-running TUI, unrelated to trace capture: it
reads the `/query/v1` explorer routes and never enables debug mode.
[`commands/deploy-interact/explorer/`](../packages/cli/src/commands/deploy-interact/explorer/index.tsx)
splits into a shell plus one module per view.

```text
index.tsx      navigation stack, useInput, view dispatch, initialView()
chrome.tsx     View/Frame/ViewProps, breadcrumb, control bar, windowing, formatters
find.tsx       parseFindQuery() + the search prompt
overview.tsx   tiles and recent ticks (explorerData)
tick.tsx       tick detail and transaction detail
identity.tsx   balance plus transfer history
contracts.tsx  contract catalog and per-contract calls
wallet.tsx     the send form: resolve sender/recipient, review, broadcast, confirm
```

The dependency arrow is one-way: views import `chrome.tsx`, and `chrome.tsx`
imports nothing from the shell, which is what keeps the module graph acyclic.
`index.tsx` re-exports `View` and `parseFindQuery` so importers do not need to
know which module they now live in.

Navigation is a frame stack. `esc` pops one frame, then falls back to the
overview, then exits; `1`/`2`/`3`/`4` replace the root; `/` pushes the search
prompt; `↑↓` move the selection the current view registered through the shared
`rowCount`/`openRow` refs; `←→` step a tick or a contract page; `s` on an
identity pushes the wallet with that identity prefilled as the recipient.

`qinit explorer <tick|txid|identity>` takes one argument and resolves it through
`parseFindQuery` — the same shape rule `/` applies to what is typed into it, so
the command line has no `--tick`/`--tx`/`--id` to pick between. `initialView()`
runs before the first hook, and an argument matching none of the three shapes is
refused with `invalidArgs` rather than opening the TUI on a guess.

The wallet is the one view the shell hands the keyboard to completely — its
`useInput` returns immediately for `view.kind === "wallet"`. That is not only
because the form runs its own stages with its own `esc`: seed characters are
`a`-`z`, so a global `q` or `r` would quit or refresh in the middle of typing a
seed. Since the shell cannot see which stage the form is in — the stage is
component state, and lifting it into the `View` would remount the view and wipe
the fields on every transition — the control bar advertises only `esc`, which is
true in every stage, and each stage draws its own key line in-body.

### 11.2 The wallet's resolution rules

Both wallet fields take either form and are told apart by shape, which is
unambiguous: 55 lowercase letters is a seed, 60 uppercase is an identity. The
asymmetry is in what each field must end up with. FROM has to sign, so it always
resolves to a **seed**; TO is what the transaction carries, so it always resolves
to an **identity**.

A seed in FROM signs directly. An identity in FROM has no private key, so its
seed is looked up in the node's funded pool (`/live/v1/dev/funded-seeds`), and a
miss is an error — there is nothing to sign with. That route is compile-gated on
core (`TESTNET` and `LITE_WASM_SC`), so `poolSeedForIdentity()` keeps three cases
apart: the route was unreachable, the reply was truncated (`seeds.length` below
`count`), or the identity genuinely is not in the pool. Reporting the first as
the third would be a lie.

Ask for the pool with an explicit limit and never with `0`: core reads `0` as
"all", the simulator as "none".

The recipient's checksum is validated locally through `identityToBytes()`,
because the node does not check identities at all — `balancesId` decodes whatever
string it is given. That check is the only thing between a typo and a transfer
into an address nobody holds.

Broadcasting is not confirmation. A transfer targets `tick + TX_TICK_OFFSET`, and
core-lite only registers a transaction if its tick falls inside the pending
pool's 32-tick window; overshooting is dropped silently, after the HTTP call has
already returned 200. So the wallet confirms through `sendTransfer(..., {confirm:
true})` and reports `processed`, `dropped — not included`, or `broadcast ·
unconfirmed` rather than declaring success at broadcast.

`parseFindQuery()` routes the single search field by the shape of what was
typed: an unsigned integer is a tick, 60 uppercase characters are an identity,
60 lowercase characters are a transaction hash, and anything else is rejected.
Case is the only thing separating an identity from a tx id.

The shell budgets terminal rows itself — `rows - 1 - CHROME_ROWS -
controlBarRows(...)` — so a hint line that wraps unexpectedly pushes the control
bar off-screen. That is why `hintLines()` is unit-tested against several
terminal widths in `tests/format/ui-format.test.ts`. The control bar also lights
the key of the section the stack is _rooted_ in — `TAB_KEY` in `chrome.tsx` — with
a gradient that sweeps on a `useFrame` tick, so drilling into a tick or a
transaction still shows `1 overview` as the current tab.

### 11.2 Naming and decoding a call

Alongside the contract names it loads once, the shell loads every slot's IDL
through [`contracts/idl-lookup.ts`](../packages/cli/src/contracts/idl-lookup.ts)
— local `qinit.idl.json` first, then the system catalog's already-parsed IDL,
then `extractIdl()` over whatever source the node holds. That map turns a bare
`inputType` into a procedure name in both list views, and lets the transaction
view decode the payload: `decodeTxInput()` pads or truncates the bytes to the
registered input size exactly as the engine's dispatch frame does, then renders
named fields plus the `--in` value grammar above the hex dump. Both are best
effort — an unparsed slot or an input with no grammar (linked lists, overlapping
structs) simply falls back to the raw number and the hex.

Every decoded line is variable width, so `TxView` truncates each one to
`sectionTableWidth(columns)` and subtracts the block's height from the hex
budget. Without that the row arithmetic above breaks: QUTIL's `SendToManyV1`
carries 25 identities and would otherwise wrap far past the frame.

## 12. Node lifecycle and simulator topology

The default runtime is selected by:

```text
--runtime -> saved runtime -> core
```

The main orchestrator is [`commands/node/node-run.tsx`](../packages/cli/src/commands/node/node-run.tsx).

### 12.1 `qinit node run`

It executes four visible phases:

```text
core headers -> node binary -> Wasm compiler -> node running
```

Header preparation is in [`ops/node-core.ts`](../packages/cli/src/ops/node-core.ts):

- `--core-dir` bypasses the release manifest.
- The core runtime plus `--core-dir` also requires `--node-bin` so headers and an
  arbitrary fetched node are not silently mixed.
- `--core-dir` and `--ref` are mutually exclusive.
- `--offline` requires an existing cache.
- Otherwise one release manifest supplies the version and header asset.

For the core runtime, Qinit uses an explicit, cached, or downloaded Qubic binary
and calls `launchNode()`. For the simulator runtime, it loads the core-derived
dynamic-slot layout and calls `launchSimulatorNode()`.

### 12.2 Detached process tracking

[`ops/node.ts`](../packages/cli/src/ops/node.ts) starts both runtimes detached.
It records:

```text
$QINIT_CACHE/active-node-scratch
<scratch>/node.pid
<scratch>/node.log
```

The default scratch directory is `$QINIT_CACHE/run`. A core node also creates its
runtime data relative to that working directory.

`killNode()` targets only the PID Qinit recorded. It deliberately never kills
every process named `Qubic`, because another developer node may be running.

### 12.3 The detached simulator

`launchSimulatorNode()` self-spawns the current executable:

```text
compiled qinit: qinit __serve <private flags>
Bun source run: bun <index.tsx> __serve <private flags>
```

[`ops/serve.ts`](../packages/cli/src/ops/serve.ts) creates:

```ts
new EngineServer(new VirtualNode(slotLayout));
```

It starts HTTP RPC, a Qubic peer server, and automatic ticking, then resolves
the transitive closure of configured system contracts. The entire closure is
compiled with the selected `clang` or `typescript` backend before any member is
seeded at its canonical slot. A build failure aborts startup instead of leaving
an incomplete system graph. The process intentionally waits forever and is
later reaped by `killNode()`.

Simulator deployment state is memory-only. `--keep` preserves scratch files; it
does not make simulator contract state survive a restart.

### 12.4 `node status`, `stop`, and `get`

[`commands/node/node.tsx`](../packages/cli/src/commands/node/node.tsx) owns the remaining
subcommands:

- `status` samples ticks, reads the registry and epoch window, and reports
  cached header/node version drift.
- `stop` stops the tracked PID only.
- `get` fetches only a node binary; it does not synchronize headers.

`nodeStatus()` samples twice about 1.2 seconds apart. A slow but healthy node may
therefore appear up but not ticking.

## 13. System contracts, setup, and maintenance commands

### 13.1 System contracts

`qinit system` identifies both runtimes through `GET /live/v1/whoami`:

- The simulator returns `{ "backend": "simulator" }`; core-lite returns
  `{ "backend": "core" }`. The `/live/v1/dev/fault` diagnostic route is never
  used for runtime detection.

- `ls` reads the local core-derived catalog and configured selection.
- On core, `add` records the selection but never uploads built-ins; the core
  already embeds them. `rm` removes only the future simulator selection.
- On the simulator, `add` resolves and prebuilds the dependency closure with
  the selected compiler, skips identical hashes, and deploys canonical slots.
- On the simulator, `rm` removes the requested roots and dependencies no longer
  required by another selected root, in reverse dependency order.
- The selected names are persisted in `qinit.json.system` for later simulator
  startup.

[`contracts/system-wasm.ts`](../packages/cli/src/contracts/system-wasm.ts) caches
snapshot builds beneath the current header version and compiler. Explicit Core
checkouts build in a temporary directory so different source trees cannot share
stale artifacts. [`packages/build/src/contracts/system-contracts.ts`](../packages/build/src/contracts/system-contracts.ts)
parses Core contract definitions, dependency closures, source, state types, and IDLs.

`qinit ls` combines live dynamic-registry entries with this local system
catalog. System entries can therefore still appear while RPC is unavailable.

### 13.2 Setup and cache commands

`qinit setup` sequentially prepares:

1. Core headers.
2. The host's node binary.
3. WASI SDK.
4. `contractverify`.

It downloads and caches assets; it does not start a node.

[`packages/core/src/cache/`](../packages/core/src/cache/) owns manifests,
verified downloads, atomic cache writes, the current pointer, the WASI SDK, and
verifier updates.

Other maintenance commands are intentionally thin:

| Command       | Main responsibility                                                                   |
| ------------- | ------------------------------------------------------------------------------------- |
| `doctor`      | Check the Wasm compiler, Node.js executable, QPI headers, Qubic library, and verifier |
| `clean`       | Stop the tracked node and remove the cache                                            |
| `self-update` | Resolve a CLI release, download it, and replace the executable                        |
| `uninstall`   | Preview or remove discovered CLI binaries and optionally the cache                    |
| `ext`         | Invoke a supported editor's extension installer                                       |
| `theme`       | Select and persist the terminal palette                                               |
| `runtime`     | Select and persist core or simulator                                                  |

## 14. Testing commands are two different systems

`qinit test` and `qinit gtest` should not be treated as alternate UIs over the
same runner.

### 14.1 `qinit test`: Bun client tests against RPC

[`commands/deploy-interact/test.tsx`](../packages/cli/src/commands/deploy-interact/test.tsx) runs:

```text
resolve core/compiler/runtime
  |
  +-- simulator -> EngineServer in this command process
  |
  +-- core -> reuse ticking node or launch one
  |
resolve, slot, and build the complete project graph
  -> core: use native system contracts
  -> simulator: compile/seed required system contracts
  -> skip unchanged custom dependencies
  -> deploy changed custom dependencies
  -> always deploy Main last
  -> generate tests/.qinit runtime and typed client
  -> scaffold a sample .test.ts when none exists
  -> update/create package.json
  -> bun install when the public Qubic library is missing
  -> spawn bun test
  -> inject QINIT_RPC, QINIT_SEED, QINIT_CONTRACT
  -> append a source backtrace on failure when possible
  -> stop a node that this command owns, unless --keep-node
```

This command intentionally mutates the project and may access the network. It is
an end-to-end client test workflow, not a read-only test invocation.

Its in-process simulator is not the detached `node run` simulator. It has no
peer port and uses the engine server's faster default tick interval.

### 14.2 `qinit gtest`: C++ contract tests in an isolated engine

[`commands/deploy-interact/gtest.tsx`](../packages/cli/src/commands/deploy-interact/gtest.tsx) calls
[`runStdGtest()`](../packages/cli/src/ops/corpus-run.ts):

```text
contract_testing.h-style test source
  -> resolve the same recursive local/system project graph offline
  -> assign custom callees below Main
  -> compile test harness with clang
  -> compile every contract module with selected clang or TypeScript backend
  -> deploy Wasm modules into an isolated in-process engine
  -> runContractTesting()
  -> stream individual results
```

The harness always requires clang because it consumes core-lite's C++ test
source. `--compiler typescript` changes how contract modules are compiled, not
how the harness is compiled.

`--corpus NAME` finds a real system-contract corpus in the core checkout.
Known memory/pointer-heavy suites automatically use shared-memory mode. User
suites can request it with `--shared-mem`.

`--filter` takes comma-separated case-insensitive substrings and skips
non-matching tests in the engine, so they are never executed. The same list can
come from the `QINIT_GTEST_FILTER` environment variable. Skipping is not free of
ordering effects: tick, epoch, timebase, and digests survive the per-test reset,
so a filtered run can differ from a full one for an order-dependent test.

## 15. RPC boundary map

The HTTP client is [`LiteRpc`](../packages/core/src/net/rpc/client.ts); its
response types live beside it in
[`net/rpc/types.ts`](../packages/core/src/net/rpc/types.ts). The generic GET path
retries connection/timeout failures with bounded backoff, does not retry an HTTP
non-success response, and reports malformed JSON explicitly. The POST path
treats `404` as a normal answer so a missing tick or hash returns `null` instead
of throwing.

Chain and contract routes:

| Method                    | Endpoint                                   | Primary CLI consumers                                   |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `tickInfo()`              | `GET /live/v1/tick-info`                   | deploy, procedure call, state reachability, node health |
| `latestCreatedTickInfo()` | `GET /latest-created-tick-info`            | tick freshness checks                                   |
| `faultInfo()`             | `GET /live/v1/dev/fault`                   | simulator fault reporting                               |
| `whoami()`                | `GET /live/v1/whoami`                      | explicit core/simulator orchestration                   |
| `raw()`                   | any GET path                               | escape hatch for routes with no method                  |
| `dynRegistry()`           | `GET /live/v1/dyn-registry`                | deploy/slot planning, call, state, debug, list          |
| `dynUpload()`             | `GET /live/v1/dyn-upload`                  | upload ownership and assembly                           |
| `querySmartContract()`    | `POST /live/v1/querySmartContract`         | function calls                                          |
| `broadcastTx()`           | `POST /live/v1/broadcast-transaction`      | procedures and deployment protocol                      |
| `txStatus()`              | `GET /live/v1/tx-status/<tick>/<id>`       | procedure settlement                                    |
| `balance()`               | `GET /live/v1/balances/<id>`               | seed selector, explorer identity view                   |
| `directDeploy()`          | `POST /live/v1/dev/deploy`                 | simulator deployment                                    |
| `undeploy()`              | `POST /live/v1/dev/undeploy?slot=N`        | simulator system removal                                |
| `putContractSource()`     | `POST /live/v1/dev/contract-source?slot=N` | post-deployment source metadata                         |
| `fundedSeed()`            | `GET /live/v1/dev/funded-seed`             | development signing fallback                            |
| `fundedSeeds()`           | `GET /live/v1/dev/funded-seeds?limit=N`    | seed selector                                           |
| `setDebug()`              | `GET /live/v1/dev/debug?on=0               | 1`                                                      | debug and call trace |
| `debugTrace()`            | `GET /live/v1/debug-trace?since=N&limit=N` | debug and call trace                                    |
| `stateRead()`             | `GET /live/v1/dev/state-read?...`          | decoded state and containers                            |
| `contractDigest()`        | `GET /live/v1/dev/contract-digest?slot=N`  | canonical state digest                                  |
| `epochInfo()`             | `GET /live/v1/dev/epoch-info`              | tick, epoch, node status                                |
| `advanceTick()`           | `GET /live/v1/dev/advance-tick?n=N`        | testnet tick controls                                   |
| `advanceToLast()`         | `GET /live/v1/dev/advance-to-last?gap=N`   | jump to the end of an epoch                             |
| `advanceEpoch()`          | `GET /live/v1/dev/advance-epoch`           | testnet epoch control                                   |
| `setTickMs()`             | `GET /live/v1/dev/tick-ms?ms=N`            | `tick` retunes a running simulator                      |

Explorer read models — the `/query/v1` family, consumed only by
`commands/deploy-interact/explorer/`:

| Method                       | Endpoint                                 | Explorer view                           |
| ---------------------------- | ---------------------------------------- | --------------------------------------- |
| `explorerData()`             | `GET /explorer/data`                     | overview tiles and recent ticks         |
| `getTickData()`              | `POST /query/v1/getTickData`             | tick header; `null` for an empty tick   |
| `explorerTickTransactions()` | `POST /query/v1/getTransactionsForTick`  | tick transaction list                   |
| `getTransactionByHash()`     | `POST /query/v1/getTransactionByHash`    | transaction detail; `null` when unknown |
| `getTransfersForIdentity()`  | `POST /query/v1/getTransfersForIdentity` | identity transfer history               |
| `getContractCalls()`         | `POST /query/v1/getContractCalls`        | paged contract-call list                |
| `getContracts()`             | `GET /query/v1/getContracts`             | contract catalog                        |
| `tickTransactions()`         | `POST /query/v1/getTransactionsForTick`  | lite tickdata for non-explorer callers  |

The simulator HTTP adapter mirrors these routes so most CLI orchestration does
not branch after constructing `LiteRpc`.

## 16. Command ownership map

Paths below are relative to `packages/cli/src/`.

| Command                | Main implementation                   | Important downstream owner                                  |
| ---------------------- | ------------------------------------- | ----------------------------------------------------------- |
| `setup`                | `commands/setup/setup.tsx`            | `@qinit/core` cache/downloads                               |
| `doctor`               | `commands/setup/doctor.tsx`           | config and tool lookup                                      |
| `clean`                | `commands/setup/clean.tsx`            | `ops/cache.ts`, `ops/node.ts`                               |
| `self-update`          | `commands/setup/update.tsx`           | `ops/update.ts`, `@qinit/core` release helpers              |
| `uninstall`            | `commands/setup/uninstall.tsx`        | filesystem/cache helpers                                    |
| `node run`             | `commands/node/node-run.tsx`          | `ops/node-core.ts`, `ops/node.ts`, engine                   |
| `node status/stop/get` | `commands/node/node.tsx`              | `ops/node.ts`, `LiteRpc`                                    |
| `tick`                 | `commands/node/tick.tsx`              | `LiteRpc` testnet controls                                  |
| `epoch`                | `commands/node/epoch.tsx`             | `LiteRpc` testnet controls                                  |
| `new`                  | `commands/develop/new.tsx`            | `contracts/templates.ts`, IDL/gtest generators              |
| `integrate`            | `commands/develop/integrate.tsx`      | `ops/core-integration.ts`, Git, Core Visual Studio projects |
| `dev`                  | `commands/develop/dev.tsx`            | `ops/project-deploy.ts`, `ops/deploy/`                      |
| `build`                | `commands/develop/build.tsx`          | `ops/project-build.ts`, `@qinit/build`                      |
| `gen`                  | `commands/develop/gen.tsx`            | IDL/client generator                                        |
| `verify`               | `commands/develop/verify.tsx`         | external `contractverify`                                   |
| `deploy`               | `commands/deploy-interact/deploy.tsx` | `ops/project-deploy.ts`, `ops/deploy/`, proto wire codecs   |
| `call`                 | `commands/deploy-interact/call*.tsx`  | proto call helpers, `LiteRpc`                               |
| `seed`                 | `commands/deploy-interact/seed.tsx`   | config store, funded-seed RPC                               |
| `ls`                   | `commands/deploy-interact/ls.tsx`     | registry plus system catalog                                |
| `state`                | `commands/deploy-interact/state.tsx`  | `trace/format.ts`, proto decoders                           |
| `explorer`             | `commands/deploy-interact/explorer/`  | `LiteRpc` explorer read models, `contracts/idl-lookup.ts`   |
| `debug`                | `commands/deploy-interact/debug.tsx`  | `trace/format.ts`, backtrace helpers                        |
| `test`                 | `commands/deploy-interact/test.tsx`   | deploy, generated SDK, Bun tests                            |
| `gtest`                | `commands/deploy-interact/gtest.tsx`  | `ops/corpus-run.ts`, engine                                 |
| `system`               | `commands/deploy-interact/system.tsx` | Core catalog, `contracts/system-wasm.ts`, `LiteRpc`         |
| `ext`                  | `commands/editor/ext.tsx`             | external editor process                                     |
| `runtime`              | `commands/misc/runtime.tsx`           | `commands/misc/backend-picker.tsx`, config store            |
| `compiler`             | `commands/misc/compiler.tsx`          | `commands/misc/backend-picker.tsx`, config store            |
| `theme`                | `commands/misc/theme.tsx`             | config store and `ui/theme.tsx`                             |
| `cheat-sheet`          | `commands/misc/cheat.tsx`             | static Ink view                                             |
| `smoke`                | `commands/misc/smoke.tsx`             | core crypto primitives                                      |
| `version`              | `commands/misc/version.tsx`           | generated/version constant                                  |
| `help`                 | `commands/misc/help.tsx`              | command metadata                                            |

## 17. Tests to run when changing the CLI

The smallest useful validation depends on the boundary changed.

| Change                              | Focused tests                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Metadata or parsing                 | `packages/cli/tests/commands/args.test.ts`, `cli-args.test.ts`, `meta.test.ts`                           |
| Configuration                       | `packages/cli/tests/commands/config.test.ts`                                                             |
| Build JSON or compiler adapter      | `build-json.test.ts`, `build-callee-cli.test.ts`, `contracts/build-contract-with-typescript.test.ts`     |
| Callee parsing/discovery            | `commands/callees.test.ts`, `build/tests/pipeline/project-dependencies.test.ts`                          |
| Core integration                    | `contracts/core-integration.test.ts`, `commands/args.test.ts`, `commands/meta.test.ts`                   |
| Slot planning                       | `contracts/project-slots.test.ts`, `proto/tests/protocol/call.test.ts`                                   |
| Deployment state machine            | `contracts/deploy-ops.test.ts`, `contracts/project-deploy.test.ts`, `integration/simulator.test.ts`      |
| Contract/IDL selection              | `contracts/contracts.test.ts`, `format/idl-file.test.ts`                                                 |
| State and trace decoding            | `format/trace-format.test.ts`, `commands/state-digest*.test.ts`                                          |
| Node preparation/process tracking   | `commands/node-run-core.test.ts`, `rpc/node-ops.test.ts`                                                 |
| Backend identity and simulator RPC  | `core/tests/network/rpc.test.ts`, `engine/tests/network/server.test.ts`, `integration/simulator.test.ts` |
| Explorer read models or views       | `rpc/explorer-rpc.test.ts`, `format/ui-format.test.ts`                                                   |
| Interactive call prompts/completion | `commands/complete.test.ts`                                                                              |
| Gtest orchestration                 | `contracts/corpus-run.test.ts`, `contracts/gtest.test.ts`                                                |
| VS Code project graph               | `vscode/tests/language/project-context.test.ts`, extension integration test                              |
| Cross-runtime contract state        | `integration/cross-host.test.ts`, `integration/wasm-shim-e2e.test.ts`                                    |

The test folders are grouped by concern, not by the `src/` layout, so a test for
`ops/deploy/` still lives in `tests/contracts/deploy-ops.test.ts`.

A normal CLI change should also run:

```bash
bun run typecheck
bun test packages/cli/tests
```

Build the standalone binary when changing startup, imports, embedded assets,
process spawning, or behavior that may differ under `bun build --compile`:

```bash
bun run build:bin
./dist/qinit smoke
```

Live core tests need `QINIT_CORE`. Run a core binary from a temporary working
directory because it writes runtime data relative to its current directory.

## 18. Maintainer change recipes

### Add a command

1. Add the command component under `packages/cli/src/commands/<group>/`, where `<group>` is the
   kebab-cased `META[command].group` (`setup`, `node`, `develop`, `deploy-interact`, `editor`,
   `misc`).
2. Add its canonical name, usage, and complete option schema to `META`, declared beside its group's
   other entries — declaration order is the print order within a group.
3. Import it in `app.tsx` and add a `HANDLERS` entry; the `satisfies
Record<CommandName, CommandHandler>` constraint fails the build otherwise.
4. Accept a `commandArgs: CommandArguments` prop rather than parsing anything
   privately.
5. Decide whether it is one-shot, interactive, or persistent.
6. Define handled failure exit status and non-TTY behavior.
7. If metadata advertises JSON, implement and test one clean JSON line.
8. Add parser/metadata coverage and the smallest domain regression test.

### Add or rename an option

1. Change metadata first; that changes both help and accepted parser options.
2. Update the command to use `has()` for booleans and `getAll()` for repeats.
3. Search scripts, README/docs, workflows, and tests for the old spelling.
4. Test an unknown option and a missing string value through the actual CLI.

### Change deployment

1. Keep rendering concerns in `commands/deploy-interact/deploy.tsx`.
2. Put shared behavior in `ops/deploy/` because dev and test consume it too:
   the pure step model in `steps.ts`, the chunked upload protocol in
   `upload.ts`, the orchestration in `index.ts`.
3. Keep binary formats in `@qinit/proto` and HTTP behavior in `LiteRpc`.
4. Preserve the difference between broadcast, inclusion, armed code, and
   constructed/registered code.
5. Test both direct simulator and chunked protocol branches.

### Change state or trace decoding

1. Start with the source-derived IDL layout.
2. Keep byte decoding in proto/format helpers, not Ink views.
3. Preserve graceful degradation: one unreadable field or container should not
   hide the rest.
4. State whether data is captured with the trace or fetched from current state.
5. Add a byte-level fixture with explicit offsets and expected decoded output.

### Change node startup

1. Preserve header/node alignment checks for explicit local artifacts.
2. Keep process targeting PID-specific.
3. Verify scratch, log, PID, and current-pointer behavior.
4. Test core and detached simulator topology separately.
5. Rebuild the standalone binary; self-spawn behavior differs from Bun source
   execution.

## 19. Current sharp edges and coverage gaps

These are current behaviors, not desired architectural rules. A maintainer
should know them before relying on metadata or a successful exit status.

- Every command `META` advertises as JSON-capable emits a document: `node run` and
  `node status|stop|get`, `tick`, `epoch`, `call`, `state` (a decoded target as well
  as `--digest` and `--dump`), plus `build`, `verify`, `deploy`, `ls`, `ext`, `info`,
  and `version`. An argument error or a crash also emits `{ok, error}` when `--json`
  is set, so a machine caller never has to parse a rendered frame.
- `--json` and `--plain` are accepted by the shared parser for every command,
  while `--plain` is not shown in generated usage. Three commands reject `--json`
  rather than emit: `explorer` outright (it has no structured form, and it also
  refuses a non-TTY stdin), `call` without `--fn`/`--proc`, and `state` without a
  target — the latter two because a prompt would otherwise draw in front of the
  document.
- An unresolved command renders help plus a suggestion and exits 1. A dash-prefixed token is not
  announced as an unknown command name, but it fails the same way.
- An unknown subcommand is only rejected when `--help` is also present.
  Otherwise it stays a positional: `qinit node bogus` reaches `Node` with
  `subcommand: undefined`, and the component falls back to
  `commandArgs.positionals[0]` — which refuses the name, rendering
  `unknown: node bogus` and exiting 1.
- `dev` is a watch session, so its exit status reflects the _last_ redeploy rather
  than the whole run: a failure you have since fixed does not outlive itself, and
  the status is only meaningful at the moment you quit.
- `qinit seed <seed>` saves that seed directly; without one and without a TTY the
  picker cannot be driven, so it fails with that hint rather than waiting on input
  that will never arrive.
- `doctor` resolves core headers without the project's `qinit.json coreDir`.
- `node get` fetches only the binary and may intentionally leave header/node
  version drift.
- `nodeAlive()` can notice an untracked Qubic process while `killNode()` safely
  refuses broad process-name killing. `node stop` therefore cannot always stop
  everything it reports as alive.
- Local system-Wasm cache keys use the header version `local`; source changes at
  the same checkout path can reuse stale cached Wasm until cleanup.
- The system-contract catalog is process-cached by core path, so edits at the
  same path are not observed in that process.
- `clean` and `uninstall` preserve user config, including the saved seed.
- Debug capture is a global node toggle, so concurrent clients can interfere.
- There is no direct rendered-command coverage for doctor, clean, self-update,
  uninstall, or system selection persistence. The `node`/`tick`/`epoch`/`state`
  JSON documents are covered as pure builders
  (`tests/commands/node-json.test.ts`, `state-json.test.ts`), not as rendered
  commands.
  `self-update` is the closest: `tests/commands/update.test.ts` covers the
  download-and-replace helpers thoroughly, but not the Ink command around them.

Treat this section as a checklist when related code changes. Fix a sharp edge at
its shared source of truth, then update this guide and its focused regression
test together.

## 20. Release boundary

[`scripts/release/build-host.ts`](../scripts/release/build-host.ts) compiles the
current host binary from `packages/cli/src/index.tsx`. [`build-matrix.ts`](../scripts/release/build-matrix.ts)
targets Linux x64/arm64, macOS x64/arm64, and Windows x64.

The resulting executable contains the CLI and workspace packages it imports;
Qinit does not currently publish those workspace packages to npm. The binary
still downloads runtime assets such as core headers, the node, WASI SDK, and
the verifier through their release manifests.

When a change works under `bun run dev` but fails only in the binary, inspect
these boundaries first:

- dynamic imports and embedded text assets;
- `Bun.main` and `process.execPath`;
- simulator self-spawn arguments;
- filesystem paths derived from `import.meta.dir`;
- child tools expected beside WASI clang;
- TTY detection and Ink exit timing.
