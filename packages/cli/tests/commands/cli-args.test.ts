import { expect, test } from "bun:test";
import { join } from "node:path";

const cli = join(import.meta.dir, "../../src/index.tsx");

async function run(...args: string[]) {
    const child = Bun.spawn([process.execPath, cli, ...args], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    return {
        code: child.exitCode,
        stdout,
        stderr,
    };
}

test("CLI reports unknown options without a crash message", async () => {
    const result = await run("runtime", "--bogus");

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("invalid arguments: Unknown option '--bogus'");
    expect(result.stdout).toContain("qinit runtime --help");
    expect(result.stdout).not.toContain("qinit crashed");
    expect(result.stderr).toBe("");
});

test("CLI reports missing option values", async () => {
    const result = await run("ls", "--rpc");

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("invalid arguments:");
    expect(result.stdout).toContain("Option '--rpc <value>' argument missing");
    expect(result.stderr).toBe("");
});

test("call mode flags leave contract and entry as positionals", async () => {
    const result = await run("call", "--fn", "Counter");

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("invalid arguments: fn requires <contract> and <entry>");
    expect(result.stderr).toBe("");
});

test("CLI reports malformed callee declarations as argument errors", async () => {
    const result = await run("build", "Counter.h", "--callee", "broken");

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
        "invalid arguments: invalid --callee 'broken': expected Name=header[@index]",
    );
    expect(result.stdout).toContain("qinit build --help");
    expect(result.stderr).toBe("");
});

test("deploy rejects an invalid slot before core or node work", async () => {
    const result = await run("deploy", "Counter.h", "--slot", "nope");

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("contract slot must be an integer from 1 to 1023");
    expect(result.stdout).not.toContain("no core headers");
    expect(result.stdout).not.toContain("node unreachable");
    expect(result.stderr).toBe("");
});

test("hidden server options are strict too", async () => {
    const result = await run("__serve", "--bogus");

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("qinit: fatal error: Unknown option '--bogus'");
});

test("commands without local options still reject unknown options", async () => {
    for (const command of ["doctor", "smoke", "version"]) {
        const result = await run(command, "--bogus");

        expect(result.code).toBe(1);
        expect(result.stdout).toContain("invalid arguments: Unknown option '--bogus'");
        expect(result.stderr).toBe("");
    }
});

test("command help is parsed strictly before it is shown", async () => {
    const result = await run("build", "--help", "--bogus");

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("invalid arguments: Unknown option '--bogus'");
    expect(result.stdout).not.toContain("usage: qinit build <file.h>");
});

test("help command and help flag share command usage", async () => {
    const [commandHelp, flagHelp] = await Promise.all([
        run("help", "build"),
        run("build", "--help"),
    ]);

    for (const result of [commandHelp, flagHelp]) {
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("usage: qinit build <file.h>");
        expect(result.stdout).toContain("--callee <n>=<hdr>[@<i>]");
        expect(result.stderr).toBe("");
    }
});

test("integrate help is canonical and upstream is unknown", async () => {
    const [integrateHelp, legacyCommand] = await Promise.all([
        run("integrate", "--help"),
        run("upstream"),
    ]);

    expect(integrateHelp.code).toBe(0);
    expect(integrateHelp.stdout).toContain("usage: qinit integrate");
    expect(integrateHelp.stdout).toContain("--construction-epoch <n>");
    expect(integrateHelp.stderr).toBe("");

    expect(legacyCommand.code).toBe(1);
    expect(legacyCommand.stdout).toContain("unknown command: upstream");
    expect(legacyCommand.stderr).toBe("");
});

test("an unresolved invocation fails even when it renders help", async () => {
    const [unknownName, unknownFlag, helpForUnknown] = await Promise.all([
        run("buidl"),
        run("--bogus"),
        run("help", "buidl"),
    ]);

    for (const result of [unknownName, helpForUnknown]) {
        expect(result.code).toBe(1);
        expect(result.stdout).toContain("unknown command: buidl");
        expect(result.stdout).toContain("did you mean");
    }

    // A dash-prefixed token is not announced as a command name, but it is still not a valid call.
    expect(unknownFlag.code).toBe(1);
    expect(unknownFlag.stdout).not.toContain("unknown command:");
    expect(unknownFlag.stdout).toContain("usage: qinit <command>");
});

test("node subcommand help shows only the resolved option scope", async () => {
    const [commandHelp, flagHelp, reorderedHelp, statusHelp, nodeHelp, terminatedHelp] =
        await Promise.all([
            run("help", "node", "run"),
            run("node", "run", "-h"),
            run("node", "--restart", "--rpc", "http://x", "run", "-h"),
            run("help", "node", "status"),
            run("node", "--help"),
            run("node", "--help", "--", "run"),
        ]);

    for (const result of [commandHelp, flagHelp, reorderedHelp]) {
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("usage: qinit node run");
        expect(result.stdout).toContain("--rpc <url>");
        expect(result.stdout).toContain("--restart");
        expect(result.stderr).toBe("");
    }
    expect(statusHelp.code).toBe(0);
    expect(statusHelp.stdout).toContain("usage: qinit node status");
    expect(statusHelp.stdout).toContain("--rpc <url>");
    expect(statusHelp.stdout).not.toContain("--restart");
    expect(nodeHelp.code).toBe(0);
    expect(nodeHelp.stdout).toContain("usage: qinit node <run|status|stop|get>");
    expect(nodeHelp.stdout).not.toContain("--core-dir");
    expect(terminatedHelp.code).toBe(0);
    expect(terminatedHelp.stdout).toContain("usage: qinit node <run|status|stop|get>");
    expect(terminatedHelp.stdout).not.toContain("--restart");
});

test("help rejects an unknown subcommand for a known command", async () => {
    const results = await Promise.all([
        run("help", "node", "launch"),
        run("node", "launch", "--help"),
        run("node", "--rpc", "http://x", "launch", "--help"),
    ]);

    for (const result of results) {
        expect(result.code).toBe(1);
        expect(result.stdout).toContain(
            "invalid arguments: unknown subcommand 'launch' for 'node'",
        );
        expect(result.stderr).toBe("");
    }
});

test("prototype-shaped command names stay unknown", async () => {
    const results = await Promise.all([run("toString"), run("__proto__"), run("help", "toString")]);

    for (const result of results) {
        expect(result.code).toBe(1);
        expect(result.stdout).toContain("unknown command:");
        expect(result.stdout).not.toContain("qinit crashed");
        expect(result.stderr).toBe("");
    }
});
