import { supabase } from "./supabase";

/**
 * Writes an audit event to Fabric (AppendSessionEvent) AND stores (txId + eventKey) into Postgres session_ledger_events.
 *
 * Chaincode signature:
 *   AppendSessionEvent(sessionId, evId, eventType, source, payloadStr) -> returns eventKey (string)
 *
 * We keep:
 * - best-effort Fabric write (don't break API if Fabric fails)
 * - insert txId into DB if present
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

  // Try to infer evId (your routes include it in payload)
  const evId: string = payload?.evId ?? "EV_UNKNOWN";

  let txId: string | null = null;
  let eventKey: string | null = null;

  // 1) Write to Fabric (best-effort; don't break API if Fabric fails)
  try {
    if (contract) {
      const tx = contract.createTransaction("AppendSessionEvent");

      // best-effort tx id extraction (depends on gateway version)
      const raw =
        typeof tx.getTransactionId === "function" ? tx.getTransactionId() : null;

      txId =
        raw?.getTransactionID?.() ||
        raw?.transactionId ||
        (typeof raw === "string" ? raw : null) ||
        null;

      // Ensure payload is a string
      const payloadStr =
        typeof payload === "string"
          ? payload
          : JSON.stringify({
              sessionId,
              evId,
              eventType,
              ...payload,
            });

      // NEW: chaincode returns the ledger key
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

  // 2) Store txId in DB if we have it (and store eventKey too if available)
  if (txId) {
    const { error } = await supabase.from("session_ledger_events").insert({
      session_id: sessionId,
      event_type: eventType,
      tx_id: txId,
      payload: { ...payload, eventKey }, // keep for debugging
    });

    if (error) {
      console.error("Failed to insert session_ledger_events:", error.message);
    }
  }

  return { txId, eventKey };
}
