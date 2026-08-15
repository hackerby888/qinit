// Progress and state indicators: spinners, badges, step rows, progress bars.
import { Text } from "ink";
import { output } from "../args";
import { fmtMs, termCols, truncEnd, truncMid } from "./format";
import { useFrame } from "./hooks";
import { lerp, theme } from "./theme";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ label, color = theme.info }: { label: string; color?: string }) {
    const frame = useFrame();
    return (
        <Text>
            <Text color={color}>{FRAMES[frame % FRAMES.length]}</Text> {label}
            <Text dimColor>…</Text>
        </Text>
    );
}

export function Badge({ text, color = theme.brand }: { text: string; color?: string }) {
    if (output.plain) {
        return <Text bold>{`[${text}]`}</Text>;
    }

    return (
        <Text backgroundColor={color} color="#000000" bold>
            {` ${text} `}
        </Text>
    );
}

export function Status({ ok, label, detail, pad = 22 }: { ok?: boolean | null; label: string; detail?: string; pad?: number }) {
    const glyph = ok === true ? "✓" : ok === false ? "✗" : "•";
    const color = ok === true ? theme.ok : ok === false ? theme.err : theme.info;

    return (
        <Text>
            <Text color={color}>{glyph}</Text> <Text bold>{label.padEnd(pad)}</Text>
            {detail ? <Text dimColor>{truncMid(detail, Math.max(12, termCols() - pad - 8))}</Text> : null}
        </Text>
    );
}

export type StepState = "pending" | "active" | "ok" | "fail";

export function Step({ state, label, detail }: { state: StepState; label: string; detail?: string }) {
    const frame = useFrame();
    const glyph =
        state === "ok" ? (
            <Text color={theme.ok}>✓</Text>
        ) : state === "fail" ? (
            <Text color={theme.err}>✗</Text>
        ) : state === "active" ? (
            <Text color={theme.info}>{FRAMES[frame % FRAMES.length]}</Text>
        ) : (
            <Text dimColor>◌</Text>
        );
    const labelColor = state === "pending" ? theme.mute : undefined;

    return (
        <Text>
            {glyph}{" "}
            <Text bold={state !== "pending"} color={labelColor}>
                {label}
            </Text>
            {detail ? <Text dimColor>{`  ${detail}`}</Text> : null}
        </Text>
    );
}

export function Bar({ pct, width = 22 }: { pct: number; width?: number }) {
    const progress = Math.max(0, Math.min(1, pct || 0));
    const fill = Math.round(progress * width);

    if (output.plain) {
        return (
            <Text>
                {"█".repeat(fill)}
                {"░".repeat(Math.max(0, width - fill))} {Math.round(progress * 100)}%
            </Text>
        );
    }

    const cells = Array.from({ length: width }, (_, index) =>
        index < fill ? (
            <Text key={index} color={lerp(theme.gradFrom, theme.gradTo, width < 2 ? 0 : index / (width - 1))}>
                █
            </Text>
        ) : (
            <Text key={index} dimColor>
                ░
            </Text>
        ),
    );

    return (
        <Text>
            <Text color={theme.gradFrom}>▕</Text>
            {cells}
            <Text color={theme.gradTo}>▏</Text> <Text dimColor>{Math.round(progress * 100)}%</Text>
        </Text>
    );
}

export function StepRow({ state, label, detail, pct, elapsedMs }: { state: StepState; label: string; detail?: string; pct?: number; elapsedMs?: number }) {
    const frame = useFrame();
    const glyph =
        state === "ok" ? (
            <Text color={theme.ok}>✓</Text>
        ) : state === "fail" ? (
            <Text color={theme.err}>✗</Text>
        ) : state === "active" ? (
            <Text color={theme.info}>{FRAMES[frame % FRAMES.length]}</Text>
        ) : (
            <Text dimColor>◌</Text>
        );

    return (
        <Text>
            {glyph}{" "}
            <Text bold={state !== "pending"} color={state === "pending" ? theme.mute : undefined}>
                {label.padEnd(14)}
            </Text>
            {pct != null && state === "active" ? <Bar pct={pct} /> : detail ? <Text dimColor>{truncEnd(detail, Math.max(12, termCols() - 24))}</Text> : null}
            {state === "ok" && elapsedMs ? <Text dimColor>{`  ${fmtMs(elapsedMs)}`}</Text> : null}
        </Text>
    );
}
