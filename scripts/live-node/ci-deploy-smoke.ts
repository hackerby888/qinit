// Deploy live contracts and prove their read, write, debug, and log paths.
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { deployContract } from "@qinit/cli/ops/deploy";
import { callFunction, invokeProcedure, decodeLog } from "@qinit/proto";
import { extractIdl } from "@qinit/build";
import { loadQpiHeader } from "@qinit/compiler";
import { DEFAULT_RPC_BASE, LiteRpc } from "@qinit/core";

const rpcBaseUrl = process.env.QINIT_RPC ?? DEFAULT_RPC_BASE;
const core = process.env.QINIT_CORE;
if (!core) {
    console.error("QINIT_CORE not set");
    process.exit(2);
}
const rpc = new LiteRpc(rpcBaseUrl);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message: string) => {
    console.error("SMOKE FAIL: " + message);
    process.exit(1);
};

const identity = await rpc.whoami();
if (identity.backend !== "core") {
    fail(`expected core backend identity, got ${JSON.stringify(identity)}`);
}

// Read a single uint64 output while tolerating scalar and named output shapes.
const readUint64Value = async (slot: number): Promise<bigint> => {
    const output: any = await callFunction(rpc, slot, 1, "", "uint64");
    const value = output && typeof output === "object" ? Object.values(output)[0] : output;
    return BigInt(value as any);
};

console.log("deploy Counter…");
const counterDeployment = await deployContract({ contractPath: resolve("fixtures/Counter.h"), name: "Counter", core, rpcBaseUrl }, (event: any) => {
    if (!("note" in event)) {
        console.log(`  ${event.step}: ${event.state}${event.detail ? " — " + event.detail : ""}`);
    }
});
if (!counterDeployment.ok || counterDeployment.slot == null) {
    fail("deploy: " + JSON.stringify(counterDeployment));
}
const counterSlot = counterDeployment.slot!;
console.log("deployed slot", counterSlot);

// INITIALIZE runs at a deferred construct tick → poll until Get resolves to 0.
let initialValue = -1n;
for (let i = 0; i < 15; i++) {
    try {
        initialValue = await readUint64Value(counterSlot);
        if (initialValue === 0n) {
            break;
        }
    } catch {}
    await sleep(1500);
}
console.log("Get after deploy =", initialValue.toString());
if (initialValue !== 0n) {
    fail(`expected 0 after deploy, got ${initialValue}`);
}

// Enable debugging before inter-contract calls to exercise nested dirty-page capture.
console.log("enable debug…");
await rpc.setDebug(true);

const seed = (await rpc.fundedSeed()) ?? "a".repeat(55);
const invokeEmptyProcedure = async (slot: number, label: string) => {
    const tick = (await rpc.tickInfo()).tick + 6;
    console.log(`${label} @tick`, tick);
    const result: any = await invokeProcedure({
        seed,
        rpcBaseUrl,
        contractIndex: slot,
        procedureId: 1,
        amount: 0,
        inputFormat: "",
        tick,
        confirm: true,
        rpc,
    });
    if (!result.ok || !result.confirmed || !result.included) {
        fail(`${label} not confirmed/included: ${JSON.stringify(result)}`);
    }
};

console.log("deploy Proxy…");
const proxyDeployment = await deployContract(
    {
        contractPath: resolve("fixtures/Proxy.h"),
        name: "Proxy",
        core,
        rpcBaseUrl,
        seed,
        compiler: "typescript",
        dynCallees: {
            Counter: {
                header: resolve("fixtures/Counter.h"),
                index: counterSlot,
            },
        },
        rpc,
    },
    (event: any) => {
        if (!("note" in event)) {
            console.log(`  ${event.step}: ${event.state}${event.detail ? " — " + event.detail : ""}`);
        }
    },
);
if (!proxyDeployment.ok || proxyDeployment.slot == null) {
    fail("deploy Proxy: " + JSON.stringify(proxyDeployment));
}
const proxySlot = proxyDeployment.slot!;
console.log("deployed Proxy slot", proxySlot);

const traceBeforeProxyCalls = await rpc.debugTrace(0, 256);
const proxyTraceStart = traceBeforeProxyCalls.entries.reduce((latest, entry) => Math.max(latest, entry.seq), 0);
for (let expected = 1; expected <= 2; expected++) {
    await invokeEmptyProcedure(proxySlot, `BumpCounter #${expected}`);

    const value = await readUint64Value(proxySlot);
    console.log(`ReadCounter after BumpCounter #${expected} =`, value.toString());
    if (value !== BigInt(expected)) {
        fail(`ReadCounter after BumpCounter #${expected}: expected ${expected}, got ${value}`);
    }
}

const proxyTrace = await rpc.debugTrace(proxyTraceStart, 64);
const outerProxyCalls = proxyTrace.entries.filter((entry) => entry.index === proxySlot && entry.entry === 1 && entry.kind === 1 && entry.ok);
const nestedCounterCalls = proxyTrace.entries.filter((entry) => entry.index === counterSlot && entry.entry === 1 && entry.kind === 1 && entry.ok);
const outerProxyReads = proxyTrace.entries.filter((entry) => entry.index === proxySlot && entry.entry === 1 && entry.kind === 0 && entry.ok);
if (outerProxyCalls.length !== 2 || nestedCounterCalls.length !== 2 || outerProxyReads.length !== 2) {
    fail(
        "nested trace records: expected 2 Proxy procedures, 2 Counter procedures, and 2 Proxy reads, " +
            `got ${outerProxyCalls.length}, ${nestedCounterCalls.length}, and ${outerProxyReads.length}`,
    );
}

const counterTransitions = [
    ["0000000000000000", "0100000000000000"],
    ["0100000000000000", "0200000000000000"],
] as const;
for (const [index, entry] of nestedCounterCalls.entries()) {
    const [before, after] = counterTransitions[index];
    const hasExpectedDiff = entry.stateDiff.some((diff) => diff.off === 0 && diff.before.startsWith(before) && diff.after.startsWith(after));
    if (!hasExpectedDiff || entry.stateTruncated) {
        fail(`nested Counter #${index + 1} missing ${before}->${after} state diff: ` + JSON.stringify(entry));
    }
}

const expectedCallee = `-> ${counterSlot}/1`;
for (const [index, entry] of outerProxyCalls.entries()) {
    const invokesCounter = entry.hostCalls.some((call) => call.name === "invokeProcedure" && call.detail.includes(expectedCallee));
    if (entry.stateDiff.length || entry.stateTruncated || !invokesCounter) {
        fail(`Proxy BumpCounter #${index + 1} trace ownership is wrong: ` + JSON.stringify(entry));
    }
}
for (const [index, entry] of outerProxyReads.entries()) {
    const callsCounter = entry.hostCalls.some((call) => call.name === "callFunction" && call.detail.includes(expectedCallee));
    if (!callsCounter) {
        fail(`Proxy ReadCounter #${index + 1} host-call attribution is wrong: ` + JSON.stringify(entry));
    }
}

await invokeEmptyProcedure(counterSlot, "direct Counter Inc");

let updatedValue = -1n;
for (let i = 0; i < 10; i++) {
    updatedValue = await readUint64Value(counterSlot);
    if (updatedValue === 3n) {
        break;
    }
    await sleep(1500);
}
console.log("Get after direct Inc =", updatedValue.toString());
if (updatedValue !== 3n) {
    fail(`expected 3 after direct Inc, got ${updatedValue}`);
}

// The direct Inc must appear in the trace with the counter state diff (02 -> 03).
let debugOk = false;
for (let i = 0; i < 8; i++) {
    const trace = await rpc.debugTrace(0, 50);
    const inc = (trace.entries ?? []).filter((entry) => entry.index === counterSlot && entry.kind === 1 && entry.stateDiff.length).pop();
    if (inc) {
        console.log("debug: Inc stateDiff " + JSON.stringify(inc.stateDiff));
        // The node reports changed bytes as a window rather than the minimal run, so the counter is the
        // leading little-endian uint64 of the region that starts at the state's offset 0.
        debugOk = inc.stateDiff.some((diff) => diff.off === 0 && diff.before.startsWith("0200000000000000") && diff.after.startsWith("0300000000000000"));
        break;
    }
    await sleep(1500);
}
if (!debugOk) {
    fail("debug trace missing the Inc state diff (counter 02->03) — mprotect capture broken?");
}

console.log("redeploy Counter with the TypeScript compiler…");
const counterRedeployment = await deployContract(
    {
        contractPath: resolve("fixtures/Counter.h"),
        name: "Counter",
        core,
        rpcBaseUrl,
        seed,
        compiler: "typescript",
        slotOverride: counterSlot,
        rpc,
    },
    () => {},
);
if (!counterRedeployment.ok || counterRedeployment.slot !== counterSlot) {
    fail("redeploy Counter: " + JSON.stringify(counterRedeployment));
}
if ((await readUint64Value(counterSlot)) !== 3n) {
    fail("Counter state changed during the same-layout redeploy");
}

console.log("migrate Counter to CounterV2…");
const counterMigration = await deployContract(
    {
        contractPath: resolve("fixtures/CounterV2.h"),
        name: "Counter",
        core,
        rpcBaseUrl,
        seed,
        slotOverride: counterSlot,
        rpc,
    },
    () => {},
);
if (!counterMigration.ok || counterMigration.slot !== counterSlot) {
    fail("migrate Counter: " + JSON.stringify(counterMigration));
}

const readCounterV2 = async (): Promise<[bigint, bigint]> => {
    const output = await callFunction(rpc, counterSlot, 1, "", "uint64, uint64");
    return [BigInt(output[0]), BigInt(output[1])];
};
const [migratedCounter, migratedAtTick] = await readCounterV2();
if (migratedCounter !== 3n || migratedAtTick === 0n) {
    fail(`CounterV2 migration lost state: counter=${migratedCounter}, tick=${migratedAtTick}`);
}

await invokeEmptyProcedure(counterSlot, "CounterV2 Inc");
const [counterV2Value, migrationTickAfterCall] = await readCounterV2();
if (counterV2Value !== 4n || migrationTickAfterCall !== migratedAtTick) {
    fail(`CounterV2 post-migration call failed: counter=${counterV2Value}, ` + `tick=${migrationTickAfterCall}`);
}

// The migration itself is a traced dispatch: its input is the whole old state (v1's single uint64) and
// its diff is the new layout, written over a state the node zeroed first.
const migration = ((await rpc.debugTrace(0, 256)).entries ?? []).find((entry) => entry.index === counterSlot && entry.kind === 3);
if (!migration || !migration.ok || migration.inSize !== 8) {
    fail("debug trace missing the migration entry: " + JSON.stringify(migration ?? null));
}
console.log("debug: migrate stateDiff " + JSON.stringify(migration!.stateDiff));
if (!migration!.stateDiff.some((diff) => diff.off === 0 && diff.after.startsWith("0300000000000000"))) {
    fail("migration entry carries no state diff for the counter it migrated");
}

// Deploy Logger and verify that Emit(2) produces a decoded INFO log.
console.log("deploy Logger…");
const loggerDeployment = await deployContract({ contractPath: resolve("fixtures/Logger.h"), name: "Logger", core, rpcBaseUrl }, (event: any) => {
    if (!("note" in event)) {
        console.log(`  ${event.step}: ${event.state}${event.detail ? " — " + event.detail : ""}`);
    }
});
if (!loggerDeployment.ok || loggerDeployment.slot == null) {
    fail("deploy Logger: " + JSON.stringify(loggerDeployment));
}
const loggerSlot = loggerDeployment.slot!;
console.log("deployed Logger slot", loggerSlot);
const loggerIdl = extractIdl(readFileSync(resolve("fixtures/Logger.h"), "utf8"), "Logger", {
    slot: loggerSlot,
    qpiHeader: loadQpiHeader(core),
});
const enumNames: Record<string, string> = {};
for (const entry of loggerIdl.enums ?? []) {
    Object.assign(enumNames, entry.members);
}
const loggerTickInfo = await rpc.tickInfo();
const loggerTick = loggerTickInfo.tick + 6;
console.log("Emit(2) @tick", loggerTick);
const loggerInvocation: any = await invokeProcedure({
    seed,
    rpcBaseUrl,
    contractIndex: loggerSlot,
    procedureId: 1,
    amount: 0,
    inputFormat: "2uint64",
    tick: loggerTick,
    confirm: true,
    rpc,
});
if (!loggerInvocation.ok || !loggerInvocation.confirmed) {
    fail("Emit not confirmed: " + JSON.stringify(loggerInvocation));
}
let decodedLogOk = false;
for (let i = 0; i < 10; i++) {
    const trace = await rpc.debugTrace(0, 200);
    const emit = (trace.entries ?? []).find((entry) => entry.index === loggerSlot && entry.kind === 1 && (entry.logs?.length ?? 0) > 0);
    if (emit) {
        const log = emit.logs[0];
        const decoded = await decodeLog(log.type, log.size, log.hex, loggerIdl.logs, enumNames);
        console.log("log decode: " + JSON.stringify(decoded, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
        decodedLogOk = decoded.severity === "INFO" && decoded.name === "LogMsg" && decoded.fields?.value !== undefined && decoded.typeName === "LogValue";
        break;
    }
    await sleep(1500);
}
if (!decodedLogOk) {
    fail("debug trace missing decoded LOG_* (logs[] wire / decode / enum-name broken?)");
}

await rpc.setDebug(false);
// Confirm the node survived the dirty-page capture path.
if (!(await rpc.tickInfo())) {
    fail("node unresponsive after debug");
}

console.log("SMOKE OK — deploy + read + write + nested debug-trace + log-decode " + `verified on-chain (slots ${counterSlot},${proxySlot},${loggerSlot})`);
