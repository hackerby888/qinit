// `show` is the advertised read subcommand of tick and epoch; it used to be rejected as unknown.
import { expect, test } from "bun:test";
import { join } from "node:path";

const cli = join(import.meta.dir, "../../src/index.tsx");
const canListen = (() => {
    try {
        const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
        probe.stop(true);
        return true;
    } catch {
        return false;
    }
})();

async function run(port: number, ...args: string[]) {
    const child = Bun.spawn([process.execPath, cli, ...args, "--json", "--rpc", `http://127.0.0.1:${port}`], {
        env: { ...process.env, QINIT_NO_UPDATE: "1", CI: "true" },
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code: child.exitCode, json: JSON.parse(stdout.trim().split("\n").pop()!) };
}

test.skipIf(!canListen)("tick show and epoch show read the epoch; an unknown subcommand is still refused", async () => {
    const server = Bun.serve({
        port: 0,
        fetch(request) {
            if (new URL(request.url).pathname === "/live/v1/dev/epoch-info") {
                return Response.json({ epoch: 3, tick: 8173, initialTick: 8105, epochLastTick: 10805, ticksLeft: 2632, duration: 2701 });
            }
            return new Response("not found", { status: 404 });
        },
    });

    try {
        for (const command of ["tick", "epoch"]) {
            for (const args of [[command], [command, "show"]]) {
                const result = await run(server.port!, ...args);
                expect(result.code, args.join(" ")).toBe(0);
                expect(result.json.action, args.join(" ")).toBe("show");
                expect(result.json.epoch, args.join(" ")).toBe(3);
                expect(result.json.error, args.join(" ")).toBeNull();
            }

            const bogus = await run(server.port!, command, "bogus");
            expect(bogus.code).toBe(1);
            expect(bogus.json.error).toContain("unknown subcommand 'bogus' (use: show |");
        }
    } finally {
        server.stop(true);
    }
}, 60_000);
