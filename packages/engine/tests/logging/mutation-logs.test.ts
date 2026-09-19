import { beforeAll, expect, test } from "bun:test";
import { CUSTOM_MESSAGE_OP, QUBIC_LOG_TYPE } from "@qinit/proto";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { concatBytes } from "../../src/support/bytes";
import { initK12, k12Bytes } from "../../src/support/k12";
import { packAssetName } from "../../src/ledger/assets";
import { QubicSimulator } from "../../src/qubic-simulator";
import { LOG_HEADER_SIZE, LOG_SC_END_EPOCH, LOG_SC_INITIALIZE, LOG_SC_NOTIFICATION, QubicLogStore } from "../../src/logging/qubic-log-store";
import { contractId } from "../support/helpers";

const ZERO32 = new Uint8Array(32);

interface ParsedLog {
    type: number;
    message: Uint8Array;
}

function parseLogs(logger: QubicLogStore, count: number): ParsedLog[] {
    const bytes = logger.recordsBetween(0n, BigInt(count - 1))!;
    const logs: ParsedLog[] = [];
    let offset = 0;

    while (offset < bytes.length) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
        const sizeAndType = view.getUint32(6, true);
        const messageSize = sizeAndType & 0xffffff;
        logs.push({
            type: sizeAndType >>> 24,
            message: bytes.slice(offset + LOG_HEADER_SIZE, offset + LOG_HEADER_SIZE + messageSize),
        });
        offset += LOG_HEADER_SIZE + messageSize;
    }

    return logs;
}

function writePacked7(message: Uint8Array, offset: number, value: bigint): void {
    for (let index = 0; index < 7; index++) {
        message[offset + index] = Number(value & 0xffn);
        value >>= 8n;
    }
}

function quTransferMessage(source: Uint8Array, destination: Uint8Array, amount: bigint): Uint8Array {
    const message = new Uint8Array(72);
    message.set(source, 0);
    message.set(destination, 32);
    new DataView(message.buffer).setBigInt64(64, amount, true);
    return message;
}

// core's DummyCustomMessage: the marker and nothing else.
function markerMessage(marker: bigint): Uint8Array {
    const message = new Uint8Array(8);
    new DataView(message.buffer).setBigUint64(0, marker, true);
    return message;
}

function burningMessage(source: Uint8Array, amount: bigint, burnedFor: number): Uint8Array {
    const message = new Uint8Array(44);
    const view = new DataView(message.buffer);
    message.set(source);
    view.setBigInt64(32, amount, true);
    view.setUint32(40, burnedFor, true);
    return message;
}

function assetIssuanceMessage(issuer: Uint8Array, shares: bigint, manager: number, name: bigint, decimals: number, unit: bigint): Uint8Array {
    const message = new Uint8Array(63);
    const view = new DataView(message.buffer);
    message.set(issuer);
    view.setBigInt64(32, shares, true);
    view.setBigInt64(40, BigInt(manager), true);
    writePacked7(message, 48, name);
    message[55] = decimals;
    writePacked7(message, 56, unit);
    return message;
}

function assetChangeMessage(
    source: Uint8Array,
    destination: Uint8Array,
    issuer: Uint8Array,
    shares: bigint,
    manager: number,
    name: bigint,
    decimals: number,
    unit: bigint,
): Uint8Array {
    const message = new Uint8Array(127);
    const view = new DataView(message.buffer);
    message.set(source);
    message.set(destination, 32);
    message.set(issuer, 64);
    view.setBigInt64(96, shares, true);
    view.setBigInt64(104, BigInt(manager), true);
    writePacked7(message, 112, name);
    message[119] = decimals;
    writePacked7(message, 120, unit);
    return message;
}

function ownershipManagementMessage(
    owner: Uint8Array,
    issuer: Uint8Array,
    sourceManager: number,
    destinationManager: number,
    shares: bigint,
    name: bigint,
): Uint8Array {
    const message = new Uint8Array(87);
    const view = new DataView(message.buffer);
    message.set(owner);
    message.set(issuer, 32);
    view.setUint32(64, sourceManager, true);
    view.setUint32(68, destinationManager, true);
    view.setBigInt64(72, shares, true);
    writePacked7(message, 80, name);
    return message;
}

function possessionManagementMessage(
    possessor: Uint8Array,
    owner: Uint8Array,
    issuer: Uint8Array,
    sourceManager: number,
    destinationManager: number,
    shares: bigint,
    name: bigint,
): Uint8Array {
    const message = new Uint8Array(119);
    const view = new DataView(message.buffer);
    message.set(possessor);
    message.set(owner, 32);
    message.set(issuer, 64);
    view.setUint32(96, sourceManager, true);
    view.setUint32(100, destinationManager, true);
    view.setBigInt64(104, shares, true);
    writePacked7(message, 112, name);
    return message;
}

beforeAll(initK12);

test("transactions log refunds and successful zero transfers", async () => {
    const logger = new QubicLogStore();
    const sim = new QubicSimulator({ fees: "metered", logStore: logger });
    const source = new Uint8Array(32).fill(0x91);
    const destination = contractId(28);
    const zeroDestination = new Uint8Array(32).fill(0x22);
    const missingSource = new Uint8Array(32).fill(0x33);
    const amount = 20n;

    sim.deploy(28, await wasm("Counter"));
    sim.setContractFeeReserve(28, 0n);
    sim.fund(source, 50n);

    expect(sim.processTickTransaction(source, destination, amount, 1, new Uint8Array(0), "refund")).toEqual({
        moneyFlew: false,
    });
    expect(sim.processTickTransaction(source, zeroDestination, 0n, 0, new Uint8Array(0), "zero-existing")).toEqual({
        moneyFlew: false,
    });
    expect(sim.processTickTransaction(missingSource, zeroDestination, 0n, 0, new Uint8Array(0), "zero-missing")).toEqual({ moneyFlew: false });
    sim.advance();

    const expectedMessages = [
        quTransferMessage(source, destination, amount),
        quTransferMessage(destination, source, amount),
        quTransferMessage(source, zeroDestination, 0n),
    ];
    const logs = parseLogs(logger, 3);
    expect(logs.map((log) => log.type)).toEqual([QUBIC_LOG_TYPE.QU_TRANSFER, QUBIC_LOG_TYPE.QU_TRANSFER, QUBIC_LOG_TYPE.QU_TRANSFER]);
    expect(logger.range(1, 2)).toEqual({ fromLogId: -1n, length: -1n });
    expect(logs.map((log) => log.message)).toEqual(expectedMessages);
    expect(logger.digest(1)).toEqual(k12Bytes(concatBytes([ZERO32, ...expectedMessages])));
});

test("QPI transfers and burns use the Core payload layouts", () => {
    const logger = new QubicLogStore();
    const sim = new QubicSimulator({ logStore: logger });
    const source = contractId(28);
    const missingSource = contractId(27);
    const destination = new Uint8Array(32).fill(0x44);
    const shareholder = new Uint8Array(32).fill(0x45);

    sim.mintDeployShares(28, "DIV", shareholder);

    logger.begin(1, 0);
    expect(sim.host.transfer(27, destination, 0n, 2)).toBe(0n);
    expect(sim.host.burn(27, 0n, 29)).toBe(0n);
    expect(sim.getEntity(missingSource)).toBeNull();
    sim.fund(source, 100n);
    expect(sim.host.transfer(28, destination, 25n, 2)).toBe(75n);
    expect(sim.host.burn(28, 10n, 29)).toBe(65n);
    expect(sim.host.transfer(28, destination, 0n, 2)).toBe(65n);
    expect(sim.host.burn(28, 0n, 29)).toBe(65n);
    expect(sim.host.distributeDividends(28, 0n)).toBe(1);
    logger.end();
    logger.finalizeTick(1);

    const expectedMessages = [
        quTransferMessage(source, destination, 25n),
        burningMessage(source, 10n, 29),
        quTransferMessage(source, destination, 0n),
        burningMessage(source, 0n, 29),
        markerMessage(CUSTOM_MESSAGE_OP.START_DISTRIBUTE_DIVIDENDS),
        quTransferMessage(source, shareholder, 0n),
        markerMessage(CUSTOM_MESSAGE_OP.END_DISTRIBUTE_DIVIDENDS),
    ];
    const logs = parseLogs(logger, 7);
    expect(logs.map((log) => log.type)).toEqual([
        QUBIC_LOG_TYPE.QU_TRANSFER,
        QUBIC_LOG_TYPE.BURNING,
        QUBIC_LOG_TYPE.QU_TRANSFER,
        QUBIC_LOG_TYPE.BURNING,
        QUBIC_LOG_TYPE.CUSTOM_MESSAGE,
        QUBIC_LOG_TYPE.QU_TRANSFER,
        QUBIC_LOG_TYPE.CUSTOM_MESSAGE,
    ]);
    expect(logs.map((log) => log.message)).toEqual(expectedMessages);
    expect(sim.getEntity(shareholder)?.numberOfIncomingTransfers).toBe(1);
    // Custom messages stay out of the tick digest, as on core.
    const digested = expectedMessages.filter((_, index) => logs[index].type !== QUBIC_LOG_TYPE.CUSTOM_MESSAGE);
    expect(logger.digest(1)).toEqual(k12Bytes(concatBytes([ZERO32, ...digested])));
});

test("a dividend payout is bracketed by its two markers, holders or not", () => {
    const logger = new QubicLogStore();
    const sim = new QubicSimulator({ logStore: logger });
    const paying = contractId(28);
    const first = new Uint8Array(32).fill(0x46);
    const second = new Uint8Array(32).fill(0x47);

    sim.mintDeployShares(28, "DIV", first);
    // Contract shares are minted under contract 1's management.
    sim.host.transferShareOwnershipAndPossession(1, packAssetName("DIV"), new Uint8Array(32), first, first, 76n, second);
    sim.fund(paying, 676n * 3n);
    sim.fund(contractId(29), 676n);

    logger.begin(1, 0);
    expect(sim.host.distributeDividends(28, 3n)).toBe(1);
    // No asset was ever minted for this contract: the debit and both markers still happen, as on core.
    expect(sim.host.distributeDividends(29, 1n)).toBe(1);
    // An unaffordable payout stops before the first marker.
    expect(sim.host.distributeDividends(29, 1n)).toBe(0);
    logger.end();
    logger.finalizeTick(1);

    const messages = parseLogs(logger, 6).map((log) => log.message);
    // Which holder is paid first is the ledger's iteration order, pinned against a core node by the logging dual-engine run and not here.
    const payouts = messages.slice(1, 3).sort((left, right) => left[32] - right[32]);
    expect([messages[0], ...payouts, ...messages.slice(3)]).toEqual([
        markerMessage(CUSTOM_MESSAGE_OP.START_DISTRIBUTE_DIVIDENDS),
        quTransferMessage(paying, first, 600n * 3n),
        quTransferMessage(paying, second, 76n * 3n),
        markerMessage(CUSTOM_MESSAGE_OP.END_DISTRIBUTE_DIVIDENDS),
        markerMessage(CUSTOM_MESSAGE_OP.START_DISTRIBUTE_DIVIDENDS),
        markerMessage(CUSTOM_MESSAGE_OP.END_DISTRIBUTE_DIVIDENDS),
    ]);
    expect(sim.balanceOf(29)).toBe(0n);
});

// core transfers the requested fee unconditionally and runs each callback through a reward transfer, so a free transfer logs zero-amount records.
test("a zero-fee rights transfer still logs its fee and callback transfers", async () => {
    const logger = new QubicLogStore();
    const sim = new QubicSimulator({ logStore: logger });
    const approver = contractId(28);
    const acquirer = contractId(29);
    const name = packAssetName("TOKEN");

    sim.deploy(28, await wasm("ShareApprover"));
    sim.deploy(29, await wasm("ShareManager"));
    sim.host.issueAsset(28, name, approver, 0, 1000n, 0n, approver);
    // A contract that never held anything has no spectrum entry, and core logs nothing for a transfer out of one.
    sim.fund(acquirer, 1n);

    logger.begin(1, 0);
    expect(sim.acquireShares(29, name, approver, approver, approver, 400n, 28, 28, 0n)).toBe(0n);
    logger.end();
    logger.finalizeTick(1);

    const logs = parseLogs(logger, Number(logger.range(1, 0).length));
    expect(logs.map((log) => log.type)).toEqual([
        QUBIC_LOG_TYPE.QU_TRANSFER,
        QUBIC_LOG_TYPE.QU_TRANSFER,
        QUBIC_LOG_TYPE.ASSET_OWNERSHIP_MANAGING_CONTRACT_CHANGE,
        QUBIC_LOG_TYPE.ASSET_POSSESSION_MANAGING_CONTRACT_CHANGE,
    ]);
    // The PRE_RELEASE_SHARES callback's reward transfer, then the fee itself; the approver defines no POST callback, so nothing follows the rights.
    expect(logs[0].message).toEqual(quTransferMessage(acquirer, approver, 0n));
    expect(logs[1].message).toEqual(quTransferMessage(acquirer, approver, 0n));
});

test("QPI transfer logs follow the destination callback logs", async () => {
    const logger = new QubicLogStore();
    const sim = new QubicSimulator({ logStore: logger });
    const source = contractId(28);
    const destination = contractId(29);
    const input = new Uint8Array(40);
    input.set(destination);
    new DataView(input.buffer).setBigInt64(32, 5n, true);

    sim.deploy(28, await wasm("Vault"));
    sim.deploy(29, await wasm("IncomingLogger"));
    sim.fund(source, 10n);

    logger.begin(1, 0);
    sim.procedure(28, 2, input);
    logger.end();
    logger.finalizeTick(1);

    const logs = parseLogs(logger, 2);
    expect(logs.map((log) => log.type)).toEqual([QUBIC_LOG_TYPE.CONTRACT_INFORMATION_MESSAGE, QUBIC_LOG_TYPE.QU_TRANSFER]);
    expect(logs[1].message).toEqual(quTransferMessage(source, destination, 5n));
});

test("asset mutations emit exact native records only after success", () => {
    const logger = new QubicLogStore();
    const sim = new QubicSimulator({ logStore: logger });
    const issuer = contractId(28);
    const holder = new Uint8Array(32).fill(0x55);
    const name = packAssetName("TOKEN");
    const unit = 0x0201n;

    logger.begin(1, 0);
    expect(sim.host.issueAsset(28, name, issuer, 2, 1000n, unit, issuer)).toBe(1000n);
    expect(sim.host.transferShareOwnershipAndPossession(28, name, issuer, issuer, issuer, 300n, holder)).toBe(700n);
    expect(sim.transferShareManagementRights(name, issuer, holder, holder, 28, 29, 100n)).toBe(true);

    expect(sim.host.issueAsset(28, name, issuer, 2, 1000n, unit, issuer)).toBe(0n);
    expect(sim.host.transferShareOwnershipAndPossession(28, name, issuer, issuer, issuer, 0n, holder)).toBeLessThan(0n);
    expect(sim.host.transferShareOwnershipAndPossession(28, name, issuer, holder, holder, 10n, holder)).toBe(200n);
    expect(sim.transferShareManagementRights(name, issuer, holder, holder, 28, 29, 9999n)).toBe(false);
    expect(sim.transferShareManagementRights(name, issuer, holder, holder, 29, 29, 100n)).toBe(true);
    logger.end();
    logger.finalizeTick(1);

    const expectedMessages = [
        assetIssuanceMessage(issuer, 1000n, 28, name, 2, unit),
        assetChangeMessage(issuer, holder, issuer, 300n, 28, name, 2, unit),
        assetChangeMessage(issuer, holder, issuer, 300n, 28, name, 2, unit),
        ownershipManagementMessage(holder, issuer, 28, 29, 100n, name),
        possessionManagementMessage(holder, holder, issuer, 28, 29, 100n, name),
        assetChangeMessage(holder, holder, issuer, 10n, 28, name, 2, unit),
        assetChangeMessage(holder, holder, issuer, 10n, 28, name, 2, unit),
        ownershipManagementMessage(holder, issuer, 29, 29, 100n, name),
        possessionManagementMessage(holder, holder, issuer, 29, 29, 100n, name),
    ];
    const logs = parseLogs(logger, 9);
    expect(logs.map((log) => log.type)).toEqual([
        QUBIC_LOG_TYPE.ASSET_ISSUANCE,
        QUBIC_LOG_TYPE.ASSET_OWNERSHIP_CHANGE,
        QUBIC_LOG_TYPE.ASSET_POSSESSION_CHANGE,
        QUBIC_LOG_TYPE.ASSET_OWNERSHIP_MANAGING_CONTRACT_CHANGE,
        QUBIC_LOG_TYPE.ASSET_POSSESSION_MANAGING_CONTRACT_CHANGE,
        QUBIC_LOG_TYPE.ASSET_OWNERSHIP_CHANGE,
        QUBIC_LOG_TYPE.ASSET_POSSESSION_CHANGE,
        QUBIC_LOG_TYPE.ASSET_OWNERSHIP_MANAGING_CONTRACT_CHANGE,
        QUBIC_LOG_TYPE.ASSET_POSSESSION_MANAGING_CONTRACT_CHANGE,
    ]);
    expect(logs.map((log) => log.message)).toEqual(expectedMessages);
    expect(logger.digest(1)).toEqual(k12Bytes(concatBytes([ZERO32, ...expectedMessages])));
});

// Every record of one tick, each with the tick-local range it was written under.
function tickRecords(logger: QubicLogStore, tick: number): { range: number; type: number; message: Uint8Array }[] {
    const records: { range: number; type: number; message: Uint8Array; logId: bigint }[] = [];

    logger.tickRanges(tick).forEach(({ fromLogId, length }, range) => {
        if (fromLogId < 0n || length <= 0n) {
            return;
        }
        const bytes = logger.recordsBetween(fromLogId, fromLogId + length - 1n)!;
        let offset = 0;
        let logId = fromLogId;
        while (offset < bytes.length) {
            const sizeAndType = new DataView(bytes.buffer, bytes.byteOffset + offset).getUint32(6, true);
            const size = sizeAndType & 0xffffff;
            records.push({ range, type: sizeAndType >>> 24, message: bytes.slice(offset + LOG_HEADER_SIZE, offset + LOG_HEADER_SIZE + size), logId: logId++ });
            offset += LOG_HEADER_SIZE + size;
        }
    });

    return records.sort((left, right) => Number(left.logId - right.logId)).map(({ range, type, message }) => ({ range, type, message }));
}

// An epoch's log opens with one marker in the INITIALIZE range of its first tick and closes with the other as the last END_EPOCH record.
test("an epoch's log opens and closes with core's markers", () => {
    const logger = new QubicLogStore();
    const sim = new QubicSimulator({ logStore: logger, epochLength: 3 });
    sim.bootstrapEpoch(2);
    const firstTick = sim.initialTick;

    expect(tickRecords(logger, firstTick)).toEqual([
        { range: LOG_SC_INITIALIZE, type: QUBIC_LOG_TYPE.CUSTOM_MESSAGE, message: markerMessage(CUSTOM_MESSAGE_OP.START_EPOCH) },
    ]);

    // The switch wipes the old epoch's log, so its closing marker is read between the two halves of one.
    sim.advance();
    sim.endEpoch();
    logger.finalizeTick(sim.currentTick + 1);
    expect(tickRecords(logger, sim.currentTick + 1)).toEqual([
        { range: LOG_SC_END_EPOCH, type: QUBIC_LOG_TYPE.CUSTOM_MESSAGE, message: markerMessage(CUSTOM_MESSAGE_OP.END_EPOCH) },
    ]);

    const switching = new QubicLogStore();
    const switched = new QubicSimulator({ logStore: switching, epochLength: 1 });
    switched.advance();
    switched.advance();
    expect(switched.currentEpoch).toBe(1);
    expect(tickRecords(switching, switched.initialTick)).toEqual([
        { range: LOG_SC_INITIALIZE, type: QUBIC_LOG_TYPE.CUSTOM_MESSAGE, message: markerMessage(CUSTOM_MESSAGE_OP.START_EPOCH) },
    ]);
});

test("a metered procedure logs the execution fee taken from its reserve", async () => {
    const logger = new QubicLogStore();
    const sim = new QubicSimulator({ fees: "metered", logStore: logger });
    sim.deploy(28, await wasm("Counter"));
    const before = sim.getContractFeeReserve(28);

    logger.begin(1, 0);
    sim.procedure(28, 1);
    logger.end();
    logger.finalizeTick(1);

    const deducted = before - sim.getContractFeeReserve(28);
    expect(deducted).toBeGreaterThan(0n);

    // { deductedAmount, remainingAmount, contractIndex, padding }: logged whole, as core takes it by sizeof.
    const expected = new Uint8Array(24);
    const view = new DataView(expected.buffer);
    view.setBigUint64(0, deducted, true);
    view.setBigInt64(8, before - deducted, true);
    view.setUint32(16, 28, true);
    expect(tickRecords(logger, 1)).toEqual([{ range: 0, type: QUBIC_LOG_TYPE.CONTRACT_RESERVE_DEDUCTION, message: expected }]);
});

// OracleProbe: procedure 2 queries a price, 3 subscribes, 4 unsubscribes. Price is oracle interface 0.
test("oracle queries and subscribers leave core's status and subscriber records", async () => {
    const logger = new QubicLogStore();
    const sim = new QubicSimulator({ logStore: logger });
    sim.tickDuration = 60_000;
    sim.deploy(29, await wasm("OracleProbe"));
    sim.fund(contractId(29), 1_000_000n);

    const priceInput = new Uint8Array(112);
    priceInput.set(new TextEncoder().encode("mock"), 0);
    priceInput.set(new TextEncoder().encode("BTC"), 40);
    priceInput.set(new TextEncoder().encode("USD"), 72);
    new DataView(priceInput.buffer).setUint32(104, 60_000, true);

    // { queryingEntity, queryId, interfaceIndex, type, status }
    const statusChange = (entity: bigint, queryId: bigint, type: number, status: number) => {
        const message = new Uint8Array(46);
        const view = new DataView(message.buffer);
        view.setBigUint64(0, entity, true);
        view.setBigInt64(32, queryId, true);
        view.setUint32(40, 0, true);
        message[44] = type;
        message[45] = status;
        return message;
    };
    const ofType = (tick: number, type: number) => tickRecords(logger, tick).filter((record) => record.type === type);

    logger.begin(1, 0);
    const queryId = new DataView(sim.procedure(29, 2, priceInput).buffer).getBigInt64(0, true);
    logger.end();
    logger.finalizeTick(1);
    // A contract's own query is keyed by the contract, and starts pending.
    expect(ofType(1, QUBIC_LOG_TYPE.ORACLE_QUERY_STATUS_CHANGE)).toEqual([
        { range: 0, type: QUBIC_LOG_TYPE.ORACLE_QUERY_STATUS_CHANGE, message: statusChange(29n, queryId, 0, 1) },
    ]);

    const reply = new Uint8Array(16);
    new DataView(reply.buffer).setBigInt64(0, 42n, true);
    new DataView(reply.buffer).setBigInt64(8, 1n, true);
    sim.setOracleProvider(() => reply);
    // Tick 1 was written by hand above, so the node's own ticks continue after it.
    sim.currentTick = 1;
    sim.advance();
    // The reply lands between the tick's hooks, so its record sits in the range of the notification it causes.
    expect(ofType(sim.currentTick, QUBIC_LOG_TYPE.ORACLE_QUERY_STATUS_CHANGE)).toEqual([
        { range: LOG_SC_NOTIFICATION, type: QUBIC_LOG_TYPE.ORACLE_QUERY_STATUS_CHANGE, message: statusChange(29n, queryId, 0, 3) },
    ]);

    sim.setOracleProvider(null);
    const subscribeTick = sim.currentTick + 1;
    logger.begin(subscribeTick, 0);
    const subscriptionId = new DataView(sim.procedure(29, 3, priceInput).buffer).getInt32(0, true);
    const unsubscribeInput = new Uint8Array(4);
    new DataView(unsubscribeInput.buffer).setInt32(0, subscriptionId, true);
    sim.procedure(29, 4, unsubscribeInput);
    logger.end();
    logger.finalizeTick(subscribeTick);

    const subscriberRecords = ofType(subscribeTick, QUBIC_LOG_TYPE.ORACLE_SUBSCRIBER_MESSAGE).map((record) => new DataView(record.message.buffer));
    // { subscriptionId, interfaceIndex, contractIndex, period, first query time }: a period of zero is the unsubscribe.
    expect(
        subscriberRecords.map((view) => [view.byteLength, view.getInt32(0, true), view.getUint32(4, true), view.getUint32(8, true), view.getUint32(12, true)]),
    ).toEqual([
        [24, subscriptionId, 0, 29, 60_000],
        [24, subscriptionId, 0, 29, 0],
    ]);
    expect(subscriberRecords[0].getBigUint64(16, true)).toBeGreaterThan(0n);
    expect(subscriberRecords[1].getBigUint64(16, true)).toBe(0n);
    // The subscription's first query is keyed by the subscription, not by the contract.
    expect(ofType(subscribeTick, QUBIC_LOG_TYPE.ORACLE_QUERY_STATUS_CHANGE).map((record) => [record.message[44], record.message[45]])).toEqual([[1, 1]]);
});
