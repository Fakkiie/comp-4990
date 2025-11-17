import { Context, Contract } from "fabric-contract-api";

interface SessionRecord {
  sessionId: string;
  source: string;
  payload: string;
  timestamp: string;
}

export class EvContract extends Contract {
  async WriteSession(
    ctx: Context,
    sessionId: string,
    source: string,
    payload: string
  ): Promise<void> {
    console.log("==== WriteSession CALLED ====");
    console.log("sessionId:", sessionId);
    console.log("source:", source);
    console.log("payload:", payload);

    const existing = await ctx.stub.getState(sessionId);
    console.log("existing length:", existing ? existing.length : 0);

    if (existing && existing.length > 0) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const txTime = ctx.stub.getTxTimestamp();
    const millis =
      txTime.seconds.low * 1000 + Math.floor(txTime.nanos / 1_000_000);
    const timestamp = new Date(millis).toISOString();

    const record: SessionRecord = {
      sessionId,
      source,
      payload,
      timestamp,
    };

    await ctx.stub.putState(
      sessionId,
      Buffer.from(JSON.stringify(record), "utf8")
    );

    console.log("==== WriteSession DONE putState ====");
  }

  async ReadSession(ctx: Context, sessionId: string): Promise<string> {
    console.log("==== ReadSession CALLED ====");
    console.log("sessionId:", sessionId);

    const data = await ctx.stub.getState(sessionId);
    console.log("getState length:", data ? data.length : 0);

    if (!data || data.length === 0) {
      throw new Error(`Session ${sessionId} does not exist`);
    }

    return data.toString();
  }
}

export const contracts = [EvContract];
