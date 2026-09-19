// which side to update on an ABI mismatch: every release-freshness pair in both ABI directions, then the lookup policy around it.
import { describe, expect, test } from "bun:test";
import { abiAdvice, checkHeadersAbi, type AbiAdviceInput, type AbiCheckDeps, type AbiSide, type Freshness } from "../../src/ops/abi-advice";

const input = (cli: Freshness, headers: Freshness, headersAbi: number, extra: Partial<AbiAdviceInput> = {}): AbiAdviceInput => ({
    cliAbi: 7,
    headersAbi,
    cli,
    headers,
    cliFromSource: false,
    headersPath: "/cache/headers",
    headersManaged: true,
    ...extra,
});

describe("abiAdvice", () => {
    // [cli, headers, headers ABI, side]: release freshness decides first, and the ABI direction only when it cannot.
    const rows: [Freshness, Freshness, number, AbiSide][] = [
        ["latest", "stale", 6, "headers"],
        ["latest", "stale", 8, "headers"],
        ["stale", "latest", 8, "cli"],
        ["stale", "latest", 6, "cli"],
        ["stale", "stale", 6, "both"],
        ["stale", "stale", 8, "both"],
        ["latest", "latest", 6, "skew"],
        ["latest", "latest", 8, "skew"],
        ["latest", "unknown", 8, "headers"],
        ["unknown", "latest", 6, "cli"],
        ["stale", "unknown", 8, "cli"],
        ["stale", "unknown", 6, "headers"],
        ["unknown", "stale", 6, "headers"],
        ["unknown", "stale", 8, "cli"],
        ["unknown", "unknown", 6, "headers"],
        ["unknown", "unknown", 8, "cli"],
    ];

    for (const [cli, headers, headersAbi, side] of rows) {
        test(`cli ${cli} · headers ${headers} · headers ABI ${headersAbi} -> ${side}`, () => {
            expect(abiAdvice(input(cli, headers, headersAbi)).side).toBe(side);
        });
    }

    test("each side names its own command, and both names the CLI first", () => {
        expect(abiAdvice(input("stale", "latest", 8)).fix).toBe("qinit update");
        expect(abiAdvice(input("latest", "stale", 6)).fix).toBe("qinit setup --force");
        expect(abiAdvice(input("stale", "stale", 6)).fix).toBe("qinit update, then qinit setup --force");
    });

    test("a release skew names the side ahead and offers no update", () => {
        const advice = abiAdvice(input("latest", "latest", 8));

        expect(advice.detail).toContain("the headers release is ahead");
        expect(advice.fix).not.toContain("qinit update");
        expect(abiAdvice(input("latest", "latest", 6)).detail).toContain("the CLI release is ahead");
    });

    test("a local checkout and a source CLI get the fix that applies to them", () => {
        const local = abiAdvice(input("latest", "unknown", 6, { headersManaged: false, headersPath: "/work/core" }));
        expect(local.fix).toContain("core checkout at /work/core is ABI 6, CLI expects 7");

        const source = abiAdvice(input("unknown", "latest", 8, { cliFromSource: true }));
        expect(source.fix).toContain("bun run generate:core-abi");
    });
});

describe("checkHeadersAbi", () => {
    const deps = (overrides: Partial<AbiCheckDeps>, calls: string[] = []): Partial<AbiCheckDeps> => ({
        cliAbi: 7,
        readHeadersAbi: () => 6,
        managedHeaders: () => ({ path: "/cache/headers", version: "v1.0.0" }),
        cliFromSource: () => false,
        latestCli: async () => {
            calls.push("cli");
            return { current: "1.0.0", latest: "1.0.0" };
        },
        latestHeadersVersion: async () => {
            calls.push("headers");
            return "v1.1.0";
        },
        updatesDisabled: () => false,
        lookupTimeoutMs: 50,
        ...overrides,
    });

    test("matching ABIs and headers without ABI metadata cost no lookup and give no verdict", async () => {
        const calls: string[] = [];

        expect(await checkHeadersAbi("/cache/headers", deps({ readHeadersAbi: () => 7 }, calls))).toBeNull();
        expect(await checkHeadersAbi("/cache/headers", deps({ readHeadersAbi: () => null }, calls))).toBeNull();
        expect(calls).toEqual([]);
    });

    test("a latest CLI over stale managed headers points at the headers", async () => {
        const advice = await checkHeadersAbi("/cache/headers", deps({}));

        expect(advice?.side).toBe("headers");
        expect(advice?.fix).toBe("qinit setup --force");
    });

    test("with updates disabled nothing is fetched and the ABI direction decides", async () => {
        const calls: string[] = [];
        const advice = await checkHeadersAbi("/cache/headers", deps({ updatesDisabled: () => true, readHeadersAbi: () => 8 }, calls));

        expect(calls).toEqual([]);
        expect(advice?.side).toBe("cli");
    });

    test("a core directory outside the cache is a local checkout, whose release is never looked up", async () => {
        const calls: string[] = [];
        const advice = await checkHeadersAbi("/work/core", deps({}, calls));

        expect(calls).toEqual(["cli"]);
        expect(advice?.fix).toContain("core checkout at /work/core");
    });

    test("a lookup that hangs or fails degrades to the ABI direction", async () => {
        const advice = await checkHeadersAbi(
            "/cache/headers",
            deps({
                latestCli: () => new Promise(() => {}),
                latestHeadersVersion: async () => {
                    throw new Error("offline");
                },
            }),
        );

        expect(advice?.side).toBe("headers");
    });
});
