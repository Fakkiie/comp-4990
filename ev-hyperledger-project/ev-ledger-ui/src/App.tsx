import { useEffect, useState } from "react";

interface EventRecord {
  id?: string;
  payload?: string; // JSON string with { message }
  timestamp?: string;
  txId?: string;
}

interface IncomingEvent {
  eventName: string;
  txId: string;
  payload: EventRecord;
}

function App() {
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("");
  const [events, setEvents] = useState<IncomingEvent[]>([]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    const es = new EventSource("http://localhost:4000/events");

    es.onmessage = (e) => {
      try {
        const data: IncomingEvent = JSON.parse(e.data);
        setEvents((prev) => [data, ...prev]);
      } catch (err) {
        console.error("Failed to parse SSE event:", err, e.data);
      }
    };

    es.onerror = (err) => {
      console.error("EventSource error:", err);
    };

    return () => {
      es.close();
    };
  }, []);

  const handleSend = async () => {
    const trimmed = message.trim();
    if (!trimmed) {
      alert("Please enter a message first.");
      return;
    }

    setStatus("Sending...");
    try {
      const res = await fetch("http://localhost:4000/api/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: crypto.randomUUID(), // auto-generate session ID
          source: "ui", // mark events as coming from the UI
          payload: trimmed, // raw message
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Request failed");
      }

      setStatus("Sent!");
      setMessage("");
      setTimeout(() => setStatus(""), 1500);
    } catch (err: any) {
      console.error(err);
      setStatus("Error: " + err.message);
    }
  };

  const filteredEvents = events.filter((evt) => {
    if (!filter.trim()) return true;
    const rec = evt.payload || {};
    const txtPieces = [evt.txId, rec.txId, rec.id, rec.timestamp, rec.payload]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return txtPieces.includes(filter.toLowerCase());
  });

  const latestTs =
    events[0]?.payload?.timestamp ??
    (events.length ? "(from chain events)" : "—");

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      {/* Top bar */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-emerald-500 flex items-center justify-center text-slate-950 font-bold text-lg">
              ⚡
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-wide uppercase text-slate-200">
                EV Fabric Explorer
              </h1>
              <p className="text-xs text-slate-400">
                Live on <span className="font-mono">mychannel</span> · contract{" "}
                <span className="font-mono">ev-contract</span>
              </p>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-3 text-xs text-slate-400">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Gateway: Org1 · Identity: appUser</span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 space-y-6">
        {/* Summary cards */}
        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
            <p className="text-xs font-medium text-slate-400">Total events</p>
            <p className="mt-2 text-2xl font-semibold">{events.length}</p>
            <p className="mt-1 text-xs text-slate-500">
              Count since this dashboard connected.
            </p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
            <p className="text-xs font-medium text-slate-400">
              Last on-chain timestamp
            </p>
            <p className="mt-2 text-sm font-mono text-slate-200 break-all">
              {latestTs}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Based on <code>LogEvent</code> payload.
            </p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 flex flex-col justify-between">
            <div>
              <p className="text-xs font-medium text-slate-400">
                Status / actions
              </p>
              <p className="mt-2 text-xs text-slate-300 min-h-[1.25rem]">
                {status || "Idle"}
              </p>
            </div>
            <p className="mt-2 text-[0.7rem] text-slate-500">
              Messages are submitted as Fabric transactions using the{" "}
              <code>LogEvent</code> function.
            </p>
          </div>
        </section>

        {/* Input + filter */}
        <section className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          {/* Write to ledger */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
            <h2 className="text-sm font-semibold text-slate-200">
              Submit event to ledger
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              This will invoke <code>LogEvent(ctx, payload)</code> on the{" "}
              <code>ev-contract</code> chaincode.
            </p>

            <textarea
              className="mt-3 w-full min-h-[90px] resize-y rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm text-slate-50 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/60 focus:border-emerald-500/60"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder='e.g. {"stationId":"SECC-01","kWh":32.5,"status":"completed"}'
            />

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                onClick={handleSend}
                className="inline-flex items-center gap-2 rounded-full bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-slate-950 shadow-sm hover:bg-emerald-400 transition"
              >
                <span>Send to ledger</span>
              </button>
              <span className="text-[0.7rem] text-slate-500">
                Transactions are ordered by Fabric and stored with tx ID keys.
              </span>
            </div>
          </div>

          {/* Filter/search */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
            <h2 className="text-sm font-semibold text-slate-200">
              Filter events
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Search by message content, transaction ID, or timestamp.
            </p>
            <input
              className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm text-slate-50 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500/60 focus:border-sky-500/60"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Type to filter (e.g. SECC, completed, tx prefix)..."
            />
          </div>
        </section>

        {/* Events table */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/80">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-200">
              Recent ledger events
            </h2>
            <span className="text-[0.7rem] text-slate-500">
              Showing {filteredEvents.length} of {events.length}
            </span>
          </div>

          {filteredEvents.length === 0 ? (
            <div className="px-4 py-6 text-sm text-slate-400">
              No events yet. Submit a message above to log the first event.
            </div>
          ) : (
            <div className="max-h-[420px] overflow-y-auto">
              <table className="min-w-full text-left text-xs text-slate-300">
                <thead className="sticky top-0 bg-slate-900">
                  <tr>
                    <th className="px-4 py-2 font-medium text-slate-400">
                      Tx ID
                    </th>
                    <th className="px-4 py-2 font-medium text-slate-400">
                      Timestamp
                    </th>
                    <th className="px-4 py-2 font-medium text-slate-400">
                      Message
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.map((evt, idx) => {
                    const rec = evt.payload || {};
                    let payloadMessage = "";
                    try {
                      if (rec.payload) {
                        const parsed = JSON.parse(rec.payload);
                        payloadMessage = parsed.message || rec.payload;
                      }
                    } catch {
                      payloadMessage = rec.payload || "";
                    }

                    const ts = rec.timestamp || "—";
                    const txFull = rec.txId || evt.txId || "";
                    const txShort =
                      txFull.length > 16 ? `${txFull.slice(0, 16)}…` : txFull;

                    return (
                      <tr
                        key={idx}
                        className="border-t border-slate-800/80 hover:bg-slate-800/40"
                      >
                        <td className="px-4 py-2 align-top">
                          <span className="font-mono text-[0.7rem]">
                            {txShort || "(none)"}
                          </span>
                        </td>
                        <td className="px-4 py-2 align-top">
                          <span className="font-mono text-[0.7rem] text-slate-400">
                            {ts}
                          </span>
                        </td>
                        <td className="px-4 py-2 align-top">
                          <span className="text-[0.75rem] text-slate-100 break-words">
                            {payloadMessage || "(no message)"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
