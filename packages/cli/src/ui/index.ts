// The terminal component kit. Commands import from "…/ui" and get the whole set; the modules behind
// this barrel are the seams (palette, formatting, hooks, layout, feedback, data, prompts), not separate
// public entry points.
export { THEMES, THEME_NAMES, theme, applyTheme, Grad, GradLine, darken } from "./theme";
export type { Theme } from "./theme";
export { fmtMs, termCols, termRows, fmtCompact, truncEnd, truncMid, sevColor } from "./format";
export { useFrame, useTerminalSize } from "./hooks";
export { Rule, Header, Banner, Panel, SectionHeader } from "./layout";
export { Spinner, Badge, Status, Step, StepRow, Bar } from "./feedback";
export type { StepState } from "./feedback";
export { KV, Tile, TileRow, Sparkline, Table } from "./data";
export type { TileSpec, SparkRow, Column } from "./data";
export { Select, TextPrompt } from "./prompt";
export type { SelItem } from "./prompt";
