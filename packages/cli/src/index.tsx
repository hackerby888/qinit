#!/usr/bin/env bun
// Qinit CLI entry — the standalone-binary compile target (`bun build --compile`).
import { render } from "ink";
import { App } from "./app";
import { applyTheme } from "./ui";
import { savedTheme } from "./config";

applyTheme(savedTheme());   // apply the saved color variant before anything renders

const [, , command = "help", ...args] = process.argv;
const { waitUntilExit } = render(<App command={command} args={args} />);
await waitUntilExit();
