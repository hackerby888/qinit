import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_RPC_BASE } from "@qinit/core";
import { templateTest } from "@qinit/build/generate/templates";
import repositories from "../../config/repositories.json";

interface RunOptions {
    cwd?: string;
    env?: Record<string, string>;
    capture?: boolean;
    allowFailure?: boolean;
}

async function run(command: string[], options: RunOptions = {}): Promise<string> {
    const child = Bun.spawn(command, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdout: options.capture ? "pipe" : "inherit",
        stderr: "inherit",
    });
    const stdout = options.capture ? await new Response(child.stdout).text() : "";
    const exitCode = await child.exited;
    if (exitCode !== 0 && !options.allowFailure) {
        throw new Error(`${command[0]} exited with code ${exitCode}`);
    }
    return stdout;
}

function required(values: Record<string, string | undefined>, name: string): string {
    const value = values[name];
    if (!value) {
        throw new Error(`missing --${name}`);
    }
    return value;
}

const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
        "core-dir": { type: "string" },
        "node-bin": { type: "string" },
        platform: { type: "string" },
        result: { type: "string" },
        "qinit-bin": { type: "string" },
        "qinit-repository": { type: "string" },
        "core-repository": { type: "string" },
    },
    strict: true,
});

const parsed = values as Record<string, string | undefined>;
const qinitRoot = resolve(import.meta.dir, "../..");
const core = resolve(required(parsed, "core-dir"));
const nodeBinaryPath = resolve(required(parsed, "node-bin"));
const qinitBin = resolve(parsed["qinit-bin"] ?? process.env.QINIT_BIN ?? join(qinitRoot, "dist", process.platform === "win32" ? "qinit.exe" : "qinit"));
const platform = required(parsed, "platform");
const resultPath = resolve(required(parsed, "result"));
const qinitRepository = parsed["qinit-repository"] ?? repositories.qinit.repository;
const coreRepository = parsed["core-repository"] ?? repositories.coreLite.repository;

if (!existsSync(nodeBinaryPath)) {
    throw new Error(`node binary not found: ${nodeBinaryPath}`);
}
if (!existsSync(qinitBin)) {
    throw new Error(`qinit binary not found: ${qinitBin}`);
}

const qinitCommit = (await run(["git", "-C", qinitRoot, "rev-parse", "HEAD"], { capture: true })).trim();
const coreCommit = (await run(["git", "-C", core, "rev-parse", "HEAD"], { capture: true })).trim();
const scratch = mkdtempSync(join(tmpdir(), "qinit-core-smoke-"));
const qpiDigestPath = join(scratch, "qpi-digests.txt");
const project = join(scratch, "project");

const result = {
    platform,
    skipped: false,
    sources: {
        qinit: { repository: qinitRepository, commit: qinitCommit },
        coreLite: { repository: coreRepository, commit: coreCommit },
    },
    stateDigest: "",
    qpiDigests: { driver: "", callee: "" },
    reason: "",
};

async function stopNode(): Promise<void> {
    await run([qinitBin, "node", "stop", "--plain"], {
        cwd: scratch,
        allowFailure: true,
    });
}

try {
    await run([qinitBin, "smoke", "--plain"], { cwd: scratch });
    await run(
        [qinitBin, "node", "run", "--runtime", "core", "--core-dir", core, "--node-bin", nodeBinaryPath, "--restart", "--keep", "--wait", "150", "--plain"],
        { cwd: scratch },
    );

    const identityResponse = await fetch(`${DEFAULT_RPC_BASE}/live/v1/whoami`);
    const identity = (await identityResponse.json()) as { backend?: string };
    if (!identityResponse.ok || identity.backend !== "core") {
        throw new Error(`expected core backend identity, got ${identityResponse.status} ${JSON.stringify(identity)}`);
    }

    await run([qinitBin, "doctor", "--plain"], { cwd: scratch });
    await run([process.execPath, join(qinitRoot, "scripts/live-node/ci-qpi-dual-engine.ts")], {
        cwd: qinitRoot,
        env: {
            QINIT_CORE: core,
            QINIT_QPI_DIGEST_FILE: qpiDigestPath,
        },
    });

    await run([qinitBin, "node", "run", "--runtime", "core", "--core-dir", core, "--node-bin", nodeBinaryPath, "--restart", "--wait", "150", "--plain"], {
        cwd: scratch,
    });

    mkdirSync(join(project, "contracts"), { recursive: true });
    copyFileSync(join(qinitRoot, "fixtures", "DigestProbe.h"), join(project, "contracts", "DigestProbe.h"));
    // DigestProbe has the counter template's entries (Inc, Get), so that spec exercises the probe unchanged.
    mkdirSync(join(project, "tests"), { recursive: true });
    writeFileSync(join(project, "tests", "DigestProbe.test.ts"), templateTest("counter", "DigestProbe"));
    await run(
        [
            qinitBin,
            "test",
            "--runtime",
            "core",
            "--compiler",
            "clang",
            "--core-dir",
            core,
            "--node-bin",
            nodeBinaryPath,
            "--keep-node",
            "--contract",
            "contracts/DigestProbe.h",
            "--contract-name",
            "DigestProbe",
            "--skip-verify",
            "--timeout",
            "90000",
            "--plain",
        ],
        { cwd: project },
    );

    const state = JSON.parse(
        await run([qinitBin, "state", "DigestProbe", "--digest", "--json"], {
            cwd: project,
            capture: true,
        }),
    ) as { digest?: string };
    if (!state.digest) {
        throw new Error("qinit state returned no digest");
    }

    const [driver, callee] = readFileSync(qpiDigestPath, "utf8").trim().split(/\s+/);
    if (!driver || !callee) {
        throw new Error("QPI parity returned incomplete digests");
    }

    result.stateDigest = state.digest;
    result.qpiDigests = { driver, callee };

    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result));
} finally {
    await stopNode();
    rmSync(scratch, { recursive: true, force: true });
}
