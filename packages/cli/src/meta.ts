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
    // Kept out of the help listing and typo suggestions; still routed, parsed and runnable.
    hidden?: boolean;
}

const stringOption = (name: string, valueLabel: string, description: string, extra: Pick<OptionMeta, "multiple" | "hidden"> = {}): OptionMeta => ({
    name,
    type: "string",
    valueLabel,
    description,
    ...extra,
});

const booleanOption = (name: string, description: string, extra: Pick<OptionMeta, "hidden"> = {}): OptionMeta => ({
    name,
    type: "boolean",
    description,
    ...extra,
});

export function optionSyntax(option: OptionMeta): string {
    return `--${option.name}${option.valueLabel ? ` ${option.valueLabel}` : ""}`;
}

export const GROUP_ORDER = ["setup", "node", "develop", "deploy & interact", "editor", "misc"];

const commandMeta = {
    setup: {
        group: "setup",
        summary: "install required tools and check for updates",
        options: [booleanOption("force", "install updates without prompting")],
    },
    doctor: {
        group: "setup",
        json: true,
        summary: "check the Qinit development setup",
    },
    clean: {
        group: "setup",
        json: true,
        summary: "remove cached node, headers, SDK, and tools",
        options: [booleanOption("dry-run", "preview what would be removed")],
    },
    update: {
        group: "setup",
        summary: "update the Qinit CLI",
        options: [booleanOption("force", "update even if already latest"), booleanOption("dry-run", "preview the update")],
    },
    uninstall: {
        group: "setup",
        summary: "remove Qinit and its cache",
        options: [
            booleanOption("yes", "skip confirmation"),
            booleanOption("keep-cache", "preserve the cache"),
            booleanOption("dry-run", "preview what would be removed"),
        ],
    },

    node: {
        group: "node",
        json: true,
        summary: "manage the local node",
        usage: "<run|status|stop|get> [--ref <tag>] [--rpc <url>]",
        options: [stringOption("ref", "<tag>", "node and headers release"), stringOption("rpc", "<url>", "RPC URL")],
        subcommands: {
            run: {
                options: [
                    stringOption("core-dir", "<path>", "Core checkout (Core runtime also requires --node-bin)"),
                    stringOption("node-bin", "<path>", "Core node binary (skip download)"),
                    stringOption("tick-ms", "<n>", "simulator tick interval in ms (0 = fastest)"),
                    stringOption("history-ticks", "<n>", "retained finalized-tick window (default: unlimited)"),
                    booleanOption("full-tick", "record quorum/votes for empty ticks too (disable lite ticking)"),
                    stringOption("peer-port", "<n>", `simulator peer port (default: ${DEFAULT_PEER_PORT})`),
                    stringOption("wait", "<s>", "node start timeout in seconds"),
                    stringOption("scratch-dir", "<path>", "node data and log directory"),
                    stringOption("node-mode", "<n>", "Core node mode"),
                    stringOption("peers", "<addr>", "Core peer address"),
                    stringOption("runtime", "<core|simulator>", "runtime for this run"),
                    stringOption("compiler", "<clang|typescript>", "simulator system-contract compiler"),
                    booleanOption("restart", "restart even if the node is running"),
                    booleanOption("offline", "use cached files without network access"),
                    booleanOption("keep", "preserve existing node data"),
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
        summary: "show or control ticks",
        usage: "[show | advance <n> | advance-to-last [gap] | rate <ms>]",
        options: [stringOption("rpc", "<url>", "RPC URL")],
    },
    epoch: {
        group: "node",
        json: true,
        summary: "show or advance the epoch",
        usage: "[show | advance]",
        options: [stringOption("rpc", "<url>", "RPC URL")],
    },
    new: {
        group: "develop",
        summary: "create a contract project",
        usage: "<name> [--template counter|hashmap|asset|intercontract]",
        options: [stringOption("template", "<t>", "project template (default: counter)"), stringOption("core-dir", "<path>", "Core checkout")],
        examples: ["qinit new mytoken --template asset"],
    },
    integrate: {
        group: "develop",
        json: true,
        summary: "add or update a contract in Qubic Core",
        usage: "[<file.h>] [--asset <symbol> --construction-epoch <n>]",
        options: [
            stringOption("contract", "<file.h>", "contract header"),
            stringOption("contract-name", "<name>", "contract name"),
            stringOption("out", "<dir>", "Qubic Core checkout"),
            stringOption("asset", "<symbol>", "asset symbol"),
            stringOption("construction-epoch", "<n>", "first active epoch"),
            stringOption("destruction-epoch", "<n>", "first inactive epoch (default: 10000)"),
        ],
        examples: ["qinit integrate ./contracts/Mytoken.h --asset MYTOKEN --construction-epoch 200"],
    },
    dev: {
        group: "develop",
        summary: "watch and redeploy on source changes",
        usage: "[<file.h>]",
        options: [
            stringOption("contract", "<file.h>", "contract header"),
            stringOption("contract-name", "<name>", "contract name"),
            stringOption("slot", "<n>", "deployment slot"),
            stringOption("core-dir", "<path>", "Core checkout"),
            stringOption("rpc", "<url>", "RPC URL"),
            stringOption("seed", "<seed>", "signer seed"),
            stringOption("callee", "<n>=<hdr>[@<i>]", "callee header and optional slot", {
                multiple: true,
            }),
            stringOption("compiler", "<clang|typescript>", "compiler for this run"),
            booleanOption("skip-verify", "skip compatibility checks (development only)"),
        ],
    },
    build: {
        group: "develop",
        json: true,
        summary: "build a contract",
        usage: "<file.h>",
        options: [
            booleanOption("production", "build without cheatcodes, as Core will"),
            stringOption("contract", "<file.h>", "contract header"),
            stringOption("contract-name", "<name>", "contract name"),
            stringOption("out", "<dir>", "output directory"),
            stringOption("slot", "<n>", "contract slot"),
            stringOption("core-dir", "<path>", "Core checkout"),
            stringOption("rpc", "<url>", "RPC URL (offline builds assign local slots)"),
            stringOption("callee", "<n>=<hdr>[@<i>]", "callee header and optional slot", {
                multiple: true,
            }),
            stringOption("compiler", "<clang|typescript>", "compiler for this run"),
            booleanOption("skip-verify", "skip compatibility checks (development only)"),
        ],
    },
    gen: {
        group: "develop",
        json: true,
        summary: "generate a TypeScript client",
        usage: "<file.h>",
        options: [
            stringOption("contract", "<file.h>", "contract header"),
            stringOption("contract-name", "<name>", "contract name"),
            stringOption("out", "<dir>", "output directory"),
            stringOption("slot", "<n>", "contract slot"),
            stringOption("core-dir", "<path>", "Core checkout"),
        ],
    },
    strip: {
        group: "develop",
        json: true,
        summary: "remove cheatcodes from a contract",
        usage: "<file.h>",
        options: [stringOption("contract", "<file.h>", "contract header"), stringOption("out", "<file.h>", "write here instead of stdout")],
        examples: ["qinit strip contracts/Mytoken.h --out /tmp/Mytoken.clean.h"],
    },
    verify: {
        group: "develop",
        json: true,
        summary: "check QPI compatibility",
        usage: "<file.h>",
        options: [
            stringOption("contract", "<file.h>", "contract header"),
            stringOption("contract-name", "<name>", "contract name"),
            stringOption("core-dir", "<path>", "Core checkout"),
            stringOption("callee", "<n>=<hdr>[@<i>]", "callee header and optional slot", {
                multiple: true,
            }),
        ],
    },

    deploy: {
        group: "deploy & interact",
        json: true,
        summary: "deploy a contract and its dependencies",
        usage: "<file.h> [--contract-name <name>] [--slot <n>]",
        options: [
            stringOption("contract", "<file.h>", "contract header"),
            stringOption("contract-name", "<name>", "contract name (default: file basename)"),
            stringOption("slot", "<n>", "deployment slot"),
            stringOption("core-dir", "<path>", "Core checkout"),
            stringOption("rpc", "<url>", "RPC URL"),
            stringOption("seed", "<seed>", "signer seed"),
            stringOption("callee", "<n>=<hdr>[@<i>]", "callee header and optional slot", {
                multiple: true,
            }),
            booleanOption("production", "build without cheatcodes, as Core will"),
            stringOption("compiler", "<clang|typescript>", "compiler for this run"),
            booleanOption("skip-verify", "skip compatibility checks (development only)"),
        ],
        examples: ["qinit deploy ./mytoken.h --contract-name Mytoken"],
    },
    call: {
        group: "deploy & interact",
        json: true,
        summary: "call a contract function or procedure",
        usage: '[ --fn|--proc <contract> <fn|proc> ] [--in "<fmt>"] [--out <type> ]',
        options: [
            booleanOption("fn", "make a read-only call"),
            booleanOption("proc", "send a signed call and wait for it"),
            stringOption("args", "<json>", "JSON input"),
            stringOption("in", '"<fmt>"', 'input, e.g. "<ID>id, 100uint64"'),
            stringOption("out", "<type>", "output type"),
            stringOption("amount", "<n>", "transfer amount"),
            booleanOption("trace", "show state changes and contract calls"),
            booleanOption("trace-full", "include container details"),
            booleanOption("all", "show zero and empty fields"),
            booleanOption("no-settle", "return without waiting for processing"),
            stringOption("rpc", "<url>", "RPC URL"),
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
        json: true,
        summary: "manage the transaction signer seed",
        usage: "[<seed>]",
        options: [booleanOption("show", "show the saved seed"), booleanOption("clear", "remove the saved seed"), stringOption("rpc", "<url>", "RPC URL")],
    },
    ls: {
        group: "deploy & interact",
        json: true,
        summary: "list deployed contracts",
        options: [stringOption("rpc", "<url>", "RPC URL")],
    },
    state: {
        group: "deploy & interact",
        json: true,
        summary: "show contract state",
        usage: "[<target>]",
        options: [
            booleanOption("digest", "show the full-state digest"),
            booleanOption("dump", "write raw state to state/<Name>_dump.bin"),
            stringOption("out", "<path>", "dump path (with --dump)"),
            stringOption("container", "<index>", "load a container by its shown index", {
                multiple: true,
            }),
            booleanOption("all", "load all containers"),
            stringOption("rpc", "<url>", "RPC URL"),
        ],
    },
    explorer: {
        group: "deploy & interact",
        summary: "explore the chain",
        usage: "[<tick|txid|identity>]",
        options: [stringOption("rpc", "<url>", "RPC URL")],
        examples: ["qinit explorer # interactive mode", "qinit explorer 7474 # quick jump to tick", "qinit explorer <identity> # quick jump ID details"],
    },
    debug: {
        group: "deploy & interact",
        summary: "inspect contract calls and state changes",
        usage: "<Contract>",
        options: [stringOption("contract", "<name|slot>", "contract name or slot"), stringOption("rpc", "<url>", "RPC URL")],
    },
    test: {
        group: "deploy & interact",
        summary: "deploy and test a contract",
        usage: "[<file.h>]",
        options: [
            stringOption("contract", "<file.h>", "contract header"),
            stringOption("contract-name", "<name>", "contract name"),
            stringOption("slot", "<n>", "deployment slot"),
            stringOption("core-dir", "<path>", "Core checkout"),
            stringOption("callee", "<n>=<hdr>[@<i>]", "callee header and optional slot", {
                multiple: true,
            }),
            stringOption("filter", "<pat>", "test name filter"),
            stringOption("node-bin", "<path>", "Core node binary"),
            stringOption("ref", "<tag>", "node release"),
            stringOption("rpc", "<url>", "RPC URL"),
            stringOption("node-mode", "<n>", "Core node mode"),
            stringOption("peers", "<addr>", "Core peer address"),
            stringOption("wait", "<s>", "node start timeout in seconds"),
            stringOption("seed", "<seed>", "signer seed"),
            stringOption("timeout", "<ms>", "test timeout in ms"),
            stringOption("runtime", "<core|simulator>", "runtime for this run"),
            stringOption("compiler", "<clang|typescript>", "compiler for this run"),
            booleanOption("keep-node", "leave the started Core node running"),
            booleanOption("skip-verify", "skip compatibility checks (development only)"),
        ],
    },
    gtest: {
        group: "deploy & interact",
        summary: "run Core-style contract tests",
        usage: "[<test.cpp>]",
        options: [
            stringOption("contract", "<file.h>", "contract under test (default: qinit.json)"),
            stringOption("contract-name", "<name>", "contract name"),
            stringOption("state-type", "<T>", "contract struct type"),
            stringOption("slot", "<n>", "contract slot (default: automatic)"),
            stringOption("callee", "<Name>=<header>[@<index>]", "callee header and optional slot", {
                multiple: true,
            }),
            stringOption("filter", "<pat>", "run only tests whose name contains one of these (comma-separated)"),
            stringOption("core-dir", "<path>", "Core checkout"),
            stringOption("corpus", "<NAME>", "system contract test name"),
            booleanOption("new", "create or replace tests/<Name>.test.cpp"),
            stringOption("compiler", "<clang|typescript>", "compiler for this run"),
            booleanOption("shared-mem", "support memory-heavy tests"),
        ],
    },

    ext: {
        group: "editor",
        json: true,
        summary: "install the Qinit editor extension",
        usage: "install [--vsix <path>] [--editor <cmd>]",
        options: [
            stringOption("vsix", "<path>", "local extension package"),
            stringOption("editor", "<cmd>", "editor command: code, cursor, windsurf, or codium"),
        ],
    },

    runtime: {
        group: "misc",
        json: true,
        summary: "choose the default runtime",
        usage: "[core|simulator]",
        options: [booleanOption("show", "show the current runtime")],
    },
    compiler: {
        group: "misc",
        json: true,
        summary: "choose the default compiler",
        usage: "[clang|typescript]",
        options: [booleanOption("show", "show the current compiler")],
    },
    system: {
        group: "deploy & interact",
        json: true,
        summary: "manage system contracts",
        usage: "[ls | add <name…> | rm <name…>]",
        options: [stringOption("rpc", "<url>", "RPC URL"), stringOption("compiler", "<clang|typescript>", "simulator system-contract compiler")],
        examples: ["qinit system add QX QEARN", "qinit system ls"],
    },
    theme: {
        group: "misc",
        summary: "choose the color theme",
        usage: "[default|emerald|ocean|rose|amber|mono]",
        options: [booleanOption("show", "show the current theme")],
    },
    "cheat-sheet": {
        group: "misc",
        summary: "show common workflows and call formats",
    },
    // Internal: the release guard that proves wasm crypto still works in the compiled binary.
    smoke: { group: "misc", summary: "check identity cryptography", hidden: true },
    info: {
        group: "misc",
        json: true,
        summary: "show the current setup",
        options: [stringOption("rpc", "<url>", "RPC URL")],
    },
    version: { group: "misc", json: true, summary: "show the Qinit version" },
    help: { group: "misc", summary: "show command help" },
} satisfies Record<string, CommandMeta>;

export type CommandName = keyof typeof commandMeta;
export const META: Record<CommandName, CommandMeta> = commandMeta;

export function isCommandName(command: string): command is CommandName {
    return Object.prototype.hasOwnProperty.call(META, command);
}

export function commandOptions(command: CommandName, subcommand?: string): OptionMeta[] {
    const meta: CommandMeta = META[command];
    return [...(meta.options ?? []), ...(subcommand ? (meta.subcommands?.[subcommand]?.options ?? []) : [])];
}

// Canonical names for routing and suggestions. The router handles aliases.
export const COMMANDS = Object.keys(META) as CommandName[];
