import { supabase } from "./supabase";
//writes an audit event to both Fabric and Supabase
export async function logLedgerEvent(opts: {
  contract: any | null;
  sessionId: string;
  eventType: string; 
  payload: any;      
  source?: string;   
}) {
  const { contract, sessionId, eventType, payload } = opts;
  const source = opts.source ?? "SECC";

  //extract evid from payload if available
  const evId: string = payload?.evId ?? "EV_UNKNOWN";

  let txId: string | null = null;
  let eventKey: string | null = null;

  //write to Fabric
  try {
    if (contract) {
      const tx = contract.createTransaction("AppendSessionEvent");

      //xxtract txId
      const raw =
        typeof tx.getTransactionId === "function" ? tx.getTransactionId() : null;

      txId =
        raw?.getTransactionID?.() ||
        raw?.transactionId ||
        (typeof raw === "string" ? raw : null) ||
        null;

      //ensure payload is string
      const payloadStr =
        typeof payload === "string"
          ? payload
          : JSON.stringify({
              sessionId,
              evId,
              eventType,
              ...payload,
            });

      //return ledger key
      const resp: Buffer = await tx.submit(
        sessionId,
        evId,
        eventType,
        source,
        payloadStr
      );

      eventKey = resp?.toString("utf8") || null;
    }
  } catch (e: any) {
    console.error("Fabric AppendSessionEvent failed:", e?.message ?? e);
    txId = null;
    eventKey = null;
  }

  //store txId and eventKey in Supabase for auditing
  if (txId) {
    const { error } = await supabase.from("session_ledger_events").insert({
      session_id: sessionId,
      event_type: eventType,
      tx_id: txId,
      payload: { ...payload, eventKey }, 
    });

    if (error) {
      console.error("Failed to insert session_ledger_events:", error.message);
    }
  }

  return { txId, eventKey };
}
