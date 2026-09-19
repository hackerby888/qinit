import { blob, defineStruct, i32, i64, u8, u32, u56, u64 } from "@qinit/core";

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

// Logged whole, padding included: core takes this record by sizeof, not up to a terminator.
export const ContractReserveDeduction = defineStruct("ContractReserveDeduction", {
    deductedAmount: u64,
    remainingAmount: i64,
    contractIndex: u32,
    _padding: u32,
});

export const OracleQueryStatusChange = defineStruct("OracleQueryStatusChange", {
    queryingEntity: M256I,
    queryId: i64,
    interfaceIndex: u32,
    type: u8,
    status: u8,
    _terminator: u8,
});

export const OracleSubscriberLogMessage = defineStruct("OracleSubscriberLogMessage", {
    subscriptionId: i32,
    interfaceIndex: u32,
    contractIndex: u32,
    periodInMilliseconds: u32,
    firstQueryDateAndTime: u64,
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

// core's DummyCustomMessage: the marker alone, everything before its terminator.
export function encodeCustomMessageLog(marker: bigint): Uint8Array {
    const message = new Uint8Array(8);
    new DataView(message.buffer).setBigUint64(0, marker, true);
    return message;
}

export function encodeBurningLog(sourcePublicKey: Uint8Array, amount: bigint, contractIndexBurnedFor: number): Uint8Array {
    const message = Burning.alloc();
    message.sourcePublicKey = sourcePublicKey;
    message.amount = amount;
    message.contractIndexBurnedFor = contractIndexBurnedFor;
    return message.bytes.subarray(0, Burning.OFFSETS._terminator);
}

export function encodeContractReserveDeductionLog(deductedAmount: bigint, remainingAmount: bigint, contractIndex: number): Uint8Array {
    const message = ContractReserveDeduction.alloc();
    message.deductedAmount = deductedAmount;
    message.remainingAmount = remainingAmount;
    message.contractIndex = contractIndex;
    return message.bytes;
}

// queryingEntity is the contract index, the subscription id or a user's key, by query type, in the low lane of an otherwise zero id.
export function encodeOracleQueryStatusChangeLog(
    queryingEntity: Uint8Array,
    queryId: bigint,
    interfaceIndex: number,
    type: number,
    status: number,
): Uint8Array {
    const message = OracleQueryStatusChange.alloc();
    message.queryingEntity = queryingEntity;
    message.queryId = queryId;
    message.interfaceIndex = interfaceIndex;
    message.type = type;
    message.status = status;
    return message.bytes.subarray(0, OracleQueryStatusChange.OFFSETS._terminator);
}

// A period of zero is an unsubscribe.
export function encodeOracleSubscriberLog(
    subscriptionId: number,
    interfaceIndex: number,
    contractIndex: number,
    periodInMilliseconds: number,
    firstQueryDateAndTime: bigint,
): Uint8Array {
    const message = OracleSubscriberLogMessage.alloc();
    message.subscriptionId = subscriptionId;
    message.interfaceIndex = interfaceIndex;
    message.contractIndex = contractIndex;
    message.periodInMilliseconds = periodInMilliseconds;
    message.firstQueryDateAndTime = firstQueryDateAndTime;
    return message.bytes.subarray(0, OracleSubscriberLogMessage.OFFSETS._terminator);
}
