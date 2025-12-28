import { supabase } from "./supabase";

/**
 * Writes an audit event to Fabric AND stores (txId + eventKey) into Postgres session_ledger_events.
 *
 * IMPORTANT:
 * Your chaincode WriteSession(ctx, sessionId, ...) throws if the key already exists.
 * So we must use a UNIQUE key per event when calling WriteSession.
 *
 * We do:
 *   fabricKey = `${sessionId}:${eventType}:${Date.now()}`
 *
 * And include the "real" sessionId inside the payload JSON.
 */
export async function logLedgerEvent(opts: {
  contract: any | null;
  sessionId: string;
  eventType: string; // SessionStarted/SessionStopped/SessionResumed/SessionExpired
  payload: any;      // jsonb
  source?: string;   // default "SECC"
}) {
  const { contract, sessionId, eventType, payload } = opts;
  const source = opts.source ?? "SECC";

  const eventKey = `${sessionId}:${eventType}:${Date.now()}`;
  let txId: string | null = null;

  // 1) Write to Fabric (best-effort; don't break API if Fabric fails)
  try {
    if (contract) {
      const tx = contract.createTransaction("WriteSession");

      const raw =
        typeof tx.getTransactionId === "function" ? tx.getTransactionId() : null;

      txId =
        raw?.getTransactionID?.() ||
        raw?.transactionId ||
        raw ||
        null;

      await tx.submit(
        eventKey, // <-- unique world-state key
        source,
        JSON.stringify({
          sessionId,   // <-- real session id preserved
          eventType,
          eventKey,
          ...payload,
        })
      );
    }
  } catch (e: any) {
    console.error("Fabric WriteSession failed:", e?.message ?? e);
    txId = null;
  }

  // 2) Store txId in DB if we have it
  if (txId) {
    const { error } = await supabase.from("session_ledger_events").insert({
      session_id: sessionId,
      event_type: eventType,
      tx_id: txId,
      payload: { ...payload, eventKey }, // helpful for debugging
    });

    if (error) {
      console.error("Failed to insert session_ledger_events:", error.message);
    }
  }

  return { txId, eventKey };
}
