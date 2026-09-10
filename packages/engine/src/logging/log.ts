// A diagnostic log event the engine emits at lifecycle and error points — tick/epoch boundaries, deploys, applied txs, faults, drops. A separate stream.
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface EngineLogEvent {
    level: LogLevel;
    tick: number;
    cat: string; // category — e.g. "tick" | "epoch" | "deploy" | "tx" | "fee" | "digest" | "mempool"
    msg: string;
}

export type LogSink = (e: EngineLogEvent) => void;
