// A diagnostic log event the engine emits at lifecycle / error points — tick + epoch boundaries, deploys,
// applied txs, contract faults, dormant skips, oversized-state digest skips, mempool drops. This is a separate,
// always-available stream from the debug-gated TraceRecorder (which carries the heavy per-invoke detail behind
// the Debugger). A host sets Sim.onLog / VirtualNode.onLog to subscribe; unset = no-op, so the seam costs
// nothing when nobody is listening.
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface EngineLogEvent {
  level: LogLevel;
  tick: number;   // the chain tick the event happened on
  cat: string;    // category — e.g. "tick" | "epoch" | "deploy" | "tx" | "fee" | "digest" | "mempool"
  msg: string;
}

export type LogSink = (e: EngineLogEvent) => void;
