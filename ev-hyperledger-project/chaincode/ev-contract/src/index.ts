import { Context, Contract } from "fabric-contract-api";

export interface SessionEventRecord {
  docType: "session_event";
  key: string;
  txId: string;
  sessionId: string;
  evId: string;
  eventType: string;
  source: string;
  payload: string;
  timestamp: string;
}

export class EvContract extends Contract {
  constructor() {
    super("ev-contract");
  }

  private txTimestampISO(ctx: Context): string {
    const txTime = ctx.stub.getTxTimestamp();
    const millis =
      txTime.seconds.low * 1000 + Math.floor(txTime.nanos / 1_000_000);
    return new Date(millis).toISOString();
  }

  async AppendSessionEvent(
    ctx: Context,
    sessionId: string,
    evId: string,
    eventType: string,
    source: string,
    payload: string
  ): Promise<string> {
    if (!sessionId) throw new Error("sessionId is required");
    if (!evId) throw new Error("evId is required");
    if (!eventType) throw new Error("eventType is required");

    const txId = ctx.stub.getTxID();
    const timestamp = this.txTimestampISO(ctx);

    const key = `sess~${sessionId}~${eventType}~${txId}`;

    const record: SessionEventRecord = {
      docType: "session_event",
      key,
      txId,
      sessionId,
      evId,
      eventType,
      source: source || "unknown",
      payload: payload ?? "",
      timestamp,
    };

    await ctx.stub.putState(key, Buffer.from(JSON.stringify(record), "utf8"));
    ctx.stub.setEvent(
      "session_event",
      Buffer.from(JSON.stringify(record), "utf8")
    );

    return key;
  }

  async ReadEvent(ctx: Context, key: string): Promise<string> {
    const data = await ctx.stub.getState(key);
    if (!data || data.length === 0) throw new Error(`Key ${key} does not exist`);
    return data.toString();
  }

  /** ✅ Works with TS + LevelDB */
  async GetSessionHistory(ctx: Context, sessionId: string): Promise<string> {
    const prefix = `sess~${sessionId}~`;
    const iterator = await ctx.stub.getStateByRange(prefix, prefix + "\uffff");

    const out: SessionEventRecord[] = [];
    try {
      while (true) {
        const res = await iterator.next();

        if (res.value && res.value.value) {
          const raw = res.value.value.toString();
          try {
            out.push(JSON.parse(raw));
          } catch {
            // ignore malformed
          }
        }

        if (res.done) break;
      }
    } finally {
      // IMPORTANT: close iterator or you leak resources
      await iterator.close();
    }

    out.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
    return JSON.stringify(out);
  }

  /** ✅ Only call if CouchDB state database is enabled */
  async QueryEvents(ctx: Context, queryString: string): Promise<string> {
    const iterator = await ctx.stub.getQueryResult(queryString);

    const out: any[] = [];
    try {
      while (true) {
        const res = await iterator.next();

        if (res.value && res.value.value) {
          const raw = res.value.value.toString();
          try {
            out.push(JSON.parse(raw));
          } catch {
            out.push({ key: res.value.key, value: raw });
          }
        }

        if (res.done) break;
      }
    } finally {
      await iterator.close();
    }

    return JSON.stringify(out);
  }
}

export const contracts = [EvContract];
