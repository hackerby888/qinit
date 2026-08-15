import { blob, defineStruct, i64, u8, u32, u56 } from "@qinit/core";

const M256I = {
    ...blob(32),
    align: 8,
};

export const QuTransfer = defineStruct("QuTransfer", {
    sourcePublicKey: M256I,
    destinationPublicKey: M256I,
    amount: i64,
    _terminator: u8,
});

export const AssetIssuance = defineStruct("AssetIssuance", {
    issuerPublicKey: M256I,
    numberOfShares: i64,
    managingContractIndex: i64,
    name: u56,
    numberOfDecimalPlaces: u8,
    unitOfMeasurement: u56,
    _terminator: u8,
});

const ASSET_CHANGE_FIELDS = {
    sourcePublicKey: M256I,
    destinationPublicKey: M256I,
    issuerPublicKey: M256I,
    numberOfShares: i64,
    managingContractIndex: i64,
    name: u56,
    numberOfDecimalPlaces: u8,
    unitOfMeasurement: u56,
    _terminator: u8,
};

export const AssetOwnershipChange = defineStruct("AssetOwnershipChange", ASSET_CHANGE_FIELDS);

export const AssetPossessionChange = defineStruct("AssetPossessionChange", ASSET_CHANGE_FIELDS);

export const AssetOwnershipManagingContractChange = defineStruct("AssetOwnershipManagingContractChange", {
    ownershipPublicKey: M256I,
    issuerPublicKey: M256I,
    sourceContractIndex: u32,
    destinationContractIndex: u32,
    numberOfShares: i64,
    assetName: u56,
    _terminator: u8,
});

export const AssetPossessionManagingContractChange = defineStruct("AssetPossessionManagingContractChange", {
    possessionPublicKey: M256I,
    ownershipPublicKey: M256I,
    issuerPublicKey: M256I,
    sourceContractIndex: u32,
    destinationContractIndex: u32,
    numberOfShares: i64,
    assetName: u56,
    _terminator: u8,
});

export const Burning = defineStruct("Burning", {
    sourcePublicKey: M256I,
    amount: i64,
    contractIndexBurnedFor: u32,
    _terminator: u8,
});

export function encodeQuTransferLog(sourcePublicKey: Uint8Array, destinationPublicKey: Uint8Array, amount: bigint): Uint8Array {
    const message = QuTransfer.alloc();
    message.sourcePublicKey = sourcePublicKey;
    message.destinationPublicKey = destinationPublicKey;
    message.amount = amount;
    return message.bytes.subarray(0, QuTransfer.OFFSETS._terminator);
}

export function encodeAssetIssuanceLog(
    issuerPublicKey: Uint8Array,
    numberOfShares: bigint,
    managingContractIndex: number,
    name: bigint,
    numberOfDecimalPlaces: number,
    unitOfMeasurement: bigint,
): Uint8Array {
    const message = AssetIssuance.alloc();
    message.issuerPublicKey = issuerPublicKey;
    message.numberOfShares = numberOfShares;
    message.managingContractIndex = BigInt(managingContractIndex);
    message.name = name;
    message.numberOfDecimalPlaces = numberOfDecimalPlaces;
    message.unitOfMeasurement = unitOfMeasurement;
    return message.bytes.subarray(0, AssetIssuance.OFFSETS._terminator);
}

export function encodeAssetOwnershipChangeLog(
    sourcePublicKey: Uint8Array,
    destinationPublicKey: Uint8Array,
    issuerPublicKey: Uint8Array,
    numberOfShares: bigint,
    managingContractIndex: number,
    name: bigint,
    numberOfDecimalPlaces: number,
    unitOfMeasurement: bigint,
): Uint8Array {
    const message = AssetOwnershipChange.alloc();
    message.sourcePublicKey = sourcePublicKey;
    message.destinationPublicKey = destinationPublicKey;
    message.issuerPublicKey = issuerPublicKey;
    message.numberOfShares = numberOfShares;
    message.managingContractIndex = BigInt(managingContractIndex);
    message.name = name;
    message.numberOfDecimalPlaces = numberOfDecimalPlaces;
    message.unitOfMeasurement = unitOfMeasurement;
    return message.bytes.subarray(0, AssetOwnershipChange.OFFSETS._terminator);
}

// Core uses the same payload layout for ownership and possession changes.
export const encodeAssetPossessionChangeLog = encodeAssetOwnershipChangeLog;

export function encodeAssetOwnershipManagingContractChangeLog(
    ownershipPublicKey: Uint8Array,
    issuerPublicKey: Uint8Array,
    sourceContractIndex: number,
    destinationContractIndex: number,
    numberOfShares: bigint,
    assetName: bigint,
): Uint8Array {
    const message = AssetOwnershipManagingContractChange.alloc();
    message.ownershipPublicKey = ownershipPublicKey;
    message.issuerPublicKey = issuerPublicKey;
    message.sourceContractIndex = sourceContractIndex;
    message.destinationContractIndex = destinationContractIndex;
    message.numberOfShares = numberOfShares;
    message.assetName = assetName;
    return message.bytes.subarray(0, AssetOwnershipManagingContractChange.OFFSETS._terminator);
}

export function encodeAssetPossessionManagingContractChangeLog(
    possessionPublicKey: Uint8Array,
    ownershipPublicKey: Uint8Array,
    issuerPublicKey: Uint8Array,
    sourceContractIndex: number,
    destinationContractIndex: number,
    numberOfShares: bigint,
    assetName: bigint,
): Uint8Array {
    const message = AssetPossessionManagingContractChange.alloc();
    message.possessionPublicKey = possessionPublicKey;
    message.ownershipPublicKey = ownershipPublicKey;
    message.issuerPublicKey = issuerPublicKey;
    message.sourceContractIndex = sourceContractIndex;
    message.destinationContractIndex = destinationContractIndex;
    message.numberOfShares = numberOfShares;
    message.assetName = assetName;
    return message.bytes.subarray(0, AssetPossessionManagingContractChange.OFFSETS._terminator);
}

export function encodeBurningLog(sourcePublicKey: Uint8Array, amount: bigint, contractIndexBurnedFor: number): Uint8Array {
    const message = Burning.alloc();
    message.sourcePublicKey = sourcePublicKey;
    message.amount = amount;
    message.contractIndexBurnedFor = contractIndexBurnedFor;
    return message.bytes.subarray(0, Burning.OFFSETS._terminator);
}
