import { AbiTypeKind, type AbiType } from "../contract-idl";
import { QpiArrayView } from "./array-view";
import { QpiBitArrayView } from "./bit-array-view";
import { QpiCollectionView } from "./collection-view";
import { QpiHashMapView } from "./hash-map-view";
import { QpiHashSetView } from "./hash-set-view";
import { QpiLinkedListView } from "./linked-list-view";
import type { QpiByteSource } from "./source";

type AbiContainerType = Extract<
    AbiType,
    {
        kind: AbiTypeKind.ARRAY | AbiTypeKind.BIT_ARRAY | AbiTypeKind.HASH_MAP | AbiTypeKind.HASH_SET | AbiTypeKind.COLLECTION | AbiTypeKind.LINKED_LIST;
    }
>;

export type QpiContainerView = QpiArrayView | QpiBitArrayView | QpiCollectionView | QpiHashMapView | QpiHashSetView | QpiLinkedListView;

export function createQpiContainerView(type: AbiContainerType, source: QpiByteSource): QpiContainerView {
    switch (type.kind) {
        case AbiTypeKind.ARRAY:
            return new QpiArrayView(type, source);
        case AbiTypeKind.BIT_ARRAY:
            return new QpiBitArrayView(type, source);
        case AbiTypeKind.COLLECTION:
            return new QpiCollectionView(type, source);
        case AbiTypeKind.HASH_MAP:
            return new QpiHashMapView(type, source);
        case AbiTypeKind.HASH_SET:
            return new QpiHashSetView(type, source);
        case AbiTypeKind.LINKED_LIST:
            return new QpiLinkedListView(type, source);
        default:
            throw new Error(`Unsupported QPI container kind '${(type as { kind: string }).kind}'`);
    }
}

export { QpiArrayView } from "./array-view";
export type { QpiArrayEntry } from "./array-view";
export { QpiBitArrayView } from "./bit-array-view";
export type { QpiBitArrayEntry } from "./bit-array-view";
export { QpiCollectionView } from "./collection-view";
export type { QpiCollectionEntry } from "./collection-view";
export { QpiContainerConsistencyError, QpiIncompleteReadError } from "./errors";
export { QpiHashMapView } from "./hash-map-view";
export type { QpiHashMapEntry } from "./hash-map-view";
export { QpiHashSetView } from "./hash-set-view";
export type { QpiHashSetEntry } from "./hash-set-view";
export { QpiLinkedListView } from "./linked-list-view";
export type { QpiLinkedListEntry } from "./linked-list-view";
export { qpiSnapshotSource } from "./source";
export type { QpiByteSource } from "./source";
