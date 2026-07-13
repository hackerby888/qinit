// A diagnostic log event the engine emits at lifecycle / error points — tick + epoch boundaries, deploys,
// applied txs, contract faults, dormant skips, oversized digest skips, mempool drops. This is a separate stream.
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface EngineLogEvent {
  level: LogLevel;
  tick: number; // the chain tick the event happened on
  cat: string; // category — e.g. "tick" | "epoch" | "deploy" | "tx" | "fee" | "digest" | "mempool"
  msg: string;
}

export type LogSink = (e: EngineLogEvent) => void;
