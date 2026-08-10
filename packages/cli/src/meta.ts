import { DEFAULT_PEER_PORT } from "@qinit/core";

export interface OptionMeta {
  name: string;
  type: "string" | "boolean";
  description: string;
  valueLabel?: string;
  multiple?: boolean;
  hidden?: boolean;
}

interface SubcommandMeta {
  options: OptionMeta[];
}

export interface CommandMeta {
  summary: string;
  group: string;
  usage?: string;
  options?: OptionMeta[];
  subcommands?: Record<string, SubcommandMeta>;
  examples?: string[];
  json?: boolean;
}

const stringOption = (
  name: string,
  valueLabel: string,
  description: string,
  extra: Pick<OptionMeta, "multiple" | "hidden"> = {},
): OptionMeta => ({
  name,
  type: "string",
  valueLabel,
  description,
  ...extra,
});

const booleanOption = (
  name: string,
  description: string,
  extra: Pick<OptionMeta, "hidden"> = {},
): OptionMeta => ({
  name,
  type: "boolean",
  description,
  ...extra,
});

export function optionSyntax(option: OptionMeta): string {
  return `--${option.name}${option.valueLabel ? ` ${option.valueLabel}` : ""}`;
}

export const GROUP_ORDER = [
  "setup",
  "node",
  "develop",
  "deploy & interact",
  "editor",
  "misc",
];

const commandMeta = {
  setup: {
    group: "setup",
    summary: "install dependencies and offer available updates",
    options: [booleanOption("force", "install available updates without prompting")],
  },
  doctor: {
    group: "setup",
    summary: "check toolchain (sdk, core headers, contract verifier)",
  },
  clean: {
    group: "setup",
    summary: "remove all qinit cache (node, headers, sdk, tools)",
    options: [booleanOption("dry-run", "preview what would be removed")],
  },
  "update": {
    group: "setup",
    summary: "update qinit cli binary to the newest release",
    options: [
      booleanOption("force", "update even if already latest"),
      booleanOption("dry-run", "show what would happen"),
    ],
  },
  uninstall: {
    group: "setup",
    summary: "remove qinit + its cache",
    options: [
      booleanOption("yes", "skip the confirmation"),
      booleanOption("keep-cache", "leave the cache in place"),
      booleanOption("dry-run", "preview"),
    ],
  },

  node: {
    group: "node",
    json: true,
    summary:
      "start the node, status, stop, get",
    usage: "<run|status|stop|get> [--ref <tag>] [--rpc <url>]",
    options: [
      stringOption("ref", "<tag>", "explicitly fetch/select a node or headers release"),
      stringOption("rpc", "<url>", "node RPC base"),
    ],
    subcommands: {
      run: {
        options: [
          stringOption(
            "core-dir",
            "<path>",
            "use a local core-lite checkout (core backend also requires --node-bin)",
          ),
          stringOption("node-bin", "<path>", "run this core-lite node binary (skip fetch)"),
          stringOption("tick-ms", "<n>", "simulator tick interval in ms (0 = fastest)"),
          stringOption(
            "peer-port",
            "<n>",
            `simulator Qubic TCP peer port (default ${DEFAULT_PEER_PORT})`,
          ),
          stringOption("wait", "<s>", "seconds to wait for ticking"),
          stringOption("scratch-dir", "<path>", "node runtime and log directory"),
          stringOption("node-mode", "<n>", "core-lite node mode"),
          stringOption("peers", "<addr>", "core-lite node peer address"),
          stringOption(
            "node-backend",
            "<core|simulator>",
            "override the saved node backend for this run",
          ),
          stringOption(
            "compiler",
            "<clang|typescript>",
            "compiler for simulator system contracts",
          ),
          booleanOption("restart", "force a fresh node even if one is ticking"),
          booleanOption("offline", "use only cached node/headers (no network)"),
          booleanOption("keep", "preserve existing scratch-directory contents before launch"),
        ],
      },
      status: { options: [] },
      stop: { options: [] },
      get: { options: [] },
    },
  },
  tick: {
    group: "node",
    json: true,
    summary: "show epoch tick window; advance ticks; set the simulator tick rate",
    usage: "[show | advance <n> | advance-to-last [gap] | rate <ms>]",
    options: [stringOption("rpc", "<url>", "node RPC base")],
  },
  epoch: {
    group: "node",
    json: true,
    summary: "show epoch info; advance -> next epoch via seamless transition",
    usage: "[show | advance]",
    options: [stringOption("rpc", "<url>", "node RPC base")],
  },
  new: {
    group: "develop",
    summary: "scaffold a project",
    usage: "<name> [--template counter|hashmap|asset|intercontract]",
    options: [
      stringOption("template", "<t>", "starter template (default: counter)"),
      stringOption("core-dir", "<path>", "core-lite headers checkout"),
    ],
    examples: ["qinit new mytoken --template asset"],
  },
  dev: {
    group: "develop",
    summary: "watch a contract graph -> auto build+deploy on save (q to quit)",
    usage: "[<file.h>]",
    options: [
      stringOption("contract", "<file.h>", "contract header (alternative to the positional)"),
      stringOption("contract-name", "<n>", "contract name"),
      stringOption("slot", "<n>", "contract slot override"),
      stringOption("core-dir", "<path>", "core-lite headers checkout"),
      stringOption("rpc", "<url>", "node RPC base"),
      stringOption("seed", "<seed>", "signer seed"),
      stringOption("callee", "<n>=<hdr>[@<i>]", "optional callee source/slot override", {
        multiple: true,
      }),
      stringOption("compiler", "<clang|typescript>", "override the saved compiler backend"),
      booleanOption("skip-verify", "skip the protocol-rule check (dev/testing only)"),
    ],
  },
  build: {
    group: "develop",
    json: true,
    summary: "compile a contract graph -> bytecode (+ K12 hash, IDL)",
    usage: "<file.h>",
    options: [
      stringOption("contract", "<file.h>", "contract header (alternative to the positional)"),
      stringOption("contract-name", "<n>", "contract name"),
      stringOption("out", "<dir>", "output dir"),
      stringOption("slot", "<n>", "contract slot"),
      stringOption("core-dir", "<path>", "core-lite headers checkout"),
      stringOption(
        "rpc",
        "<url>",
        "node RPC for reusing deployed slots; offline builds use hypothetical slots",
      ),
      stringOption("callee", "<n>=<hdr>[@<i>]", "optional callee source/slot override", {
        multiple: true,
      }),
      stringOption("compiler", "<clang|typescript>", "override the saved compiler backend"),
      booleanOption("skip-verify", "skip the protocol-rule check (dev/testing only)"),
    ],
  },
  gen: {
    group: "develop",
    summary: "generate a typed TS client from the contract IDL",
    usage: "<file.h>",
    options: [
      stringOption("contract", "<file.h>", "contract header (alternative to the positional)"),
      stringOption("contract-name", "<n>", "contract name"),
      stringOption("out", "<dir>", "output dir"),
      stringOption("slot", "<n>", "contract slot"),
      stringOption("core-dir", "<path>", "core-lite headers checkout"),
    ],
  },
  verify: {
    group: "develop",
    json: true,
    summary: "check a contract against the qpi protocol rules",
    usage: "<file.h>",
    options: [
      stringOption("contract", "<file.h>", "contract header (alternative to the positional)"),
      stringOption("contract-name", "<n>", "contract name"),
      stringOption("core-dir", "<path>", "core-lite headers checkout"),
      stringOption("callee", "<n>=<hdr>[@<i>]", "optional callee source/slot override", {
        multiple: true,
      }),
    ],
  },

  deploy: {
    group: "deploy & interact",
    json: true,
    summary: "build + synchronize a contract graph, then deploy Main",
    usage: "<file.h> [--contract-name <n>] [--slot <n>]",
    options: [
      stringOption("contract", "<file.h>", "contract header (alternative to the positional)"),
      stringOption("contract-name", "<n>", "contract name (default: file basename)"),
      stringOption("slot", "<n>", "deploy to a specific slot"),
      stringOption("core-dir", "<path>", "core-lite headers checkout"),
      stringOption("rpc", "<url>", "node RPC base"),
      stringOption("seed", "<seed>", "signer seed"),
      stringOption("callee", "<n>=<hdr>[@<i>]", "optional callee source/slot override", {
        multiple: true,
      }),
      stringOption("compiler", "<clang|typescript>", "override the saved compiler backend"),
      booleanOption("skip-verify", "skip the protocol-rule check (dev/testing only)"),
    ],
    examples: ["qinit deploy ./mytoken.h --contract-name Mytoken"],
  },
  call: {
    group: "deploy & interact",
    json: true,
    summary: "call a contract's function or procedure",
    usage: '[ --fn|--proc <contract> <fn|proc> ] [--in "<fmt>"] [--out <type> ]',
    options: [
      booleanOption("fn", "read-only query"),
      booleanOption("proc", "signs a tx + waits for it to process"),
      stringOption("args", "<json>", "encode input from a JSON value"),
      stringOption("in", '"<fmt>"', 'input, e.g. "<ID>id, 100uint64"'),
      stringOption("out", "<type>", "decode the output as this type"),
      stringOption("amount", "<n>", "procedure transfer amount"),
      booleanOption("trace", "post-call state-diff/host-call view"),
      booleanOption("trace-full", "same, with the container internals behind each change"),
      booleanOption("all", "show zero and empty output fields"),
      booleanOption("no-settle", "return after broadcasting without waiting"),
      stringOption("rpc", "<url>", "node RPC base"),
      stringOption("seed", "<seed>", "signer seed"),
    ],
    examples: [
      "qinit call # interactive mode",
      'qinit call --proc Mytoken 1 --in "<ID>id, 100uint64"',
      'qinit call --fn   Mytoken 1 --in "<ID>id" --out uint64',
    ],
  },
  seed: {
    group: "deploy & interact",
    summary: "pick a funded signer seed (saved + auto-used everywhere)",
    usage: "[<seed>]",
    options: [
      booleanOption("show", "print the saved seed"),
      booleanOption("clear", "forget the saved seed"),
      stringOption("rpc", "<url>", "node RPC base"),
    ],
  },
  ls: {
    group: "deploy & interact",
    json: true,
    summary: "list contracts deployed on the node (slot / name / state / hash)",
    options: [stringOption("rpc", "<url>", "node RPC base")],
  },
  state: {
    group: "deploy & interact",
    json: true,
    summary: "decode + print a deployed contract's current state",
    usage: "[<target>]",
    options: [
      booleanOption("digest", "print the node's canonical full-state K12 digest"),
      booleanOption("dump", "write the raw state image to state/<Name>_dump.bin"),
      stringOption("out", "<path>", "dump destination file or directory (with --dump)"),
      stringOption("container", "<index>", "load a state container by its shown index", {
        multiple: true,
      }),
      booleanOption("all", "load every state container"),
      stringOption("rpc", "<url>", "node RPC base"),
    ],
  },
  explorer: {
    group: "deploy & interact",
    summary:
      "interactive chain explorer — live ticks, transactions, identities, contracts, wallet",
    usage: "[<tick|txid|identity>]",
    options: [stringOption("rpc", "<url>", "node RPC base")],
    examples: [
      "qinit explorer # interactive mode",
      "qinit explorer 7474 # quick jump to tick",
      "qinit explorer <identity> # quick jump ID details",
    ],
  },
  debug: {
    group: "deploy & interact",
    summary: "live contract call inspector — input/output, state diff, host-calls, traps",
    usage: "<Contract>",
    options: [
      stringOption("contract", "<name|slot>", "show only one contract"),
      stringOption("rpc", "<url>", "node RPC base"),
    ],
  },
  test: {
    group: "deploy & interact",
    summary: "deploy a contract graph + run Bun tests on the selected backend",
    usage: "[<file.h>]",
    options: [
      stringOption("contract", "<file.h>", "contract header (alternative to the positional)"),
      stringOption("contract-name", "<n>", "contract name"),
      stringOption("slot", "<n>", "contract slot override"),
      stringOption("core-dir", "<path>", "core-lite headers checkout"),
      stringOption("callee", "<n>=<hdr>[@<i>]", "optional callee source/slot override", {
        multiple: true,
      }),
      stringOption("filter", "<pat>", "test name filter"),
      stringOption("node-bin", "<path>", "core-lite node binary"),
      stringOption("ref", "<tag>", "node release to use"),
      stringOption("rpc", "<url>", "node RPC base"),
      stringOption("node-mode", "<n>", "core-lite node mode"),
      stringOption("peers", "<addr>", "core-lite node peer address"),
      stringOption("wait", "<s>", "seconds to wait for ticking"),
      stringOption("seed", "<seed>", "signer seed"),
      stringOption("timeout", "<ms>", "Bun test timeout"),
      stringOption(
        "node-backend",
        "<core|simulator>",
        "override the saved node backend for this run",
      ),
      stringOption("compiler", "<clang|typescript>", "override the saved compiler backend"),
      booleanOption("keep-node", "leave a core node launched by this test running"),
      booleanOption("skip-verify", "skip the protocol-rule check (dev/testing only)"),
    ],
  },
  gtest: {
    group: "deploy & interact",
    summary: "run a contract's core-lite contract_testing.h gtest on an isolated simulator",
    usage: "[<test.cpp>]",
    options: [
      stringOption("contract", "<file.h>", "contract under test (default: qinit.json)"),
      stringOption("contract-name", "<Name>", "contract name override"),
      stringOption("state-type", "<T>", "C++ contract struct type, if it differs from the name"),
      stringOption("slot", "<n>", "main contract slot override (default: auto)"),
      stringOption("callee", "<Name>=<header>[@<index>]", "optional callee source/slot override", {
        multiple: true,
      }),
      stringOption("filter", "<pat>", "test name substring filter"),
      stringOption("core-dir", "<path>", "core-lite headers (with test/contract_testing.h)"),
      stringOption(
        "corpus",
        "<NAME>",
        "run a built-in system contract gtest (core-lite contract_<x>.cpp)",
      ),
      booleanOption("new", "(re)scaffold tests/<Name>.test.cpp from the IDL"),
      stringOption("compiler", "<clang|typescript>", "override the saved compiler backend"),
      booleanOption("shared-mem", "run the contract in shared-memory mode"),
    ],
  },

  ext: {
    group: "editor",
    json: true,
    summary: "install the VS Code / Cursor extension (QPI IntelliSense + live diagnostics)",
    usage: "install [--vsix <path>] [--editor <cmd>]",
    options: [
      stringOption("vsix", "<path>", "install a local .vsix instead of the marketplace build"),
      stringOption("editor", "<cmd>", "code | cursor | windsurf | codium"),
    ],
  },

  "node-backend": {
    group: "misc",
    summary: "pick the default node backend: core-lite node or in-process simulator",
    usage: "[core|simulator]",
    options: [booleanOption("show", "print the current node backend")],
  },
  compiler: {
    group: "misc",
    summary:
      "pick the compiler for build/deploy/dev/test/gtest and simulator system Wasm",
    usage: "[clang|typescript]",
    options: [booleanOption("show", "print the current compiler")],
  },
  system: {
    group: "deploy & interact",
    summary: "manage simulator system Wasm; report Core-embedded contracts",
    usage: "[ls | add <name…> | rm <name…>]",
    options: [
      stringOption("rpc", "<url>", "node RPC base"),
      stringOption("compiler", "<clang|typescript>", "system Wasm compiler"),
    ],
    examples: ["qinit system add QX QEARN", "qinit system ls"],
  },
  theme: {
    group: "misc",
    summary: "pick a UI color variant (default|emerald|ocean|rose|amber|mono); applies everywhere",
    usage: "[<name>]",
    options: [booleanOption("show", "print the current theme")],
  },
  "cheat-sheet": {
    group: "misc",
    summary: "one-screen guide: setup -> contract -> deploy -> call (+ input/output formats)",
  },
  smoke: { group: "misc", summary: "run the standalone-binary crypto smoke test" },
  version: { group: "misc", json: true, summary: "print version" },
  help: { group: "misc", summary: "show this help" },
} satisfies Record<string, CommandMeta>;

export type CommandName = keyof typeof commandMeta;
export const META: Record<CommandName, CommandMeta> = commandMeta;

export function isCommandName(command: string): command is CommandName {
  return Object.prototype.hasOwnProperty.call(META, command);
}

export function commandOptions(
  command: CommandName,
  subcommand?: string,
): OptionMeta[] {
  const meta: CommandMeta = META[command];
  return [
    ...(meta.options ?? []),
    ...(subcommand ? (meta.subcommands?.[subcommand]?.options ?? []) : []),
  ];
}

// Canonical command names (for routing checks + did-you-mean). Aliases (cheat, -v, ...) handled in the router.
export const COMMANDS = Object.keys(META) as CommandName[];
