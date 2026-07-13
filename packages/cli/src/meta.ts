// Single source of truth for the command surface: drives the global help (grouped), per-command help
// (`qinit <cmd> --help`), and the "did you mean?" suggestion. Keep flags here in sync with each command.
export type Flag = [flag: string, desc: string];
export interface CommandMeta {
  summary: string; // one-line, shown in the global help
  group: string;
  usage?: string; // the tail after `qinit <cmd>` (positionals + shape)
  flags?: Flag[];
  examples?: string[]; // `qinit ...` example lines (+ free-text notes)
  json?: boolean; // supports --json (machine-readable result)
}
export const GROUP_ORDER = ["setup & node", "develop", "deploy & interact", "misc"];

export const META: Record<string, CommandMeta> = {
  doctor: {
    group: "setup & node",
    summary: "check toolchain (wasi-sdk, node.js, core headers, qubic lib)",
  },
  ext: {
    group: "setup & node",
    json: true,
    summary: "install the VS Code / Cursor extension (QPI IntelliSense + live diagnostics)",
    usage: "install [--vsix <path>] [--editor <cmd>]",
    flags: [
      ["--vsix <path>", "install a local .vsix instead of the marketplace build"],
      ["--editor <cmd>", "code | cursor | windsurf | codium"],
    ],
  },
  node: {
    group: "setup & node",
    json: true,
    summary:
      "bring up + manage the dev node: run (sync headers+wasm, get node, launch), status, stop, get",
    usage: "<run|status|stop|get> [--ref <tag>] [--restart] [--offline] [--bin <path>]",
    flags: [
      ["--ref <tag>", "node/headers release to use (default: latest)"],
      ["--restart", "force a fresh node even if one is ticking"],
      ["--offline", "use only cached node/headers (no network)"],
      ["--bin <path>", "run a local node binary (skip fetch)"],
      ["--tick-ms <n>", "virtualnode: ms between ticks (default 1000; 0 = fastest)"],
      ["--peer-port <n>", "virtualnode: Qubic TCP peer port for native clients (default 21841)"],
      ["--keep", "keep the node's scratch dir"],
      ["--rpc <url>", "node RPC base"],
      ["--wait <s>", "seconds to wait for ticking"],
      ["--real", "use a real ephemeral node this run (override `qinit mode`)"],
      ["--virtual", "use the in-process engine this run"],
    ],
  },
  tick: {
    group: "setup & node",
    json: true,
    summary: "show epoch tick window; advance ticks (testnet); set the virtual node's tick rate",
    usage: "[show | advance <n> | advance-to-last [gap] | rate <ms>]",
    flags: [["--rpc <url>", "node RPC base"]],
  },
  epoch: {
    group: "setup & node",
    json: true,
    summary: "show epoch info; advance -> next epoch via seamless transition (testnet)",
    usage: "[show | advance]",
    flags: [["--rpc <url>", "node RPC base"]],
  },
  clean: {
    group: "setup & node",
    summary: "remove all qinit cache (node, headers, wasi-sdk, tools)",
    flags: [["--dry-run", "preview what would be removed"]],
  },
  "self-update": {
    group: "setup & node",
    summary: "update qinit to the newest release",
    flags: [
      ["--force", "update even if already latest"],
      ["--dry-run", "show what would happen"],
    ],
  },
  uninstall: {
    group: "setup & node",
    summary: "remove qinit + its cache",
    flags: [
      ["--yes", "skip the confirmation"],
      ["--keep-cache", "leave the cache in place"],
      ["--dry-run", "preview"],
    ],
  },

  new: {
    group: "develop",
    summary: "scaffold a project",
    usage: "<name> [--template counter|hashmap|asset|intercontract]",
    flags: [
      ["--template <t>", "starter template (default: counter)"],
      ["--core <path>", "core headers checkout"],
    ],
    examples: ["qinit new mytoken --template asset"],
  },
  dev: {
    group: "develop",
    summary: "watch the contract -> auto build+deploy on save (q to quit)",
    usage: "[<file.h>]",
    flags: [
      ["--rpc <url>", "node RPC base"],
      ["--seed <seed>", "signer seed"],
      ["--native", "force clang (override `qinit compiler`)"],
      ["--local", "force the in-process TS compiler (override `qinit compiler`)"],
      ["--skip-verify", "skip the protocol-rule check (dev/testing only)"],
    ],
  },
  build: {
    group: "develop",
    summary: "compile a contract .h -> wasm (+ K12 hash, IDL)",
    usage: "<file.h>",
    flags: [
      ["--name <n>", "contract name"],
      ["--out <dir>", "output dir"],
      ["--slot <n>", "contract slot"],
      ["--core <path>", "core headers checkout"],
      ["--native", "force clang (override `qinit compiler`)"],
      ["--local", "force the in-process TS compiler (override `qinit compiler`)"],
      ["--skip-verify", "skip the protocol-rule check (dev/testing only)"],
    ],
  },
  gen: {
    group: "develop",
    summary: "generate a typed TS client from the contract IDL",
    usage: "<file.h>",
    flags: [
      ["--name <n>", "contract name"],
      ["--out <dir>", "output dir"],
      ["--slot <n>", "contract slot"],
    ],
  },
  verify: {
    group: "develop",
    json: true,
    summary: "check a contract against the qpi.h protocol rules (contractverify)",
    usage: "<file.h>",
    flags: [
      ["--name <n>", "contract name"],
      ["--callee <n>=<hdr>@<i>", "declared inter-contract callee (repeatable)"],
    ],
  },

  deploy: {
    group: "deploy & interact",
    json: true,
    summary: "build + chunk-upload + deploy a contract to a node",
    usage: "<file.h> [--name <n>] [--slot <n>]",
    flags: [
      ["--name <n>", "contract name (default: file basename)"],
      ["--slot <n>", "deploy to a specific slot"],
      ["--core <path>", "core headers checkout"],
      ["--rpc <url>", "node RPC base"],
      ["--seed <seed>", "signer seed"],
      ["--callee <n>=<hdr>@<i>", "wire a dynamic inter-contract callee (repeatable)"],
      ["--native", "force clang (override `qinit compiler`)"],
      ["--local", "force the in-process TS compiler (override `qinit compiler`)"],
      ["--skip-verify", "skip the protocol-rule check (dev/testing only)"],
    ],
    examples: ["qinit deploy ./mytoken.h --name Mytoken"],
  },
  call: {
    group: "deploy & interact",
    json: true,
    summary: "call a fn (--fn) / proc (--proc) on a deployed contract",
    usage: '<--fn|--proc> <contract> <fn|proc> [--in "<fmt>"] [--out <type>]',
    flags: [
      ["--fn", "read-only query"],
      ["--proc", "signs a tx + waits for it to process"],
      ['--in "<fmt>"', 'input, e.g. "<ID>id, 100uint64"'],
      ["--out <type>", "decode the output as this type"],
      ["--trace", "post-call state-diff/host-call view"],
      ["--rpc <url>", "node RPC base"],
      ["--seed <seed>", "signer seed"],
    ],
    examples: [
      'qinit call --proc Mytoken 1 --in "<ID>id, 100uint64"',
      'qinit call --fn   Mytoken 1 --in "<ID>id" --out uint64',
    ],
  },
  seed: {
    group: "deploy & interact",
    summary: "pick a funded signer seed (saved + auto-used everywhere)",
    usage: "[<seed>]",
    flags: [
      ["--show", "print the saved seed"],
      ["--clear", "forget the saved seed"],
    ],
  },
  ls: {
    group: "deploy & interact",
    json: true,
    summary: "list contracts deployed on the node (slot / name / state / hash)",
    flags: [["--rpc <url>", "node RPC base"]],
  },
  state: {
    group: "deploy & interact",
    json: true,
    summary: "decode + print a deployed contract's current state",
    usage: "[<target>]",
    flags: [
      ["--all", "include zero/empty fields"],
      ["--rpc <url>", "node RPC base"],
    ],
  },
  debug: {
    group: "deploy & interact",
    summary: "live contract-call inspector — input/output, state diff, host-calls, traps",
    usage: "<Contract>",
    flags: [["--rpc <url>", "node RPC base"]],
  },
  test: {
    group: "deploy & interact",
    summary: "deploy + run bun tests against the node (real or virtual per `qinit mode`)",
    usage: "[<file.h>]",
    flags: [
      ["--in-process", "force the in-process virtual engine (overrides `qinit mode`)"],
      ["--real", "force a real ephemeral node (overrides `qinit mode`)"],
      ["--native", "force clang (override `qinit compiler`)"],
      ["--local", "force the in-process TS compiler (override `qinit compiler`)"],
      ["--filter <pat>", "test name filter"],
      ["--keep", "keep the ephemeral node after"],
      ["--bin <path>", "node binary"],
      ["--rpc <url>", "node RPC base"],
    ],
  },
  gtest: {
    group: "deploy & interact",
    summary: "run a contract's core-lite contract_testing.h gtest on a fresh isolated virtual node",
    usage: "[<test.cpp>]",
    flags: [
      ["--contract <file.h>", "contract under test (default: qinit.json)"],
      ["--name <Name>", "contract name override"],
      ["--state-type <T>", "C++ contract struct type, if it differs from the name"],
      ["--filter <pat>", "test name substring filter"],
      ["--new", "(re)scaffold tests/<Name>.test.cpp from the IDL"],
      ["--core <path>", "core-lite headers (with test/contract_testing.h)"],
      ["--local", "build the contract-under-test with the in-process TS compiler"],
      ["--shared-mem", "run the contract in shared-memory mode (huge-state suites)"],
      [
        "--corpus <NAME>",
        "run a built-in system contract's gtest by name (core-lite contract_<x>.cpp)",
      ],
    ],
  },

  mode: {
    group: "misc",
    summary:
      "pick the node backend for every node command: realnode (qubic node binary) or virtualnode (in-process engine)",
    usage: "[realnode|virtualnode]",
    flags: [["--show", "print the current mode"]],
  },
  compiler: {
    group: "misc",
    summary:
      "pick the contract compiler for build/deploy/dev/test: native (clang) or local (in-process TS, no toolchain)",
    usage: "[native|local]",
    flags: [["--show", "print the current compiler"]],
  },
  system: {
    group: "deploy & interact",
    summary:
      "virtualnode: deploy chosen built-in system contracts (QX, QEARN, …) onto the in-process node",
    usage: "[ls | add <name…> | rm <name…>]",
    flags: [["--rpc <url>", "node RPC base"]],
    examples: ["qinit system add QX QEARN", "qinit system ls"],
  },
  theme: {
    group: "misc",
    summary: "pick a UI color variant (default|emerald|ocean|rose|amber|mono); applies everywhere",
    usage: "[<name>]",
    flags: [["--show", "print the current theme"]],
  },
  "cheat-sheet": {
    group: "misc",
    summary: "one-screen guide: setup -> contract -> deploy -> call (+ input/output formats)",
  },
  smoke: { group: "misc", summary: "run the standalone-binary crypto smoke test" },
  version: { group: "misc", json: true, summary: "print version" },
  help: { group: "misc", summary: "show this help" },
};

// Canonical command names (for routing checks + did-you-mean). Aliases (cheat, -v, ...) handled in the router.
export const COMMANDS = Object.keys(META);
