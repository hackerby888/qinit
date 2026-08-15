// Page furniture: the command header, the version banner, bordered panels, and section dividers.
import { Box, Text } from "ink";
import { Badge } from "./feedback";
import { termCols } from "./format";
import { Grad, theme } from "./theme";

export function Rule({ width = 50 }: { width?: number }) {
    return <Grad text={"─".repeat(width)} bold={false} />;
}

export function Header({ cmd }: { cmd: string }) {
    return (
        <Box marginBottom={1}>
            <Text>
                <Grad text="qinit" />
                <Text dimColor>{"  ▸  "}</Text>
                <Text bold color={theme.accent}>
                    {cmd}
                </Text>
            </Text>
        </Box>
    );
}

export function Banner({ version, tagline }: { version: string; tagline: string }) {
    return (
        <Box flexDirection="column" marginBottom={1}>
            <Box borderStyle="round" borderColor={theme.brand} paddingX={1} alignSelf="flex-start">
                <Text>
                    <Text color={theme.accent}>◆ </Text>
                    <Grad text="qinit" />
                    <Text dimColor>{"   "}</Text>
                    <Badge text={`v${version}`} color={theme.brand} />
                    <Text dimColor>{`   ${tagline}`}</Text>
                </Text>
            </Box>
        </Box>
    );
}

export function Panel({ title, color = theme.info, children }: { title?: string; color?: string; children: React.ReactNode }) {
    return (
        <Box flexDirection="column">
            {title && (
                <Box>
                    <Badge text={title} color={color} />
                </Box>
            )}
            <Box borderStyle="round" borderColor={color} paddingX={1} flexDirection="column" alignSelf="flex-start">
                {children}
            </Box>
        </Box>
    );
}

// A titled section divider: `▌ RECENT TICKS  20 newest first ─────────`. The trailing hairline is what
// separates one region from the next without spending a whole bordered box on it.
export function SectionHeader({
    title,
    detail,
    badge,
    badgeColor,
    error,
    width,
}: {
    title: string;
    detail?: string;
    badge?: string;
    badgeColor?: string;
    error?: string;
    width?: number;
}) {
    const total = width ?? termCols();
    const label = title.toUpperCase();
    // Badges and errors are variable-width; the rule just fills whatever is left over.
    const used = 2 + label.length + (detail ? detail.length + 2 : 0) + (badge ? badge.length + 4 : 0);
    // Leave the terminal's last cell empty: a header filling it exactly wraps on some terminals.
    const rule = Math.max(0, total - used - (error ? error.length + 2 : 0) - 2);

    return (
        <Box marginTop={1}>
            <Text>
                <Text color={theme.brand}>▌</Text>{" "}
                <Text bold color={theme.accent}>
                    {label}
                </Text>
                {detail ? <Text dimColor>{`  ${detail}`}</Text> : null}
                {badge ? (
                    <Text>
                        {"  "}
                        <Badge text={badge} color={badgeColor ?? theme.err} />
                    </Text>
                ) : null}
                {error ? <Text color={theme.err}>{`  ${error}`}</Text> : null}
                {rule > 0 ? <Text dimColor>{` ${"─".repeat(rule)}`}</Text> : null}
            </Text>
        </Box>
    );
}
