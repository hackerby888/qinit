// Value formatting and width/height arithmetic. Pure functions — the sizes every component budgets against.
export const fmtMs = (ms?: number) => (ms == null ? "" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

export const termCols = () => Math.max(40, process.stdout.columns || 80);
export const termRows = () => Math.max(10, process.stdout.rows || 24);

const COMPACT_UNITS = ["", "K", "M", "B", "T", "P", "E"];

// Compact a decimal amount string for a narrow cell: "32000000000000" -> "32.0 T". Works on the digit
// string rather than Number, so amounts past 2^53 stay correct.
export function fmtCompact(amount: string): string {
    const negative = amount.startsWith("-");
    const digits = (negative ? amount.slice(1) : amount).replace(/^0+(?=\d)/, "");
    if (!/^\d+$/.test(digits)) {
        return amount;
    }

    const unit = Math.min(COMPACT_UNITS.length - 1, Math.floor((digits.length - 1) / 3));
    const sign = negative ? "-" : "";
    if (unit === 0) {
        return sign + digits;
    }

    const whole = digits.slice(0, digits.length - unit * 3);
    const fraction = digits.slice(whole.length, whole.length + 1);
    return `${sign}${whole}.${fraction} ${COMPACT_UNITS[unit]}`;
}

export const truncEnd = (s: string, max: number) => (s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + "…");

export const truncMid = (s: string, max: number) => {
    if (s.length <= max) {
        return s;
    }

    const keep = Math.max(2, max - 1);
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    return s.slice(0, head) + "…" + s.slice(s.length - tail);
};

// Slice a list around the selected row. `budget` is the rows left after the caller's own fixed block, so a
// long list can never grow past the frame and push what sits below it off-screen.
export function windowOf<T>(rows: T[], selected: number, budget: number): { win: T[]; offset: number } {
    const size = Math.max(1, budget);
    const offset = Math.max(0, Math.min(selected - Math.floor(size / 2), rows.length - size));
    return { win: rows.slice(offset, offset + size), offset: Math.max(0, offset) };
}

export const sevColor = (severity: string) => (severity === "ERROR" ? "red" : severity === "WARN" ? "yellow" : severity === "INFO" ? "green" : undefined);
