import * as DogeShareValidation from "./doge-share-validation";
import * as EvmLogRead from "./evm-log-read";
import * as Mock from "./mock";
import * as Price from "./price";
import * as QubicLogRead from "./qubic-log-read";

interface OracleLayout {
    readonly SIZE: number;
    readonly OFFSETS: Readonly<Record<string, number>>;
}

export interface OracleInterfaceDefinition {
    readonly index: number;
    readonly name: string;
    readonly query: OracleLayout;
    readonly reply: OracleLayout;
    readonly replyFormat: string;
    getQueryFee(query: Uint8Array): bigint;
}

export const ORACLE_INTERFACES = [
    {
        index: Price.ORACLE_INTERFACE_INDEX,
        name: "Price",
        query: Price.OracleQuery,
        reply: Price.OracleReply,
        replyFormat: Price.REPLY_FORMAT,
        getQueryFee(query: Uint8Array): bigint {
            return Price.getQueryFee(Price.OracleQuery.wrap(query));
        },
    },
    {
        index: Mock.ORACLE_INTERFACE_INDEX,
        name: "Mock",
        query: Mock.OracleQuery,
        reply: Mock.OracleReply,
        replyFormat: Mock.REPLY_FORMAT,
        getQueryFee(query: Uint8Array): bigint {
            return Mock.getQueryFee(Mock.OracleQuery.wrap(query));
        },
    },
    {
        index: DogeShareValidation.ORACLE_INTERFACE_INDEX,
        name: "DogeShareValidation",
        query: DogeShareValidation.OracleQuery,
        reply: DogeShareValidation.OracleReply,
        replyFormat: DogeShareValidation.REPLY_FORMAT,
        getQueryFee(query: Uint8Array): bigint {
            return DogeShareValidation.getQueryFee(DogeShareValidation.OracleQuery.wrap(query));
        },
    },
    {
        index: EvmLogRead.ORACLE_INTERFACE_INDEX,
        name: "EvmLogRead",
        query: EvmLogRead.OracleQuery,
        reply: EvmLogRead.OracleReply,
        replyFormat: EvmLogRead.REPLY_FORMAT,
        getQueryFee(query: Uint8Array): bigint {
            return EvmLogRead.getQueryFee(EvmLogRead.OracleQuery.wrap(query));
        },
    },
    {
        index: QubicLogRead.ORACLE_INTERFACE_INDEX,
        name: "QubicLogRead",
        query: QubicLogRead.OracleQuery,
        reply: QubicLogRead.OracleReply,
        replyFormat: QubicLogRead.REPLY_FORMAT,
        getQueryFee(query: Uint8Array): bigint {
            return QubicLogRead.getQueryFee(QubicLogRead.OracleQuery.wrap(query));
        },
    },
] as const satisfies readonly OracleInterfaceDefinition[];
