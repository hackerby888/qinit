// Oracle queries + subscriptions — the TS model of core-lite oracle_core/oracle_engine.h (query metadata +
// recurring subscriptions + contract notification are interface-agnostic: query/reply are opaque bytes.

// network_messages/common_def.h ORACLE_QUERY_STATUS_* — the contract-observable lifecycle of an oracle query.
export const ORACLE_STATUS = { UNKNOWN: 0, PENDING: 1, COMMITTED: 2, SUCCESS: 3, TIMEOUT: 4, UNRESOLVABLE: 5 };
const ORACLE_NOTIFY_HEADER = 16; // OracleNotificationInput: queryId(8) subscriptionId(4) status(1) pad(3), then reply

interface OracleQueryRec {
  id: bigint;
  slot: number;
  interfaceIndex: number;
  query: Uint8Array;
  status: number;
  reply: Uint8Array | null;
  notificationProcId: number;
  subscriptionId: number; // -1 for a one-time query
}

interface OracleSubRec {
  id: number;
  slot: number;
  interfaceIndex: number;
  query: Uint8Array;
  periodMs: number;
  notificationProcId: number;
  notifyPrev: boolean;
  lastReply: Uint8Array | null;
  fee: bigint;
  nextDueMs: number;
}

// The seams the OracleManager needs from the rest of the engine: the query fee touches the spectrum (balance of
// / debit the querying contract), the notification runs the contract's notification procedure, and the
export interface OracleHost {
  contractBalance(slot: number): bigint;
  debitContract(slot: number, amount: bigint): void;
  notify(slot: number, procId: number, input: Uint8Array): void;
  nowMs(): number;
}

export class OracleManager {
  private readonly host: OracleHost;
  private queries = new Map<bigint, OracleQueryRec>(); // queryId -> query state (opaque query/reply bytes)
  private subs = new Map<number, OracleSubRec>(); // subscriptionId -> recurring subscription
  private nextQueryId = 1n;
  private nextSubId = 0;
  private provider: ((interfaceIndex: number, query: Uint8Array) => Uint8Array | null) | null = null;

  constructor(host: OracleHost) {
    this.host = host;
  }

  // Start a one-time query (__qpiQueryOracle): burn the fee, record it PENDING, return the queryId. A provider
  // (if set) resolves it on the next pump(); otherwise resolve() supplies the reply.
  query(slot: number, interfaceIndex: number, query: Uint8Array, notificationProcId: number, _timeoutMillisec: number, fee: bigint, subscriptionId: number): bigint {
    if (!this.chargeFee(slot, fee)) {
      return -1n;
    }

    const id = this.nextQueryId++;
    this.queries.set(id, { id, slot, interfaceIndex, query: query.slice(), status: ORACLE_STATUS.PENDING, reply: null, notificationProcId, subscriptionId });
    return id;
  }

  // Start a recurring subscription (__qpiSubscribeOracle): emit the first query now, then re-emit each periodMs.
  subscribe(slot: number, interfaceIndex: number, query: Uint8Array, notificationProcId: number, periodMillisec: number, notifyPrev: boolean, fee: bigint): number {
    const id = this.nextSubId++;
    const sub: OracleSubRec = { id, slot, interfaceIndex, query: query.slice(), periodMs: periodMillisec, notificationProcId, notifyPrev, lastReply: null, fee, nextDueMs: this.host.nowMs() + periodMillisec };
    this.subs.set(id, sub);
    this.emitSubscriptionQuery(sub);
    return id;
  }

  unsubscribe(subscriptionId: number): number {
    return this.subs.delete(subscriptionId) ? 1 : 0;
  }

  // The query fee is destroyed (decreaseEnergy, not added to any reserve), like the node. False if unaffordable.
  private chargeFee(slot: number, fee: bigint): boolean {
    if (fee < 0n) {
      return false;
    }

    if (this.host.contractBalance(slot) < fee) {
      return false;
    }
    if (fee > 0n) {
      this.host.debitContract(slot, fee);
    }
    return true;
  }

  private emitSubscriptionQuery(sub: OracleSubRec): bigint {
    const id = this.query(sub.slot, sub.interfaceIndex, sub.query, sub.notificationProcId, 0, sub.fee, sub.id);
    if (id >= 0n && sub.notifyPrev && sub.lastReply) {
      this.fireNotification(this.queries.get(id)!, sub.lastReply, ORACLE_STATUS.SUCCESS);
    }
    return id;
  }

  // Public resolve seam: the dev/test (or a node-mode oracle-machine adapter) supplies a query's reply, which
  // sets it SUCCESS and fires the contract's notification procedure. False for an unknown queryId.
  resolve(queryId: bigint, reply: Uint8Array, status: number = ORACLE_STATUS.SUCCESS): boolean {
    const q = this.queries.get(queryId);
    if (!q) {
      return false;
    }

    q.status = status;
    q.reply = reply.slice();
    const sub = q.subscriptionId >= 0 ? this.subs.get(q.subscriptionId) : undefined;
    if (sub) {
      sub.lastReply = q.reply;
    }

    this.fireNotification(q, q.reply, status);
    return true;
  }

  // Register a reply provider (interfaceIndex, query) -> reply | null. Pending queries auto-resolve through it on
  // pump(). This is the mock/browser path; a real oracle-machine fetch plugs in behind this same seam.
  setProvider(fn: ((interfaceIndex: number, query: Uint8Array) => Uint8Array | null) | null): void {
    this.provider = fn;
  }

  // Build OracleNotificationInput { queryId(8) subscriptionId(4) status(1) pad(3) reply } and run the contract's
  // notification procedure (fired by its registered notification id; no reward, no PIT).
  private fireNotification(q: OracleQueryRec, reply: Uint8Array, status: number): void {
    const buf = new Uint8Array(ORACLE_NOTIFY_HEADER + reply.length);
    const dv = new DataView(buf.buffer);
    dv.setBigInt64(0, q.id, true);
    dv.setInt32(8, q.subscriptionId, true);
    buf[12] = status & 0xff;
    buf.set(reply, ORACLE_NOTIFY_HEADER);

    this.host.notify(q.slot, q.notificationProcId, buf);
  }

  // Auto-resolve PENDING queries via the provider, then re-emit any due subscriptions. Called each advance().
  pump(): void {
    if (this.provider) {
      const pending = [...this.queries.values()].filter((q) => q.status === ORACLE_STATUS.PENDING);
      for (const q of pending) {
        const reply = this.provider(q.interfaceIndex, q.query);
        if (reply) {
          this.resolve(q.id, reply);
        }
      }
    }

    const now = this.host.nowMs();
    for (const sub of [...this.subs.values()]) {
      if (this.subs.has(sub.id) && now >= sub.nextDueMs) {
        this.emitSubscriptionQuery(sub);
        sub.nextDueMs += sub.periodMs;
      }
    }
  }

  queryStatus(queryId: bigint): number {
    return this.queries.get(queryId)?.status ?? ORACLE_STATUS.UNKNOWN;
  }

  getQuery(queryId: bigint): Uint8Array | null {
    return this.queries.get(queryId)?.query ?? null;
  }

  getReply(queryId: bigint): Uint8Array | null {
    const q = this.queries.get(queryId);
    return q && q.status === ORACLE_STATUS.SUCCESS ? q.reply : null;
  }

  // PENDING queries awaiting a reply — the discovery side of the dev/test resolve seam (a tx-driven query's id
  // isn't returned to the broadcaster, so a test finds it here, then resolves it).
  pending(): { queryId: bigint; slot: number; interfaceIndex: number; query: Uint8Array }[] {
    const out: { queryId: bigint; slot: number; interfaceIndex: number; query: Uint8Array }[] = [];
    for (const q of this.queries.values()) {
      if (q.status === ORACLE_STATUS.PENDING) out.push({ queryId: q.id, slot: q.slot, interfaceIndex: q.interfaceIndex, query: q.query });
    }
    return out;
  }
}
