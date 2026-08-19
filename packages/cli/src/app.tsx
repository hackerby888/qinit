// Command router. One-shot: each command renders, does its work, then exits.
import { Component, useEffect, type ReactNode } from "react";
import { Box, Text, useApp } from "ink";
import { Doctor } from "./commands/setup/doctor";
import { Info } from "./commands/misc/info";
import { Setup } from "./commands/setup/setup";
import { Smoke } from "./commands/misc/smoke";
import { Node } from "./commands/node/node";
import { NodeRun } from "./commands/node/node-run";
import { Ext } from "./commands/editor/ext";
import { Dev } from "./commands/develop/dev";
import { Build } from "./commands/develop/build";
import { Gen } from "./commands/develop/gen";
import { Deploy } from "./commands/deploy-interact/deploy";
import { Verify } from "./commands/develop/verify";
import { Test } from "./commands/deploy-interact/test";
import { Gtest } from "./commands/deploy-interact/gtest";
import { Call } from "./commands/deploy-interact/call";
import { Ls } from "./commands/deploy-interact/ls";
import { Debug } from "./commands/deploy-interact/debug";
import { Explorer } from "./commands/deploy-interact/explorer";
import { State } from "./commands/deploy-interact/state";
import { Clean } from "./commands/setup/clean";
import { Cheat } from "./commands/misc/cheat";
import { Seed } from "./commands/deploy-interact/seed";
import { Tick } from "./commands/node/tick";
import { Epoch } from "./commands/node/epoch";
import { ThemeCmd } from "./commands/misc/theme";
import { RuntimeCmd } from "./commands/misc/runtime";
import { CompilerCmd } from "./commands/misc/compiler";
import { System } from "./commands/deploy-interact/system";
import { Update } from "./commands/setup/update";
import { Uninstall } from "./commands/setup/uninstall";
import { New } from "./commands/develop/new";
import { Integrate } from "./commands/develop/integrate";
import { Help, Usage } from "./commands/misc/help";
import { Version } from "./commands/misc/version";
import { invalidArgs, nearest, parseCommandInvocation, type CommandInvocation } from "./args";
import { META, COMMANDS, isCommandName, type CommandMeta, type CommandName } from "./meta";

// Catch a render-time throw so the CLI exits cleanly instead of leaving Ink in raw mode.
function Crash({ err, command }: { err: Error; command: string }) {
    const { exit } = useApp();
    const code = (err as Error & { code?: string }).code;
    const invalidArgs = code?.startsWith("ERR_PARSE_ARGS_") ?? false;
    const message = err.message.split("\n")[0];

    useEffect(() => {
        process.exitCode = 1;
        const t = setTimeout(() => exit(), 30);
        return () => clearTimeout(t);
    }, []);

    return (
        <Box flexDirection="column">
            <Text color="red">✗ {invalidArgs ? `invalid arguments: ${message}` : `qinit crashed: ${message}`}</Text>
            {invalidArgs ? <Text dimColor>run `qinit {command} --help`</Text> : null}
        </Box>
    );
}
class ErrorBoundary extends Component<{ children: ReactNode; command: string }, { err?: Error }> {
    state: { err?: Error } = {};
    static getDerivedStateFromError(err: Error) {
        return { err };
    }
    render() {
        return this.state.err ? <Crash err={this.state.err} command={this.props.command} /> : this.props.children;
    }
}

export function App({ command, args }: { command: string; args: string[] }) {
    return (
        <ErrorBoundary command={command}>
            <CommandRoute command={command} args={args} />
        </ErrorBoundary>
    );
}

// Point removed or renamed commands at their replacement instead of a fuzzy
// "did you mean" suggestion.
const REMOVED = new Map([["up", "node run"]]);

const ALIASES = new Map<string, CommandName>([
    ["self-update", "update"],
    ["cheat", "cheat-sheet"],
    ["--cheat-sheet", "cheat-sheet"],
    ["--version", "version"],
    ["-v", "version"],
    ["--help", "help"],
    ["-h", "help"],
]);

function canonicalCommand(command: string): CommandName | undefined {
    return isCommandName(command) ? command : ALIASES.get(command);
}

function unknownCommand(command: string): ReactNode {
    // A near-miss must not advertise a hidden command the help listing does not show.
    const suggestable = COMMANDS.filter((name) => !META[name].hidden);
    return <Help unknown command={command} suggestion={REMOVED.get(command) ?? nearest(command, suggestable)} />;
}

function validateHelpSubcommand(command: CommandName, subcommand?: string): void {
    if (!subcommand) {
        return;
    }
    const meta: CommandMeta = META[command];
    if (!meta.subcommands || !Object.prototype.hasOwnProperty.call(meta.subcommands, subcommand)) {
        invalidArgs(`unknown subcommand '${subcommand}' for '${command}'`);
    }
}

function renderHelp(invocation: CommandInvocation): ReactNode {
    const [requestedCommand, requestedSubcommand, ...extra] = invocation.commandArgs.positionals;
    if (!requestedCommand) {
        return <Help />;
    }
    if (extra.length) {
        invalidArgs("help accepts at most a command and subcommand");
    }

    const command = canonicalCommand(requestedCommand);
    if (!command) {
        return unknownCommand(requestedCommand);
    }

    validateHelpSubcommand(command, requestedSubcommand);
    return <Usage command={command} subcommand={requestedSubcommand} />;
}

type CommandHandler = (invocation: CommandInvocation) => ReactNode;

const HANDLERS = {
    setup: ({ commandArgs }) => <Setup commandArgs={commandArgs} />,
    doctor: () => <Doctor />,
    info: ({ commandArgs }) => <Info commandArgs={commandArgs} />,
    ext: ({ commandArgs }) => <Ext commandArgs={commandArgs} />,
    node: ({ commandArgs, subcommand }) =>
        subcommand === "run" ? <NodeRun commandArgs={commandArgs} /> : <Node commandArgs={commandArgs} subcommand={subcommand} />,
    tick: ({ commandArgs }) => <Tick commandArgs={commandArgs} />,
    epoch: ({ commandArgs }) => <Epoch commandArgs={commandArgs} />,
    clean: ({ commandArgs }) => <Clean commandArgs={commandArgs} />,
    update: ({ commandArgs }) => <Update commandArgs={commandArgs} />,
    uninstall: ({ commandArgs }) => <Uninstall commandArgs={commandArgs} />,
    new: ({ commandArgs }) => <New commandArgs={commandArgs} />,
    integrate: ({ commandArgs }) => <Integrate commandArgs={commandArgs} />,
    dev: ({ commandArgs }) => <Dev commandArgs={commandArgs} />,
    build: ({ commandArgs }) => <Build commandArgs={commandArgs} />,
    gen: ({ commandArgs }) => <Gen commandArgs={commandArgs} />,
    verify: ({ commandArgs }) => <Verify commandArgs={commandArgs} />,
    deploy: ({ commandArgs }) => <Deploy commandArgs={commandArgs} />,
    call: ({ commandArgs }) => <Call commandArgs={commandArgs} />,
    seed: ({ commandArgs }) => <Seed commandArgs={commandArgs} />,
    ls: ({ commandArgs }) => <Ls commandArgs={commandArgs} />,
    state: ({ commandArgs }) => <State commandArgs={commandArgs} />,
    debug: ({ commandArgs }) => <Debug commandArgs={commandArgs} />,
    explorer: ({ commandArgs }) => <Explorer commandArgs={commandArgs} />,
    test: ({ commandArgs }) => <Test commandArgs={commandArgs} />,
    gtest: ({ commandArgs }) => <Gtest commandArgs={commandArgs} />,
    runtime: ({ commandArgs }) => <RuntimeCmd commandArgs={commandArgs} />,
    compiler: ({ commandArgs }) => <CompilerCmd commandArgs={commandArgs} />,
    system: ({ commandArgs }) => <System commandArgs={commandArgs} />,
    theme: ({ commandArgs }) => <ThemeCmd commandArgs={commandArgs} />,
    "cheat-sheet": () => <Cheat />,
    smoke: () => <Smoke />,
    version: () => <Version />,
    help: renderHelp,
} satisfies Record<CommandName, CommandHandler>;

function CommandRoute({ command, args }: { command: string; args: string[] }) {
    const canonical = canonicalCommand(command);
    if (!canonical) {
        return unknownCommand(command);
    }

    const invocation = parseCommandInvocation(canonical, args);
    if (canonical !== "help" && invocation.commandArgs.has("help")) {
        return <Usage command={canonical} subcommand={invocation.subcommand} />;
    }
    return HANDLERS[canonical](invocation);
}
