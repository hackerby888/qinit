// The palette and everything that paints with it. `theme` is a single mutable object every component
// reads, so switching themes is an in-place Object.assign rather than a re-render of the whole tree.
import { Text } from "ink";
import { output } from "../args";

export type Theme = {
    gradFrom: string;
    gradTo: string;
    brand: string;
    accent: string;
    ok: string;
    err: string;
    warn: string;
    info: string;
    mute: string;
};

export const THEMES: Record<string, Theme> = {
    default: {
        gradFrom: "#7c5cff",
        gradTo: "#22d3ee",
        brand: "#7c5cff",
        accent: "#a78bfa",
        ok: "#22c55e",
        err: "#ef4444",
        warn: "#f59e0b",
        info: "#38bdf8",
        mute: "gray",
    },
    emerald: {
        gradFrom: "#10b981",
        gradTo: "#6ee7b7",
        brand: "#10b981",
        accent: "#34d399",
        ok: "#22c55e",
        err: "#ef4444",
        warn: "#f59e0b",
        info: "#2dd4bf",
        mute: "gray",
    },
    ocean: {
        gradFrom: "#3b82f6",
        gradTo: "#22d3ee",
        brand: "#3b82f6",
        accent: "#60a5fa",
        ok: "#22c55e",
        err: "#ef4444",
        warn: "#f59e0b",
        info: "#38bdf8",
        mute: "gray",
    },
    rose: {
        gradFrom: "#f43f5e",
        gradTo: "#fb7185",
        brand: "#f43f5e",
        accent: "#fb7185",
        ok: "#22c55e",
        err: "#ef4444",
        warn: "#f59e0b",
        info: "#fda4af",
        mute: "gray",
    },
    amber: {
        gradFrom: "#f59e0b",
        gradTo: "#fde047",
        brand: "#f59e0b",
        accent: "#fbbf24",
        ok: "#22c55e",
        err: "#ef4444",
        warn: "#ea580c",
        info: "#fcd34d",
        mute: "gray",
    },
    mono: {
        gradFrom: "#64748b",
        gradTo: "#cbd5e1",
        brand: "#94a3b8",
        accent: "#cbd5e1",
        ok: "#22c55e",
        err: "#ef4444",
        warn: "#f59e0b",
        info: "#94a3b8",
        mute: "gray",
    },
};
export const THEME_NAMES = Object.keys(THEMES);

// Components share this object, so applying a theme must mutate it in place.
export const theme: Theme = { ...THEMES.default };

export function applyTheme(name?: string): string {
    const key = name && THEMES[name] ? name : "default";
    Object.assign(theme, THEMES[key]);
    return key;
}

function hexChannels(color: string): [number, number, number] {
    const hex = color.replace("#", "");
    return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
    ];
}

export function lerp(from: string, to: string, position: number): string {
    const start = hexChannels(from);
    const end = hexChannels(to);
    const channel = (index: number) =>
        Math.round(start[index] + (end[index] - start[index]) * position)
            .toString(16)
            .padStart(2, "0");

    return `#${channel(0)}${channel(1)}${channel(2)}`;
}

// Offset the gradient and fold it back on itself, so an animated phase sweeps the colors along the text
// without the seam a plain wrap would leave between the last character and the first.
function gradPosition(base: number, phase: number): number {
    const shifted = (base + phase) % 1;
    return shifted < 0.5 ? shifted * 2 : 2 - shifted * 2;
}

export function Grad({
    text,
    from = theme.gradFrom,
    to = theme.gradTo,
    bold = true,
    phase,
}: {
    text: string;
    from?: string;
    to?: string;
    bold?: boolean;
    // Drive this from useFrame to animate; omit it for a still gradient.
    phase?: number;
}) {
    if (output.plain) {
        return <Text bold={bold}>{text}</Text>;
    }

    const length = text.length;
    return (
        <Text bold={bold}>
            {[...text].map((character, index) => {
                const base = length < 2 ? 0 : index / (length - 1);
                return (
                    <Text
                        key={index}
                        color={lerp(
                            from,
                            to,
                            phase === undefined ? base : gradPosition(base, phase),
                        )}
                    >
                        {character}
                    </Text>
                );
            })}
        </Text>
    );
}

// Blend a color toward black. Lets a themed element recede without leaving the palette.
export function darken(color: string, amount: number): string {
    return lerp(color, "#000000", Math.max(0, Math.min(1, amount)));
}

export function GradLine({
    text,
    from = theme.gradFrom,
    to = theme.gradTo,
    bold = true,
    color = "#ffffff",
    plainDim = false,
}: {
    text: string;
    from?: string;
    to?: string;
    bold?: boolean;
    color?: string;
    plainDim?: boolean;
}) {
    if (output.plain) {
        return (
            <Text bold={bold} dimColor={plainDim}>
                {text}
            </Text>
        );
    }

    const length = text.length;
    return (
        <Text bold={bold}>
            {[...text].map((character, index) => (
                <Text
                    key={index}
                    backgroundColor={lerp(from, to, length < 2 ? 0 : index / (length - 1))}
                    color={color}
                >
                    {character}
                </Text>
            ))}
        </Text>
    );
}
