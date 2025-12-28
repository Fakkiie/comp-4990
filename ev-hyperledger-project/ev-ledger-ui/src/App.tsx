import { useEffect, useMemo, useState } from "react";

/** ---------------- Types ---------------- */
interface EventRecord {
  id?: string;
  payload?: string; // raw payload string (your server sends record.payload as string)
  timestamp?: string;
  txId?: string;
  sessionId?: string;
  source?: string;
}

interface IncomingEvent {
  eventName: string;
  txId: string;
  payload: EventRecord;
}

type SessionStatus = "active" | "paused" | "ended" | "expired" | string;

interface SessionResponse {
  ok: boolean;
  session?: {
    evId: string;
    sessionId: string;
    powerRequired: number;
    powerConsumed: number;
    cost: number;
    status: SessionStatus;
    expiresAt: string;
  };
  resumeToken?: string;
  txId?: string | null;
  error?: string;
}

const API_BASE = "http://localhost:4000";

function prettyJson(v: any) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function App() {
  /** ---------------- Existing ledger/SSE state ---------------- */
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("");
  const [events, setEvents] = useState<IncomingEvent[]>([]);
  const [filter, setFilter] = useState("");

  /** ---------------- New session/token tester state ---------------- */
  const [dbHealth, setDbHealth] = useState<"unknown" | "ok" | "fail">(
    "unknown"
  );
  const [dbHealthDetail, setDbHealthDetail] = useState<string>("");

  const [evId, setEvId] = useState("EV123");
  const [powerRequired, setPowerRequired] = useState<number>(18.5);

  const [sessionId, setSessionId] = useState<string>("");
  const [resumeToken, setResumeToken] = useState<string>("");

  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("—");
  const [expiresAt, setExpiresAt] = useState<string>("—");

  const [apiLog, setApiLog] = useState<string>("");

  /** ---------------- SSE: subscribe to /events ---------------- */
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/events`);

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

  /** ---------------- DB health check ---------------- */
  const runDbHealth = async () => {
    setDbHealth("unknown");
    setDbHealthDetail("");
    try {
      const res = await fetch(`${API_BASE}/health/db`);
      const json = await res.json();
      if (res.ok && json?.ok) {
        setDbHealth("ok");
        setDbHealthDetail(prettyJson(json));
      } else {
        setDbHealth("fail");
        setDbHealthDetail(prettyJson(json));
      }
    } catch (e: any) {
      setDbHealth("fail");
      setDbHealthDetail(e?.message ?? String(e));
    }
  };

  useEffect(() => {
    runDbHealth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** ---------------- Existing: send a raw Fabric log via /api/log ---------------- */
  const handleSend = async () => {
    const trimmed = message.trim();
    if (!trimmed) {
      alert("Please enter a message first.");
      return;
    }

    setStatus("Sending...");
    try {
      const res = await fetch(`${API_BASE}/api/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: crypto.randomUUID(),
          source: "ui",
          payload: trimmed,
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

  /** ---------------- New: helper to call session endpoints ---------------- */
  async function callSessionEndpoint<T = any>(
    path: string,
    body: Record<string, any>
  ): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.error || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return json as T;
  }

  const syncFromSessionResponse = (data: SessionResponse) => {
    if (data?.session) {
      setSessionId(data.session.sessionId);
      setSessionStatus(data.session.status);
      setExpiresAt(data.session.expiresAt);
    }
    if (typeof data?.resumeToken === "string" && data.resumeToken.length) {
      setResumeToken(data.resumeToken);
    }
  };

  /** ---------------- New: Start/Pause/Resume/Stop ---------------- */
  const doStart = async () => {
    setApiLog("Calling /api/sessions/start ...");
    try {
      const data = await callSessionEndpoint<SessionResponse>(
        "/api/sessions/start",
        { evId, powerRequired }
      );
      syncFromSessionResponse(data);
      setApiLog(prettyJson(data));
    } catch (e: any) {
      setApiLog("ERROR: " + (e?.message ?? String(e)));
    }
  };

  const doPause = async () => {
    if (!sessionId) return alert("No sessionId yet. Start first.");
    setApiLog("Calling /api/sessions/pause ...");
    try {
      const data = await callSessionEndpoint<SessionResponse>(
        "/api/sessions/pause",
        { evId, sessionId }
      );
      syncFromSessionResponse(data);
      setApiLog(prettyJson(data));
    } catch (e: any) {
      setApiLog("ERROR: " + (e?.message ?? String(e)));
    }
  };

  const doResume = async () => {
    if (!sessionId) return alert("No sessionId yet. Start first.");
    if (!resumeToken)
      return alert("No resumeToken yet. Start (or paste token) first.");
    setApiLog("Calling /api/sessions/resume ...");
    try {
      const data = await callSessionEndpoint<SessionResponse>(
        "/api/sessions/resume",
        { evId, sessionId, resumeToken }
      );
      // Resume rotates token (recommended), so we update it from response
      syncFromSessionResponse(data);
      setApiLog(prettyJson(data));
    } catch (e: any) {
      setApiLog("ERROR: " + (e?.message ?? String(e)));
    }
  };

  const doStop = async () => {
    if (!sessionId) return alert("No sessionId yet. Start first.");
    setApiLog("Calling /api/sessions/stop ...");
    try {
      const data = await callSessionEndpoint<SessionResponse>(
        "/api/sessions/stop",
        { evId, sessionId }
      );
      syncFromSessionResponse(data);
      setApiLog(prettyJson(data));
    } catch (e: any) {
      setApiLog("ERROR: " + (e?.message ?? String(e)));
    }
  };

  /** ---------------- Filtered events table (existing) ---------------- */
  const filteredEvents = useMemo(() => {
    return events.filter((evt) => {
      if (!filter.trim()) return true;
      const rec = evt.payload || {};
      const txtPieces = [evt.txId, rec.txId, rec.id, rec.timestamp, rec.payload]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return txtPieces.includes(filter.toLowerCase());
    });
  }, [events, filter]);

  const latestTs =
    events[0]?.payload?.timestamp ??
    (events.length ? "(from chain events)" : "—");

  /** ---------------- UI ---------------- */
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
              Based on <code>WriteSession</code> payload.
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
              SSE is listening on <code>/events</code>.
            </p>
          </div>
        </section>

        {/* NEW: Session / Token tester */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-200">
                Session / Token Tester (Supabase)
              </h2>
              <p className="mt-1 text-xs text-slate-400">
                Start → Pause/Resume → Stop. Resume rotates token each time.
              </p>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <button
                onClick={runDbHealth}
                className="rounded-full border border-slate-700 bg-slate-950/40 px-3 py-1.5 hover:bg-slate-900"
              >
                Re-check DB
              </button>
              <span
                className={[
                  "inline-flex items-center gap-2 rounded-full px-3 py-1.5 border text-xs",
                  dbHealth === "ok"
                    ? "border-emerald-700/60 bg-emerald-500/10 text-emerald-200"
                    : dbHealth === "fail"
                    ? "border-red-700/60 bg-red-500/10 text-red-200"
                    : "border-slate-700 bg-slate-950/40 text-slate-300",
                ].join(" ")}
              >
                <span
                  className={[
                    "h-2 w-2 rounded-full",
                    dbHealth === "ok"
                      ? "bg-emerald-400"
                      : dbHealth === "fail"
                      ? "bg-red-400"
                      : "bg-slate-500",
                  ].join(" ")}
                />
                DB: {dbHealth.toUpperCase()}
              </span>
            </div>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            {/* Inputs */}
            <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-4">
              <p className="text-xs font-medium text-slate-300">Inputs</p>

              <label className="mt-3 block text-[0.7rem] text-slate-400">
                EV ID
              </label>
              <input
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm text-slate-50 focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                value={evId}
                onChange={(e) => setEvId(e.target.value)}
                placeholder="EV123"
              />

              <label className="mt-3 block text-[0.7rem] text-slate-400">
                Power Required (kW)
              </label>
              <input
                type="number"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm text-slate-50 focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                value={powerRequired}
                onChange={(e) => setPowerRequired(Number(e.target.value))}
              />

              <label className="mt-3 block text-[0.7rem] text-slate-400">
                Session ID
              </label>
              <input
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-xs font-mono text-slate-50 focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                placeholder="(auto-filled after start)"
              />

              <label className="mt-3 block text-[0.7rem] text-slate-400">
                Resume Token
              </label>
              <textarea
                className="mt-1 w-full min-h-[70px] resize-y rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-xs font-mono text-slate-50 focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                value={resumeToken}
                onChange={(e) => setResumeToken(e.target.value)}
                placeholder="(auto-filled after start/resume)"
              />
              <p className="mt-2 text-[0.7rem] text-slate-500">
                Token rotates on resume. Old token should fail after rotation.
              </p>
            </div>

            {/* Actions */}
            <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-4">
              <p className="text-xs font-medium text-slate-300">Actions</p>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  onClick={doStart}
                  className="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
                >
                  Start
                </button>
                <button
                  onClick={doPause}
                  className="rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs font-semibold hover:bg-slate-900"
                >
                  Pause
                </button>
                <button
                  onClick={doResume}
                  className="rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs font-semibold hover:bg-slate-900"
                >
                  Resume
                </button>
                <button
                  onClick={doStop}
                  className="rounded-lg border border-red-700/70 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-200 hover:bg-red-500/20"
                >
                  Stop
                </button>
              </div>

              <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-[0.7rem] text-slate-400">Current session</p>
                <p className="mt-1 text-xs text-slate-200">
                  Status: <span className="font-mono">{sessionStatus}</span>
                </p>
                <p className="mt-1 text-xs text-slate-200">
                  Expires:{" "}
                  <span className="font-mono break-all">{expiresAt}</span>
                </p>
              </div>

              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-slate-400">
                  DB health details
                </summary>
                <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-[0.7rem] text-slate-200">
                  {dbHealthDetail || "(none)"}
                </pre>
              </details>
            </div>

            {/* API output */}
            <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-4">
              <p className="text-xs font-medium text-slate-300">API output</p>
              <pre className="mt-3 max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-[0.7rem] text-slate-200">
                {apiLog || "(no calls yet)"}
              </pre>
            </div>
          </div>
        </section>

        {/* Existing: Input + filter */}
        <section className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          {/* Write to ledger */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
            <h2 className="text-sm font-semibold text-slate-200">
              Submit event to ledger (Fabric)
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              This calls <code>POST /api/log</code> and broadcasts over SSE.
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
                Fabric tx ID shows up in the event stream below.
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
              Recent ledger events (SSE)
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
                    const ts = rec.timestamp || "—";
                    const txFull = rec.txId || evt.txId || "";
                    const txShort =
                      txFull.length > 16 ? `${txFull.slice(0, 16)}…` : txFull;

                    // Your record payload is likely just "payload" as a string (your UI sends raw message)
                    let payloadMessage = "";
                    try {
                      if (rec.payload) {
                        const parsed = JSON.parse(rec.payload);
                        payloadMessage =
                          parsed.message ||
                          parsed.eventType ||
                          JSON.stringify(parsed);
                      }
                    } catch {
                      payloadMessage = rec.payload || "";
                    }

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
