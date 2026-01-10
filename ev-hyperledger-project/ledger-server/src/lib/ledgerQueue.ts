import { supabase } from "./supabase";
//this helps us ensrue no fabric writes are lost
type ContractRef = { get: () => any | null };
type Broadcaster = (data: any) => void;

const CONFIG = {
  POLL_INTERVAL_MS: 2000, //check for pending events every 2 seconds
  MAX_ATTEMPTS: 5, //retry up to 5 times
  RETRY_DELAY_MS: 5000, //wait 5 seconds between retries
  BATCH_SIZE: 10, //process up to 10 events at a time
};

let contractRef: ContractRef | null = null;
let broadcaster: Broadcaster | null = null;
let isProcessing = false;
let pollInterval: NodeJS.Timeout | null = null;

//stats to see
export const queueStats = {
  queued: 0,
  confirmed: 0,
  failed: 0,
  retried: 0,
};

//init queue processor
export function initLedgerQueue(
  contract: ContractRef,
  broadcast?: Broadcaster
) {
  contractRef = contract;
  broadcaster = broadcast || null;

  //start background processing
  if (!pollInterval) {
    pollInterval = setInterval(processQueue, CONFIG.POLL_INTERVAL_MS);
    console.log("[LEDGER QUEUE] Started background processor");
  }
}

//stop queue processor
export function stopLedgerQueue() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log("[LEDGER QUEUE] Stopped background processor");
  }
}

//add an event to the ledger queue
export async function queueLedgerEvent(
  sessionId: string,
  evId: string,
  eventType: string,
  payload: any
): Promise<{ queued: boolean; queueId: string | null }> {
  try {
    const { data, error } = await supabase
      .from("ledger_queue")
      .insert({
        session_id: sessionId,
        ev_id: evId,
        event_type: eventType,
        payload: {
          ...payload,
          sessionId,
          evId,
          eventType,
        },
        status: "pending",
        attempts: 0,
        next_retry_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (error) {
      console.error("[LEDGER QUEUE] Failed to queue event:", error.message);
      return { queued: false, queueId: null };
    }

    queueStats.queued++;
    console.log(`[LEDGER QUEUE] Queued ${eventType} for session ${sessionId}`);

    //try to process immediately
    setImmediate(processQueue);

    return { queued: true, queueId: data.id };
  } catch (err: any) {
    console.error("[LEDGER QUEUE] Error queueing event:", err.message);
    return { queued: false, queueId: null };
  }
}

//background processor
async function processQueue() {
  //prevent concurrent processing
  if (isProcessing) return;
  isProcessing = true;

  try {
    const contract = contractRef?.get();
    if (!contract) {
      //if fabric isnt ready skip
      return;
    }

    //fetch pending events ready for processing
    const { data: events, error } = await supabase
      .from("ledger_queue")
      .select("*")
      .in("status", ["pending", "failed"])
      .lte("next_retry_at", new Date().toISOString())
      .lt("attempts", CONFIG.MAX_ATTEMPTS)
      .order("created_at", { ascending: true })
      .limit(CONFIG.BATCH_SIZE);

    if (error) {
      console.error("[LEDGER QUEUE] Failed to fetch events:", error.message);
      return;
    }

    if (!events || events.length === 0) {
      return; //nothing to process
    }

    console.log(`[LEDGER QUEUE] Processing ${events.length} events...`);

    //process each event
    for (const event of events) {
      await processEvent(contract, event);
    }
  } catch (err: any) {
    console.error("[LEDGER QUEUE] Processor error:", err.message);
  } finally {
    isProcessing = false;
  }
}

//process a single event
async function processEvent(contract: any, event: any) {
  const { id, session_id, ev_id, event_type, payload, attempts } = event;

  //mark as processing
  await supabase
    .from("ledger_queue")
    .update({ status: "processing", attempts: attempts + 1 })
    .eq("id", id);

  try {
    //write to fabric
    const tx = contract.createTransaction("AppendSessionEvent");

    //extract txId
    let txId: string | null = null;
    try {
      const raw = tx.getTransactionId?.();
      txId =
        raw?.getTransactionID?.() ||
        raw?.transactionId ||
        (typeof raw === "string" ? raw : null);
    } catch {}

    const payloadStr = JSON.stringify(payload);

    //submit to blockchain
    const resp: Buffer = await tx.submit(
      session_id,
      ev_id,
      event_type,
      "SECC",
      payloadStr
    );

    const eventKey = resp?.toString("utf8") || null;

    //mark as confirmed
    await supabase
      .from("ledger_queue")
      .update({
        status: "confirmed",
        tx_id: txId,
        event_key: eventKey,
        confirmed_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", id);

    queueStats.confirmed++;
    console.log(
      `[LEDGER QUEUE] ✓ Confirmed ${event_type} for ${session_id} (txId: ${txId})`
    );

    //broadcast confirmation
    if (broadcaster && txId) {
      broadcaster({
        eventName: `${event_type}Confirmed`,
        txId,
        payload: {
          timestamp: new Date().toISOString(),
          txId,
          payload: JSON.stringify({
            eventType: `${event_type}Confirmed`,
            sessionId: session_id,
            evId: ev_id,
            eventKey,
            confirmed: true,
            queueId: id,
          }),
        },
      });
    }
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    console.error(
      `[LEDGER QUEUE] ✗ Failed ${event_type} for ${session_id}:`,
      errorMsg
    );

    queueStats.failed++;

    //calculate next retry time
    const nextRetry = new Date(
      Date.now() + CONFIG.RETRY_DELAY_MS * Math.pow(2, attempts)
    );

    //update event with failure info
    const newStatus = attempts + 1 >= CONFIG.MAX_ATTEMPTS ? "dead" : "failed";

    await supabase
      .from("ledger_queue")
      .update({
        status: newStatus,
        last_error: errorMsg,
        next_retry_at: nextRetry.toISOString(),
      })
      .eq("id", id);

    if (newStatus === "dead") {
      console.error(
        `[LEDGER QUEUE] ☠ Event ${id} is DEAD after ${CONFIG.MAX_ATTEMPTS} attempts`
      );

      //broadcast failure
      if (broadcaster) {
        broadcaster({
          eventName: `${event_type}Failed`,
          txId: null,
          payload: {
            timestamp: new Date().toISOString(),
            payload: JSON.stringify({
              eventType: `${event_type}Failed`,
              sessionId: session_id,
              evId: ev_id,
              error: errorMsg,
              queueId: id,
            }),
          },
        });
      }
    } else {
      queueStats.retried++;
      console.log(
        `[LEDGER QUEUE] Will retry ${event_type} at ${nextRetry.toISOString()}`
      );
    }
  }
}

//manually retry dead events

export async function retryDeadEvents(sessionId?: string): Promise<number> {
  const query = supabase
    .from("ledger_queue")
    .update({
      status: "pending",
      attempts: 0,
      next_retry_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("status", "dead");

  if (sessionId) {
    query.eq("session_id", sessionId);
  }

  const { data, error } = await query.select("id");

  if (error) {
    console.error("[LEDGER QUEUE] Failed to retry dead events:", error.message);
    return 0;
  }

  const count = data?.length || 0;
  console.log(`[LEDGER QUEUE] Reset ${count} dead events for retry`);
  return count;
}

//get current queue status
export async function getQueueStatus(): Promise<{
  pending: number;
  processing: number;
  failed: number;
  dead: number;
  confirmed: number;
}> {
  const { data, error } = await supabase
    .from("ledger_queue")
    .select("status")
    .then(({ data }) => {
      const counts = {
        pending: 0,
        processing: 0,
        failed: 0,
        dead: 0,
        confirmed: 0,
      };
      data?.forEach((row) => {
        const status = row.status as keyof typeof counts;
        if (status in counts) counts[status]++;
      });
      return { data: counts, error: null };
    });

  return (
    data || { pending: 0, processing: 0, failed: 0, dead: 0, confirmed: 0 }
  );
}
