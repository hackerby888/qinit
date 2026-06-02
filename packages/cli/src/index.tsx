#!/usr/bin/env bun
// Qinit CLI entry — the standalone-binary compile target (`bun build --compile`).
import { render } from "ink";
import { App } from "./app";

const [, , command = "help", ...args] = process.argv;
const { waitUntilExit } = render(<App command={command} args={args} />);
await waitUntilExit();
