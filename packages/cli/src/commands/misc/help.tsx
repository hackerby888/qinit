import { useEffect } from "react";
import { Box, Text, useApp } from "ink";
import { VERSION } from "../../version";
import { Banner, Header, theme } from "../../ui";
import {
    META,
    GROUP_ORDER,
    COMMANDS,
    commandOptions,
    optionSyntax,
    type OptionMeta,
    type CommandMeta,
    type CommandName,
} from "../../meta";

// Global help — grouped by workflow stage (from meta.ts) so it reads top-to-bottom as you'd use qinit.
export function Help({
    unknown,
    command,
    suggestion,
}: {
    unknown?: boolean;
    command?: string;
    suggestion?: string;
}) {
    const { exit } = useApp();
    useEffect(() => {
        exit();
    }, [exit]);
    const listed = COMMANDS.filter((c) => !META[c].hidden);
    const w = Math.max(...listed.map((c) => c.length)) + 2; // align descriptions across all groups
    const pad = "  " + " ".repeat(w); // indent for example/note lines
    const groups = GROUP_ORDER.map((g) => ({
        title: g,
        items: listed.filter((c) => META[c].group === g),
    }));
    return (
        <Box flexDirection="column">
            {unknown && (
                <Box marginBottom={1} flexDirection="column">
                    <Text>
                        <Text color={theme.warn}>✗ unknown command:</Text>{" "}
                        <Text bold>{command}</Text>
                    </Text>
                    {suggestion && (
                        <Text>
                            {"  "}
                            <Text dimColor>did you mean</Text>{" "}
                            <Text bold color={theme.accent}>
                                {suggestion}
                            </Text>
                            <Text dimColor>?</Text>
                        </Text>
                    )}
                </Box>
            )}
            <Banner version={VERSION} tagline="Framework for Qubic dynamic contracts" />
            <Text dimColor>
                usage: <Text color={theme.info}>qinit</Text> &lt;command&gt; [args] ·{" "}
                <Text color={theme.info}>qinit &lt;command&gt; --help</Text> for a command's flags
            </Text>
            {groups.map((g) => (
                <Box key={g.title} marginTop={1} flexDirection="column">
                    <Text bold color={theme.brand}>
                        {g.title}
                    </Text>
                    {g.items.map((name) => {
                        const m = META[name];
                        return (
                            <Box key={name} flexDirection="column">
                                <Text>
                                    {"  "}
                                    <Text bold color={theme.accent}>
                                        {name.padEnd(w)}
                                    </Text>
                                    <Text dimColor>{m.summary}</Text>
                                </Text>
                                {m.examples?.map((line, i) => (
                                    <Text key={i}>
                                        {pad}
                                        {line.startsWith("qinit ") ? (
                                            <Text color={theme.info}>{line}</Text>
                                        ) : (
                                            <Text dimColor>{line}</Text>
                                        )}
                                    </Text>
                                ))}
                            </Box>
                        );
                    })}
                </Box>
            ))}
        </Box>
    );
}

// Per-command help — `qinit <cmd> --help`: summary + usage line + flags table + examples.
export function Usage({ command, subcommand }: { command: CommandName; subcommand?: string }) {
    const { exit } = useApp();
    useEffect(() => {
        exit();
    }, [exit]);
    const m: CommandMeta = META[command];
    const options: OptionMeta[] = commandOptions(command, subcommand).filter(
        (option) => !option.hidden,
    );
    if (m.json) {
        options.push({
            name: "json",
            type: "boolean",
            description: "emit a machine-readable result (implies --plain)",
        });
    }
    const width = options.length
        ? Math.max(...options.map((option) => optionSyntax(option).length)) + 2
        : 0;
    return (
        <Box flexDirection="column">
            <Header cmd={subcommand ? `${command} ${subcommand}` : command} />
            <Text dimColor>{m.summary}</Text>
            <Box marginTop={1}>
                <Text dimColor>usage: </Text>
                <Text color={theme.info}>
                    qinit {command}
                    {subcommand ? ` ${subcommand}` : m.usage ? ` ${m.usage}` : ""}
                </Text>
            </Box>
            {options.length ? (
                <Box marginTop={1} flexDirection="column">
                    <Text bold color={theme.brand}>
                        flags
                    </Text>
                    {options.map((option) => (
                        <Text key={option.name}>
                            {"  "}
                            <Text color={theme.accent}>{optionSyntax(option).padEnd(width)}</Text>
                            <Text dimColor>
                                {option.description}
                                {option.multiple ? " (repeatable)" : ""}
                            </Text>
                        </Text>
                    ))}
                </Box>
            ) : null}
            {m.examples?.length ? (
                <Box marginTop={1} flexDirection="column">
                    <Text bold color={theme.brand}>
                        examples
                    </Text>
                    {m.examples.map((line, i) => (
                        <Text key={i}>
                            {"  "}
                            {line.startsWith("qinit ") ? (
                                <Text color={theme.info}>{line}</Text>
                            ) : (
                                <Text dimColor>{line}</Text>
                            )}
                        </Text>
                    ))}
                </Box>
            ) : null}
        </Box>
    );
}
