import { beforeAll, expect, test } from "bun:test";
import { QUBIC_LOG_TYPE } from "@qinit/proto";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { concatBytes } from "../../src/support/bytes";
import { initK12, k12Bytes } from "../../src/support/k12";
import { packAssetName } from "../../src/ledger/assets";
import { QubicSimulator } from "../../src/qubic-simulator";
import { LOG_HEADER_SIZE, QubicLogStore } from "../../src/logging/qubic-log-store";
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
    sim.setFeeReserve(28, 0n);
    sim.fund(source, 50n);

    expect(sim.applyTx(source, destination, amount, 1, new Uint8Array(0), "refund")).toEqual({
        moneyFlew: false,
    });
    expect(sim.applyTx(source, zeroDestination, 0n, 0, new Uint8Array(0), "zero-existing")).toEqual({
        moneyFlew: false,
    });
    expect(sim.applyTx(missingSource, zeroDestination, 0n, 0, new Uint8Array(0), "zero-missing")).toEqual({ moneyFlew: false });
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
    expect(sim.entityOf(missingSource)).toBeNull();
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
        quTransferMessage(source, shareholder, 0n),
    ];
    const logs = parseLogs(logger, 5);
    expect(logs.map((log) => log.type)).toEqual([
        QUBIC_LOG_TYPE.QU_TRANSFER,
        QUBIC_LOG_TYPE.BURNING,
        QUBIC_LOG_TYPE.QU_TRANSFER,
        QUBIC_LOG_TYPE.BURNING,
        QUBIC_LOG_TYPE.QU_TRANSFER,
    ]);
    expect(logs.map((log) => log.message)).toEqual(expectedMessages);
    expect(sim.entityOf(shareholder)?.numberOfIncomingTransfers).toBe(1);
    expect(logger.digest(1)).toEqual(k12Bytes(concatBytes([ZERO32, ...expectedMessages])));
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
    expect(sim.host.transferShares(28, name, issuer, issuer, issuer, 300n, holder)).toBe(700n);
    expect(sim.transferShareManagementRights(name, issuer, holder, holder, 28, 29, 100n)).toBe(true);

    expect(sim.host.issueAsset(28, name, issuer, 2, 1000n, unit, issuer)).toBe(0n);
    expect(sim.host.transferShares(28, name, issuer, issuer, issuer, 0n, holder)).toBeLessThan(0n);
    expect(sim.host.transferShares(28, name, issuer, holder, holder, 10n, holder)).toBe(200n);
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
