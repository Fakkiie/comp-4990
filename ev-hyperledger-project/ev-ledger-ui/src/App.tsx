import { useEffect, useMemo, useState } from "react";

/** ---------------- Types ---------------- */
type SessionStatus = "active" | "charging" | "paused" | "disconnected" | "stopped" | "expired" | string;

interface EventRecord {
  timestamp?: string;
  txId?: string;
  payload?: string; // JSON string
}

interface IncomingEvent {
  eventName: string;
  txId: string;
  payload: EventRecord;
}

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
  eventKey?: string | null;
  error?: string;
}

type DbHealth = "unknown" | "ok" | "fail";

/** ---------------- Config ---------------- */
const API_BASE =
  (import.meta as any)?.env?.VITE_API_BASE?.toString() || "http://localhost:4000";

/** ---------------- Session State Helpers ---------------- */
const TERMINAL_STATES: SessionStatus[] = ["stopped", "expired"];
const RESUMABLE_STATES: SessionStatus[] = ["paused", "disconnected"];
const ACTIVE_STATES: SessionStatus[] = ["active", "charging"];

function isTerminal(status: string): boolean {
  return TERMINAL_STATES.includes(status as SessionStatus);
}

function isResumable(status: string): boolean {
  return RESUMABLE_STATES.includes(status as SessionStatus);
}

function isActive(status: string): boolean {
  return ACTIVE_STATES.includes(status as SessionStatus);
}

function isSessionExpired(expiresAt: string | null): boolean {
  if (!expiresAt || expiresAt === "—") return false;
  return Date.now() >= new Date(expiresAt).getTime();
}

/** ---------------- Helpers ---------------- */
function prettyJson(v: any) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function safeParseJson<T = any>(s?: string): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

type LedgerObj = {
  eventType?: string;
  sessionId?: string;
  evId?: string;
  powerRequired?: number;
  expiresAt?: string;
  eventKey?: string | null;
  status?: SessionStatus;
  [k: string]: any;
};

function pickEventType(incoming: IncomingEvent): string {
  const inner = safeParseJson<LedgerObj>(incoming.payload?.payload);
  return inner?.eventType || incoming.eventName || "Event";
}

function pickTimestamp(incoming: IncomingEvent): string {
  return incoming.payload?.timestamp || "—";
}

function pickSessionId(incoming: IncomingEvent): string {
  const inner = safeParseJson<LedgerObj>(incoming.payload?.payload);
  return inner?.sessionId || "—";
}

function pickEvId(incoming: IncomingEvent): string {
  const inner = safeParseJson<LedgerObj>(incoming.payload?.payload);
  return inner?.evId || "—";
}

function summarizeEvent(incoming: IncomingEvent): string {
  const inner = safeParseJson<LedgerObj>(incoming.payload?.payload);
  const type = pickEventType(incoming);

  if (!inner) return type;

  if (type === "SessionStarted") {
    const pr = inner.powerRequired ?? "—";
    const exp = inner.expiresAt ?? "—";
    return `Started · ${pr} kW · exp ${exp}`;
  }
  if (type === "SessionPaused") return "Paused (can resume)";
  if (type === "SessionResumed") return "Resumed (token rotated)";
  if (type === "SessionStopped") return "Stopped (TERMINAL)";
  if (type === "SessionExpired") return "Expired (TERMINAL)";

  const keys = ["status", "expiresAt", "powerRequired", "eventKey"].filter(
    (k) => inner[k] !== undefined && inner[k] !== null
  );
  if (!keys.length) return type;

  const kv = keys
    .map((k) => `${k}=${String(inner[k]).slice(0, 60)}`)
    .join(" · ");
  return `${type} · ${kv}`;
}

/** ---------------- Time remaining helper ---------------- */
function getTimeRemaining(expiresAt: string | null): string {
  if (!expiresAt || expiresAt === "—") return "—";
  
  const now = Date.now();
  const expiry = new Date(expiresAt).getTime();
  const diff = expiry - now;
  
  if (diff <= 0) return "EXPIRED";
  
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);
  
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** ---------------- App ---------------- */
export default function App() {
  const [events, setEvents] = useState<IncomingEvent[]>([]);
  const [sseStatus, setSseStatus] = useState<"connected" | "error" | "connecting">("connecting");
  const [filter, setFilter] = useState("");
  const [dbHealth, setDbHealth] = useState<DbHealth>("unknown");
  const [dbHealthDetail, setDbHealthDetail] = useState<string>("");

  // Session controls
  const [evId, setEvId] = useState("EV123");
  const [powerRequired, setPowerRequired] = useState<number>(18.5);
  const [sessionId, setSessionId] = useState<string>("");
  const [resumeToken, setResumeToken] = useState<string>("");
  const [apiLog, setApiLog] = useState<string>("");
  
  // Loading states for buttons
  const [loading, setLoading] = useState<string | null>(null);

  // Time remaining ticker
  const [, setTick] = useState(0);

  /** ---------------- SSE ---------------- */
  useEffect(() => {
    setSseStatus("connecting");
    const es = new EventSource(`${API_BASE}/events`);

    es.onmessage = (e) => {
      try {
        const data: IncomingEvent = JSON.parse(e.data);
        setEvents((prev) => [data, ...prev]);
        if (data?.eventName === "SSE_CONNECTED") setSseStatus("connected");
      } catch (err) {
        console.error("Failed to parse SSE event:", err, e.data);
      }
    };

    es.onerror = (err) => {
      console.error("EventSource error:", err);
      setSseStatus("error");
    };

    return () => es.close();
  }, []);

  /** ---------------- Time remaining ticker ---------------- */
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  /** ---------------- DB health check ---------------- */
  const runDbHealth = async () => {
    setDbHealth("unknown");
    setDbHealthDetail("");
    try {
      const res = await fetch(`${API_BASE}/health/db`);
      const json = await res.json().catch(() => ({}));
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
  }, []);

  /** ---------------- API helper ---------------- */
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
      throw new Error(json?.error || `HTTP ${res.status}`);
    }
    return json as T;
  }

  /** ---------------- Ledger-driven session state ---------------- */
  const currentFromLedger = useMemo(() => {
    if (!sessionId) return null;

    for (const evt of events) {
      const inner = safeParseJson<LedgerObj>(evt.payload?.payload);
      if (inner?.sessionId === sessionId) return inner;
    }
    return null;
  }, [events, sessionId]);

  // Auto-fill sessionId from latest session events
  useEffect(() => {
    if (sessionId) return;

    for (const evt of events) {
      const inner = safeParseJson<LedgerObj>(evt.payload?.payload);
      if (inner?.sessionId) {
        setSessionId(inner.sessionId);
        break;
      }
    }
  }, [events, sessionId]);

  /** ---------------- Derived session state ---------------- */
  const sessionStatus: SessionStatus = useMemo(() => {
    if (!currentFromLedger) return "—";
    
    // First check if status field is set directly
    if (currentFromLedger.status) return currentFromLedger.status;
    
    // Otherwise derive from eventType
    const eventType = currentFromLedger.eventType;
    if (eventType === "SessionStopped") return "stopped";
    if (eventType === "SessionExpired") return "expired";
    if (eventType === "SessionPaused") return "disconnected";
    if (eventType === "SessionStarted") return "active";
    if (eventType === "SessionResumed") return "active";
    
    return "—";
  }, [currentFromLedger]);

  const sessionExpiresAt = currentFromLedger?.expiresAt || "—";
  const sessionEventKey = currentFromLedger?.eventKey || "—";
  const timeRemaining = getTimeRemaining(sessionExpiresAt !== "—" ? sessionExpiresAt : null);
  const expired = isSessionExpired(sessionExpiresAt !== "—" ? sessionExpiresAt : null);

  /** ---------------- Button state logic ---------------- */
  const canStart = !sessionId || isTerminal(sessionStatus) || sessionStatus === "—";
  const canPause = isActive(sessionStatus) && !expired;
  const canResume = isResumable(sessionStatus) && !expired && !!resumeToken;
  const canStop = (isActive(sessionStatus) || isResumable(sessionStatus)) && !isTerminal(sessionStatus);

  /** ---------------- Actions ---------------- */
  const doStart = async () => {
    setLoading("start");
    setApiLog("Calling /api/sessions/start ...");
    try {
      const data = await callSessionEndpoint<SessionResponse>(
        "/api/sessions/start",
        { evId, powerRequired }
      );

      if (data?.session?.sessionId) setSessionId(data.session.sessionId);
      if (data?.resumeToken) setResumeToken(data.resumeToken);

      setApiLog(prettyJson(data));
    } catch (e: any) {
      setApiLog("ERROR: " + (e?.message ?? String(e)));
    } finally {
      setLoading(null);
    }
  };

  const doPause = async () => {
    if (!sessionId) return alert("No sessionId. Start first.");

    setLoading("pause");
    setApiLog("Calling /api/sessions/pause ...");
    try {
      const data = await callSessionEndpoint<SessionResponse>(
        "/api/sessions/pause",
        { evId, sessionId }
      );

      setApiLog(prettyJson(data));
    } catch (e: any) {
      setApiLog("ERROR: " + (e?.message ?? String(e)));
    } finally {
      setLoading(null);
    }
  };

  const doResume = async () => {
    if (!sessionId) return alert("No sessionId. Start first (or paste one).");
    if (!resumeToken) return alert("No resumeToken. Start first (or paste one).");

    setLoading("resume");
    setApiLog("Calling /api/sessions/resume ...");
    try {
      const data = await callSessionEndpoint<SessionResponse>(
        "/api/sessions/resume",
        { evId, sessionId, resumeToken }
      );

      if (data?.resumeToken) setResumeToken(data.resumeToken);
      setApiLog(prettyJson(data));
    } catch (e: any) {
      setApiLog("ERROR: " + (e?.message ?? String(e)));
    } finally {
      setLoading(null);
    }
  };

  const doStop = async () => {
    if (!sessionId) return alert("No sessionId. Start first (or paste one).");

    setLoading("stop");
    setApiLog("Calling /api/sessions/stop ...");
    try {
      const data = await callSessionEndpoint<SessionResponse>(
        "/api/sessions/stop",
        { evId, sessionId }
      );

      // Clear resume token since session is terminated
      setResumeToken("");
      setApiLog(prettyJson(data));
    } catch (e: any) {
      setApiLog("ERROR: " + (e?.message ?? String(e)));
    } finally {
      setLoading(null);
    }
  };

  const doNewSession = () => {
    setSessionId("");
    setResumeToken("");
    setApiLog("");
  };

  /** ---------------- Filtered events ---------------- */
  const filteredEvents = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return events;

    return events.filter((evt) => {
      const inner = evt.payload?.payload || "";
      const hay = [
        evt.eventName,
        evt.txId,
        evt.payload?.txId,
        evt.payload?.timestamp,
        inner,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return hay.includes(q);
    });
  }, [events, filter]);

  const totalEvents = events.length;

  /** ---------------- Status badge color ---------------- */
  const getStatusColor = (status: string) => {
    if (isActive(status)) return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
    if (isResumable(status)) return "bg-amber-500/20 text-amber-300 border-amber-500/40";
    if (isTerminal(status)) return "bg-red-500/20 text-red-300 border-red-500/40";
    return "bg-slate-500/20 text-slate-300 border-slate-500/40";
  };

  /** ---------------- UI ---------------- */
  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      {/* Top bar */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-emerald-500 flex items-center justify-center text-slate-950 font-bold text-lg">
              ⚡
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-wide uppercase text-slate-200">
                EV Ledger Dashboard
              </h1>
              <p className="text-xs text-slate-400">
                Channel <span className="font-mono">mychannel</span> · Contract{" "}
                <span className="font-mono">ev-contract</span> ·{" "}
                <span className="font-mono">{API_BASE}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span
              className={[
                "inline-flex items-center gap-2 rounded-full px-3 py-1.5 border",
                sseStatus === "connected"
                  ? "border-emerald-700/60 bg-emerald-500/10 text-emerald-200"
                  : sseStatus === "error"
                  ? "border-red-700/60 bg-red-500/10 text-red-200"
                  : "border-slate-700 bg-slate-950/40 text-slate-300",
              ].join(" ")}
            >
              <span
                className={[
                  "h-2 w-2 rounded-full",
                  sseStatus === "connected"
                    ? "bg-emerald-400"
                    : sseStatus === "error"
                    ? "bg-red-400"
                    : "bg-slate-500",
                ].join(" ")}
              />
              SSE: {sseStatus.toUpperCase()}
            </span>

            <button
              onClick={runDbHealth}
              className="rounded-full border border-slate-700 bg-slate-950/40 px-3 py-1.5 hover:bg-slate-900"
            >
              Re-check DB
            </button>

            <span
              className={[
                "inline-flex items-center gap-2 rounded-full px-3 py-1.5 border",
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
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 space-y-6">
        {/* Summary */}
        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
            <p className="text-xs font-medium text-slate-400">Total SSE events</p>
            <p className="mt-2 text-2xl font-semibold">{totalEvents}</p>
            <p className="mt-1 text-xs text-slate-500">
              Events received since page load.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
            <p className="text-xs font-medium text-slate-400">Current Session</p>
            <p className="mt-2 text-xs text-slate-200">
              Session ID:{" "}
              <span className="font-mono break-all">{sessionId || "—"}</span>
            </p>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs text-slate-400">Status:</span>
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${getStatusColor(sessionStatus)}`}>
                {sessionStatus.toUpperCase()}
              </span>
              {expired && sessionStatus !== "expired" && (
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border bg-red-500/20 text-red-300 border-red-500/40">
                  EXPIRED
                </span>
              )}
            </div>
            <p className="mt-2 text-xs text-slate-200">
              Time remaining:{" "}
              <span className={`font-mono ${timeRemaining === "EXPIRED" ? "text-red-400" : "text-emerald-400"}`}>
                {timeRemaining}
              </span>
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
            <p className="text-xs font-medium text-slate-400">Last event key</p>
            <p className="mt-2 text-xs font-mono text-slate-200 break-all">
              {sessionEventKey}
            </p>
            <p className="mt-1 text-[0.7rem] text-slate-500">
              eventKey returned by chaincode (if enabled).
            </p>
          </div>
        </section>

        {/* Session controls */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-200">
                Session Controls (DB + Ledger)
              </h2>
              <p className="mt-1 text-xs text-slate-400">
                Start → Pause (soft disconnect) → Resume → Stop (terminal)
              </p>
            </div>
            {sessionId && (
              <button
                onClick={doNewSession}
                className="rounded-xl border border-slate-700 bg-slate-950/40 px-3 py-1.5 text-xs hover:bg-slate-900"
              >
                New Session
              </button>
            )}
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            {/* Inputs */}
            <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
              <p className="text-xs font-medium text-slate-300">Inputs</p>

              <label className="mt-3 block text-[0.7rem] text-slate-400">
                EV ID
              </label>
              <input
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm text-slate-50 focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                value={evId}
                onChange={(e) => setEvId(e.target.value)}
                placeholder="EV123"
              />

              <label className="mt-3 block text-[0.7rem] text-slate-400">
                Power Required (kW)
              </label>
              <input
                type="number"
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm text-slate-50 focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                value={powerRequired}
                onChange={(e) => setPowerRequired(Number(e.target.value))}
              />

              <label className="mt-3 block text-[0.7rem] text-slate-400">
                Session ID
              </label>
              <input
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-xs font-mono text-slate-50 focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                placeholder="(auto-filled after start / from ledger)"
              />

              <label className="mt-3 block text-[0.7rem] text-slate-400">
                Resume Token
              </label>
              <textarea
                className="mt-1 w-full min-h-[70px] resize-y rounded-xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-xs font-mono text-slate-50 focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                value={resumeToken}
                onChange={(e) => setResumeToken(e.target.value)}
                placeholder="(auto-filled after start/resume)"
              />
              <p className="mt-2 text-[0.7rem] text-slate-500">
                Token rotates on resume. Cleared on stop.
              </p>

              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-slate-400">
                  DB health details
                </summary>
                <pre className="mt-2 whitespace-pre-wrap break-words rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-[0.7rem] text-slate-200">
                  {dbHealthDetail || "(none)"}
                </pre>
              </details>
            </div>

            {/* Actions */}
            <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
              <p className="text-xs font-medium text-slate-300">Actions</p>

              <div className="mt-3 grid grid-cols-2 gap-2">
                {/* START */}
                <button
                  onClick={doStart}
                  disabled={!canStart || loading === "start"}
                  className={[
                    "rounded-xl px-3 py-2 text-xs font-semibold transition-all",
                    canStart && loading !== "start"
                      ? "bg-emerald-500 text-slate-950 hover:bg-emerald-400"
                      : "bg-slate-700 text-slate-500 cursor-not-allowed",
                  ].join(" ")}
                >
                  {loading === "start" ? "Starting..." : "Start"}
                </button>

                {/* PAUSE */}
                <button
                  onClick={doPause}
                  disabled={!canPause || loading === "pause"}
                  className={[
                    "rounded-xl px-3 py-2 text-xs font-semibold transition-all border",
                    canPause && loading !== "pause"
                      ? "border-amber-500/60 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20"
                      : "border-slate-700 bg-slate-800 text-slate-500 cursor-not-allowed",
                  ].join(" ")}
                >
                  {loading === "pause" ? "Pausing..." : "Pause"}
                </button>

                {/* RESUME */}
                <button
                  onClick={doResume}
                  disabled={!canResume || loading === "resume"}
                  className={[
                    "rounded-xl px-3 py-2 text-xs font-semibold transition-all border",
                    canResume && loading !== "resume"
                      ? "border-sky-500/60 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20"
                      : "border-slate-700 bg-slate-800 text-slate-500 cursor-not-allowed",
                  ].join(" ")}
                >
                  {loading === "resume" ? "Resuming..." : "Resume"}
                </button>

                {/* STOP */}
                <button
                  onClick={doStop}
                  disabled={!canStop || loading === "stop"}
                  className={[
                    "rounded-xl px-3 py-2 text-xs font-semibold transition-all border",
                    canStop && loading !== "stop"
                      ? "border-red-700/70 bg-red-500/10 text-red-200 hover:bg-red-500/20"
                      : "border-slate-700 bg-slate-800 text-slate-500 cursor-not-allowed",
                  ].join(" ")}
                >
                  {loading === "stop" ? "Stopping..." : "Stop (Terminal)"}
                </button>
              </div>

              {/* State explanation */}
              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-2">
                <p className="text-[0.7rem] text-slate-400 font-medium">Button States:</p>
                <div className="text-[0.7rem] text-slate-500 space-y-1">
                  <p>• <span className="text-emerald-400">Start</span>: No session or session is terminal</p>
                  <p>• <span className="text-amber-400">Pause</span>: Session is active & not expired</p>
                  <p>• <span className="text-sky-400">Resume</span>: Session is paused/disconnected & not expired & has token</p>
                  <p>• <span className="text-red-400">Stop</span>: Session is active or paused (ends permanently)</p>
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-[0.7rem] text-slate-400">Ledger-derived</p>
                <p className="mt-1 text-xs text-slate-200">
                  Status: <span className={`font-mono px-1.5 py-0.5 rounded ${getStatusColor(sessionStatus)}`}>{sessionStatus}</span>
                </p>
                <p className="mt-2 text-xs text-slate-200">
                  Expires:{" "}
                  <span className="font-mono break-all">{sessionExpiresAt}</span>
                </p>
                <p className="mt-1 text-xs text-slate-200">
                  Remaining:{" "}
                  <span className={`font-mono ${timeRemaining === "EXPIRED" ? "text-red-400" : "text-emerald-400"}`}>
                    {timeRemaining}
                  </span>
                </p>
              </div>
            </div>

            {/* API output */}
            <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
              <p className="text-xs font-medium text-slate-300">API output</p>
              <pre className="mt-3 max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-[0.7rem] text-slate-200">
                {apiLog || "(no calls yet)"}
              </pre>
            </div>
          </div>
        </section>

        {/* Events filter + table */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/80">
          <div className="flex flex-col gap-3 border-b border-slate-800 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-200">
                Ledger Event Stream (SSE)
              </h2>
              <p className="mt-1 text-xs text-slate-400">
                Filter by sessionId, event type, txId, EV id, etc.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <input
                className="w-full sm:w-[320px] rounded-xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm text-slate-50 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500/60 focus:border-sky-500/60"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Type to filter… (EV123, SessionStarted, sess-…)"
              />
              <span className="text-[0.7rem] text-slate-500 whitespace-nowrap">
                {filteredEvents.length}/{events.length}
              </span>
            </div>
          </div>

          {filteredEvents.length === 0 ? (
            <div className="px-4 py-6 text-sm text-slate-400">
              No events yet. Trigger Start/Pause/Resume/Stop to generate ledger events.
            </div>
          ) : (
            <div className="max-h-[520px] overflow-y-auto">
              <table className="min-w-full text-left text-xs text-slate-300">
                <thead className="sticky top-0 bg-slate-900">
                  <tr>
                    <th className="px-4 py-2 font-medium text-slate-400">Timestamp</th>
                    <th className="px-4 py-2 font-medium text-slate-400">Event</th>
                    <th className="px-4 py-2 font-medium text-slate-400">Session</th>
                    <th className="px-4 py-2 font-medium text-slate-400">EV</th>
                    <th className="px-4 py-2 font-medium text-slate-400">Tx ID</th>
                    <th className="px-4 py-2 font-medium text-slate-400">Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.map((evt, idx) => {
                    const ts = pickTimestamp(evt);
                    const type = pickEventType(evt);
                    const sid = pickSessionId(evt);
                    const evid = pickEvId(evt);

                    const txFull = evt.payload?.txId || evt.txId || "";
                    const txShort = txFull.length > 16 ? `${txFull.slice(0, 16)}…` : txFull;

                    const summary = summarizeEvent(evt);

                    // Event type color
                    const eventColor = 
                      type === "SessionStarted" ? "text-emerald-400" :
                      type === "SessionPaused" ? "text-amber-400" :
                      type === "SessionResumed" ? "text-sky-400" :
                      type === "SessionStopped" ? "text-red-400" :
                      type === "SessionExpired" ? "text-red-400" :
                      "text-slate-100";

                    return (
                      <tr
                        key={idx}
                        className="border-t border-slate-800/80 hover:bg-slate-800/40"
                      >
                        <td className="px-4 py-2 align-top">
                          <span className="font-mono text-[0.7rem] text-slate-400">{ts}</span>
                        </td>
                        <td className="px-4 py-2 align-top">
                          <span className={`text-[0.75rem] font-medium ${eventColor}`}>{type}</span>
                        </td>
                        <td className="px-4 py-2 align-top">
                          <span className="font-mono text-[0.7rem] break-all">{sid}</span>
                        </td>
                        <td className="px-4 py-2 align-top">
                          <span className="font-mono text-[0.7rem]">{evid}</span>
                        </td>
                        <td className="px-4 py-2 align-top">
                          <span className="font-mono text-[0.7rem]">{txShort || "(none)"}</span>
                        </td>
                        <td className="px-4 py-2 align-top">
                          <span className="text-[0.75rem] text-slate-100 break-words">{summary}</span>

                          <details className="mt-1">
                            <summary className="cursor-pointer text-[0.7rem] text-slate-500">raw</summary>
                            <pre className="mt-2 whitespace-pre-wrap break-words rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-[0.7rem] text-slate-200">
                              {evt.payload?.payload || "(none)"}
                            </pre>
                          </details>
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