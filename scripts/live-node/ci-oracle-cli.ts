// Drive a contract's oracle queries through the CLI: answers typed by hand first, then answers served from a rules file.
// With QINIT_RPC it uses the node that names, which is how it runs on a core node; without, it starts a simulator node of its own.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LiteRpc } from "@qinit/core";
import { ORACLE_STATUS } from "@qinit/proto";
import { CLI_ENTRY } from "../../test-utils/cli";

const core = process.env.QINIT_CORE;
if (!core) {
    console.error("QINIT_CORE not set");
    process.exit(2);
}

// OracleDemo: Ask is procedure 1, Subscribe 2, Unsubscribe 3, Fund 4; Get is function 1, Status 2.
const CONTRACT = "OracleDemo";
const ASK = 1;
const SUBSCRIBE = 2;
const UNSUBSCRIBE = 3;
const FUND = 4;
const GET = 1;
const STATUS = 2;
const PRICE_QUERY_FEE = 10;
const MINUTE_SUBSCRIPTION_FEE = 10_000;
const TWO_MINUTE_SUBSCRIPTION_FEE = 6_500;
const RULES = { Price: "777sint64, 7sint64" };
const CLI_TIMEOUT_MS = 180_000;
// a core node needs its commit, quorum and reveal rounds, and the tick that carries its commits takes it half a minute.
const NOTIFICATION_BUDGET_SECONDS = 90;
const SUBSCRIPTION_PERIOD_SECONDS = 60;
const POLL_MS = 2000;

// its own ports, scratch directory and cache: the cache holds the pointers to a developer's node, which this must not move.
const givenNode = process.env.QINIT_RPC;
const rpcBaseUrl = givenNode ?? `http://127.0.0.1:${process.env.QINIT_ORACLE_CLI_RPC_PORT ?? 41999}`;
const peerPort = process.env.QINIT_ORACLE_CLI_PEER_PORT ?? "31999";
const work = mkdtempSync(join(tmpdir(), "qinit-oracle-cli-"));
const scratch = join(work, "sim");
const environment = { ...process.env, QINIT_CACHE: join(work, "cache"), QINIT_NO_UPDATE: "1", CI: "true" };

const sleep = (milliseconds: number) => new Promise((wake) => setTimeout(wake, milliseconds));
const withoutColors = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

let passed = 0;
const failures: string[] = [];
function check(label: string, actual: unknown, expected: unknown): void {
    if (String(actual) === String(expected)) {
        passed++;
        console.log(`  PASS  ${label} = ${actual}`);
        return;
    }

    failures.push(label);
    console.log(`  FAIL  ${label}: got '${actual}', expected '${expected}'`);
}

// the result a command prints with --json; a refusal is a result too, so only a command that prints none throws.
async function cli(...args: string[]): Promise<any> {
    const child = Bun.spawn([process.execPath, CLI_ENTRY, ...args, "--rpc", rpcBaseUrl, "--json"], {
        cwd: work,
        env: environment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), CLI_TIMEOUT_MS);
    try {
        const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        const result = withoutColors(stdout)
            .split("\n")
            .filter((line) => line.startsWith("{"))
            .at(-1);
        if (!result) {
            throw new Error(`qinit ${args.join(" ")} printed no result\n${withoutColors(stderr || stdout).trim()}`);
        }
        return JSON.parse(result);
    } finally {
        clearTimeout(timer);
    }
}

async function done(result: Promise<any>, what: string): Promise<any> {
    const outcome = await result;
    if (!outcome.ok) {
        throw new Error(`${what} failed: ${outcome.error ?? JSON.stringify(outcome)}`);
    }
    return outcome;
}

// the cli stops waiting after a while and says so by leaving the balance out; the contract is only read once the tick has run.
async function invoke(procedure: number, input?: string, amount?: number): Promise<void> {
    const sent = await done(
        cli("call", "--proc", CONTRACT, String(procedure), ...(input ? ["--in", input] : []), ...(amount ? ["--amount", String(amount)] : [])),
        `procedure ${procedure}`,
    );
    if (sent.balance != null) {
        return;
    }

    console.log(`  procedure ${procedure} waits for tick ${sent.tick}`);
    const deadline = Date.now() + CLI_TIMEOUT_MS;
    while ((await rpc.tickInfo()).tick <= sent.tick) {
        if (Date.now() > deadline) {
            throw new Error(`the node never ran tick ${sent.tick}`);
        }
        await sleep(POLL_MS);
    }
}
const get = async () => (await done(cli("call", "--fn", CONTRACT, String(GET)), "Get")) as { balance: string; out: Record<string, string | number> };
const state = async (field: string) => String((await get()).out[field]);
const balance = async () => Number((await get()).balance);
// other contracts on a node that was given may wait for answers of their own
let slot = -1;
const pendingIds = async () =>
    ((await done(cli("oracle", "pending"), "oracle pending")).pending as { queryId: string; slot: number }[])
        .filter((pending) => pending.slot === slot)
        .map((pending) => pending.queryId)
        .join(",");

// a function with one output member comes back as the bare value
async function statusOf(queryId: string): Promise<number> {
    const output = (await done(cli("call", "--fn", CONTRACT, String(STATUS), "--in", `${queryId}sint64`), "Status")).out;
    return Number(typeof output === "object" ? output.status : output);
}

async function waitFor(field: string, value: number, seconds = NOTIFICATION_BUDGET_SECONDS): Promise<void> {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
        if ((await state(field)) === String(value)) {
            return;
        }
        await sleep(POLL_MS);
    }
}

const rpc = new LiteRpc(rpcBaseUrl);
let serving: ReturnType<typeof Bun.spawn> | undefined;
let nodeStarted = false;
// a query a core node still works on when its subscriber leaves is answered later; the simulator leaves none behind
let inFlightSeconds = 0;
try {
    console.log("== start");
    if (givenNode) {
        const backend = (await rpc.whoami()).backend;
        inFlightSeconds = backend === "core" ? NOTIFICATION_BUDGET_SECONDS : 0;
        console.log(`node: ${givenNode}, ${backend}`);
    } else {
        const node = await done(
            cli("node", "run", "--runtime", "simulator", "--core-dir", core, "--scratch-dir", scratch, "--peer-port", peerPort, "--tick-ms", "1000", "--compiler", "typescript"),
            "node run",
        );
        nodeStarted = true;
        console.log(`node: ${node.runtime}, tick ${node.tick}`);
    }
    const deployed = await done(
        cli("deploy", resolve("fixtures/OracleDemo.h"), "--contract-name", CONTRACT, "--core-dir", core, "--compiler", "typescript"),
        "deploy",
    );
    slot = deployed.slot;
    console.log(`deployed ${deployed.contract} at slot ${slot}`);
    await invoke(FUND, undefined, 100_000);
    let funds = 100_000;
    check("contract balance after funding", await balance(), funds);

    console.log("== manual: a query waits for its answer");
    await invoke(ASK, "120000uint32");
    const answered = await state("askedQueryId");
    funds -= PRICE_QUERY_FEE;
    check("query fee burned", await balance(), funds);
    check("pending lists the query", await pendingIds(), answered);
    check("status is PENDING", await statusOf(answered), ORACLE_STATUS.PENDING);
    check("nothing notified yet", await state("notifications"), 0);

    console.log("== manual: a reply of the wrong type is refused before it is sent");
    const mistyped = await cli("oracle", "resolve", answered, "--reply", "1000uint64, 10uint64");
    check("refused", mistyped.ok, false);
    check("the refusal names the member", String(mistyped.error).includes("input.numerator is sint64"), true);
    check("query still pending", await statusOf(answered), ORACLE_STATUS.PENDING);

    console.log("== manual: resolve with a value");
    const resolved = await done(cli("oracle", "resolve", answered, "--reply", "123456sint64, 1000sint64"), "oracle resolve");
    check("reply bytes sent", resolved.resolved.reply, "40e2010000000000e803000000000000");
    await waitFor("notifications", 1);
    check("notified once", await state("notifications"), 1);
    check("status is SUCCESS", await statusOf(answered), ORACLE_STATUS.SUCCESS);
    check("callback status", await state("lastStatus"), ORACLE_STATUS.SUCCESS);
    check("callback query id", await state("lastQueryId"), answered);
    check("callback subscription id", await state("lastSubscriptionId"), -1);
    check("numerator", await state("lastNumerator"), 123456);
    check("denominator", await state("lastDenominator"), 1000);
    check("told after the call, not inside it", await state("notificationsInsideCall"), 0);
    check("pending is empty", await pendingIds(), "");

    console.log("== manual: an answered query takes no second answer");
    const again = await cli("oracle", "resolve", answered, "--reply", "1sint64, 1sint64");
    check("refused", again.ok, false);
    check("numerator unchanged", await state("lastNumerator"), 123456);

    console.log("== manual: the oracle has no value, the query ends at its timeout");
    await invoke(ASK, "12000uint32");
    const unavailable = await state("askedQueryId");
    funds -= PRICE_QUERY_FEE;
    await done(cli("oracle", "resolve", unavailable, "--status", "unavailable"), "oracle resolve --status unavailable");
    check("status stays PENDING", await statusOf(unavailable), ORACLE_STATUS.PENDING);
    await waitFor("timeouts", 1);
    check("timeouts", await state("timeouts"), 1);
    check("status is TIMEOUT", await statusOf(unavailable), ORACLE_STATUS.TIMEOUT);
    check("callback status", await state("lastStatus"), ORACLE_STATUS.TIMEOUT);
    check("callback query id", await state("lastQueryId"), unavailable);

    console.log("== manual: nobody answers");
    await invoke(ASK, "4000uint32");
    const unanswered = await state("askedQueryId");
    funds -= PRICE_QUERY_FEE;
    await waitFor("timeouts", 2);
    check("timeouts", await state("timeouts"), 2);
    check("status is TIMEOUT", await statusOf(unanswered), ORACLE_STATUS.TIMEOUT);

    console.log("== a request the engine refuses: told inside the call, fee handed back");
    await invoke(ASK, "3600001uint32");
    check("query id", await state("askedQueryId"), -1);
    check("unknowns", await state("unknowns"), 1);
    check("told inside the call", await state("notificationsInsideCall"), 1);
    check("callback query id", await state("lastQueryId"), -1);
    check("callback status", await state("lastStatus"), ORACLE_STATUS.UNKNOWN);
    check("balance unchanged", await balance(), funds);

    console.log("== automatic: the rules file answers a query");
    const rules = join(work, "oracle.json");
    writeFileSync(rules, JSON.stringify(RULES));
    console.log(`  ${JSON.stringify(RULES)}`);
    serving = Bun.spawn([process.execPath, CLI_ENTRY, "oracle", "serve", "--rules", rules, "--rpc", rpcBaseUrl], {
        cwd: work,
        env: environment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    await invoke(ASK, "60000uint32");
    const served = await state("askedQueryId");
    funds -= PRICE_QUERY_FEE;
    await waitFor("successes", 2);
    check("successes", await state("successes"), 2);
    check("callback query id", await state("lastQueryId"), served);
    check("numerator from the rules", await state("lastNumerator"), 777);
    check("denominator from the rules", await state("lastDenominator"), 7);

    console.log("== automatic: a subscription is answered every minute");
    await invoke(SUBSCRIBE, "60000uint32, 0bit");
    funds -= MINUTE_SUBSCRIPTION_FEE;
    const subscription = await state("subscriptionId");
    check("subscribed", Number(subscription) >= 0, true);
    check("subscription fee burned", await balance(), funds);
    await waitFor("subscriptionNotifications", 1);
    check("first subscription notification", await state("subscriptionNotifications"), 1);
    check("callback subscription id", await state("lastSubscriptionId"), subscription);
    check("callback status", await state("lastStatus"), ORACLE_STATUS.SUCCESS);
    const firstSubscriptionQuery = await state("lastQueryId");

    console.log("== the same subscription twice is refused, fee handed back");
    await invoke(SUBSCRIBE, "60000uint32, 0bit");
    check("subscribe result", await state("lastSubscribeResult"), -1);
    check("unknowns", await state("unknowns"), 2);
    check("told inside the call", await state("notificationsInsideCall"), 2);
    check("balance unchanged", await balance(), funds);
    check("the contract keeps its subscription", await state("subscriptionId"), subscription);

    console.log("  waiting a minute for the subscription's next query");
    await waitFor("subscriptionNotifications", 2, SUBSCRIPTION_PERIOD_SECONDS + NOTIFICATION_BUDGET_SECONDS);
    check("second subscription notification", await state("subscriptionNotifications"), 2);
    const secondSubscriptionQuery = await state("lastQueryId");
    check("it is about another query", secondSubscriptionQuery !== firstSubscriptionQuery && Number(secondSubscriptionQuery) > 0, true);
    check("no timeouts added", await state("timeouts"), 2);

    console.log("== unsubscribe: no more queries");
    await invoke(UNSUBSCRIBE);
    check("unsubscribe ok", await state("lastUnsubscribeOk"), 1);
    if (inFlightSeconds) {
        console.log("  letting the node finish what it had started");
        await sleep(inFlightSeconds * 1000);
    }
    const notifiedWhenLeaving = await state("notifications");
    const lastRevealed = await state("lastQueryId");
    console.log("  watching for longer than the period");
    await sleep((SUBSCRIPTION_PERIOD_SECONDS + 5) * 1000);
    check("no notification after leaving", await state("notifications"), notifiedWhenLeaving);
    check("nothing is pending", await pendingIds(), "");

    console.log("== subscribe again and ask for the previous reply");
    await invoke(SUBSCRIBE, "120000uint32, 1bit");
    funds -= TWO_MINUTE_SUBSCRIPTION_FEE;
    check("same subscription id", await state("lastSubscribeResult"), subscription);
    check("subscription fee burned", await balance(), funds);
    check("told inside the call", await state("notificationsInsideCall"), 3);
    check("it is the last revealed query", await state("lastInsideCallQueryId"), lastRevealed);
    check("numerator of the previous reply", await state("lastNumerator"), 777);
    console.log("  the subscription then asks again by itself");
    await waitFor("notifications", Number(notifiedWhenLeaving) + 2);
    check("notifications", await state("notifications"), Number(notifiedWhenLeaving) + 2);
    await invoke(UNSUBSCRIBE);
    check("unsubscribe ok", await state("lastUnsubscribeOk"), 1);

    console.log("== every notification is counted once");
    const counted = (await get()).out;
    console.log(`  ${JSON.stringify(counted)}`);
    const byStatus = ["successes", "timeouts", "unresolvables", "unknowns"].reduce((sum, field) => sum + Number(counted[field]), 0);
    check("notifications by status", byStatus, counted.notifications);
    // one answered by hand, one by the rules, and every notification of the subscription
    check("successes", counted.successes, 2 + Number(counted.subscriptionNotifications));
    check("timeouts", counted.timeouts, 2);
    check("unresolvables", counted.unresolvables, 0);
} catch (error) {
    failures.push(`stopped: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`  FAIL  ${failures.at(-1)}`);
} finally {
    if (serving) {
        serving.kill();
        const answers = withoutColors(await new Response(serving.stdout as ReadableStream).text()).match(/#\d+ \w+ answered/g) ?? [];
        console.log(`serve answered ${new Set(answers).size} queries`);
    }
    if (nodeStarted) {
        const stopped = await cli("node", "stop", "--scratch-dir", scratch).catch((error) => ({ ok: false, error: String(error) }));
        console.log(`node: ${stopped.ok ? "stopped" : `not stopped, ${stopped.error}`}`);
    }
    rmSync(work, { recursive: true, force: true });
}

if (failures.length) {
    console.error(`ORACLE CLI FAIL: ${failures.length} of ${passed + failures.length} checks\n  ${failures.join("\n  ")}`);
    process.exit(1);
}
console.log(`ORACLE CLI OK — ${passed} checks: manual answers, a served rules file, a subscription, refusals and timeouts all reach the contract's notification procedure`);
