import { Router, Request, Response } from "express";
import { supabase } from "../lib/supabase";
import { generateResumeToken, hashToken } from "../lib/tokens";
import { queueLedgerEvent } from "../lib/ledgerQueue";

type ContractRef = { get: () => any | null };
type Broadcaster = (data: any) => void;

//in memory session cache
interface CachedSession {
  session_id: string;
  ev_id: string;
  power_required: number;
  power_consumed: number;
  cost: number;
  status: string;
  expires_at: string;
  cached_at: number;
}

const sessionCache = new Map<string, CachedSession>();
const CACHE_TTL_MS = 60 * 1000;

function getCacheKey(sessionId: string, evId: string): string {
  return `${sessionId}:${evId}`;
}

async function getSessionCached(
  sessionId: string,
  evId: string
): Promise<CachedSession | null> {
  const key = getCacheKey(sessionId, evId);
  const cached = sessionCache.get(key);

  if (cached && Date.now() - cached.cached_at < CACHE_TTL_MS) {
    return cached;
  }

  const { data, error } = await supabase
    .from("charging_sessions")
    .select(
      "session_id, ev_id, power_required, power_consumed, cost, status, expires_at"
    )
    .eq("session_id", sessionId)
    .eq("ev_id", evId)
    .single();

  if (error || !data) return null;

  const session: CachedSession = { ...data, cached_at: Date.now() };
  sessionCache.set(key, session);
  return session;
}

function invalidateSessionCache(sessionId: string, evId: string): void {
  sessionCache.delete(getCacheKey(sessionId, evId));
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sessionCache) {
    if (now - value.cached_at > CACHE_TTL_MS) {
      sessionCache.delete(key);
    }
  }
}, 5 * 60 * 1000);

//status helpers
const TERMINAL_STATES = ["stopped", "expired"];
const RESUMABLE_STATES = ["paused", "disconnected"];
const ACTIVE_STATES = ["active", "charging"];

function isTerminal(status: string): boolean {
  return TERMINAL_STATES.includes(status);
}

function isResumable(status: string): boolean {
  return RESUMABLE_STATES.includes(status);
}

function isActive(status: string): boolean {
  return ACTIVE_STATES.includes(status);
}

function nowIso(): string {
  return new Date().toISOString();
}

function isExpired(expiresAt: string): boolean {
  return Date.now() >= new Date(expiresAt).getTime();
}

//sse emitter helper

function emit(broadcast: Broadcaster | undefined, eventName: string, obj: any) {
  broadcast?.({
    eventName,
    txId: "pending",
    payload: {
      timestamp: nowIso(),
      txId: "pending",
      payload: JSON.stringify(obj),
    },
  });
}

//session routes

export function createSessionsRouter(
  contractRef: ContractRef,
  broadcast?: Broadcaster
) {
  const router = Router();

  //router start function
  router.post("/start", async (req: Request, res: Response) => {
    const startTime = Date.now();

    try {
      const {
        evId,
        powerRequired,
        hours = 6,
      } = req.body as {
        evId?: string;
        powerRequired?: number;
        hours?: number;
      };

      if (!evId || typeof evId !== "string") {
        return res.status(400).json({ ok: false, error: "evId is required" });
      }
      if (typeof powerRequired !== "number" || Number.isNaN(powerRequired)) {
        return res
          .status(400)
          .json({ ok: false, error: "powerRequired must be a number" });
      }

      const expiresAt = new Date(
        Date.now() + hours * 60 * 60 * 1000
      ).toISOString();

      //create session in Supabase
      const { data: session, error: sErr } = await supabase
        .from("charging_sessions")
        .insert({
          ev_id: evId,
          power_required: powerRequired,
          power_consumed: 0,
          cost: 0,
          status: "active",
          expires_at: expiresAt,
        })
        .select(
          "session_id, ev_id, power_required, power_consumed, cost, status, expires_at"
        )
        .single();

      if (sErr || !session) {
        return res.status(500).json({
          ok: false,
          error: sErr?.message || "Failed to create session",
        });
      }

      //create resume token
      const resumeToken = generateResumeToken();
      const tokenHash = hashToken(resumeToken);

      const { error: tErr } = await supabase
        .from("session_resume_tokens")
        .insert({
          session_id: session.session_id,
          token_hash: tokenHash,
          expires_at: expiresAt,
          revoked_at: null,
        });

      if (tErr) {
        return res.status(500).json({ ok: false, error: tErr.message });
      }

      //queue ledger write
      const { queued, queueId } = await queueLedgerEvent(
        session.session_id,
        evId,
        "SessionStarted",
        { evId, powerRequired, expiresAt, tokenHash }
      );

      //emit event
      emit(broadcast, "SessionStarted", {
        eventType: "SessionStarted",
        sessionId: session.session_id,
        evId,
        powerRequired,
        expiresAt,
        status: "active",
        queued,
        queueId,
      });

      const duration = Date.now() - startTime;
      console.log(
        `[START] ${session.session_id} completed in ${duration}ms (queued: ${queued})`
      );

      return res.json({
        ok: true,
        session: {
          evId: session.ev_id,
          sessionId: session.session_id,
          powerRequired: session.power_required,
          powerConsumed: session.power_consumed,
          cost: session.cost,
          status: session.status,
          expiresAt: session.expires_at,
        },
        resumeToken,
        txId: "pending",
        queueId,
      });
    } catch (e: any) {
      return res
        .status(500)
        .json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  //pause session
  router.post("/pause", async (req: Request, res: Response) => {
    try {
      const { evId, sessionId } = req.body as {
        evId?: string;
        sessionId?: string;
      };

      if (!evId || typeof evId !== "string") {
        return res.status(400).json({ ok: false, error: "evId is required" });
      }
      if (!sessionId || typeof sessionId !== "string") {
        return res
          .status(400)
          .json({ ok: false, error: "sessionId is required" });
      }

      const session = await getSessionCached(sessionId, evId);

      if (!session) {
        return res.status(404).json({ ok: false, error: "Session not found" });
      }

      if (isTerminal(session.status)) {
        return res
          .status(400)
          .json({ ok: false, error: `Session already ${session.status}` });
      }

      if (!isActive(session.status)) {
        return res.status(400).json({
          ok: false,
          error: `Session is ${session.status} - already paused/disconnected`,
        });
      }

      if (isExpired(session.expires_at)) {
        await supabase
          .from("charging_sessions")
          .update({ status: "expired" })
          .eq("session_id", sessionId);
        invalidateSessionCache(sessionId, evId);
        return res.status(410).json({ ok: false, error: "Session expired" });
      }

      const { data: updated, error: uErr } = await supabase
        .from("charging_sessions")
        .update({ status: "disconnected" })
        .eq("session_id", sessionId)
        .eq("ev_id", evId)
        .select(
          "session_id, ev_id, power_required, power_consumed, cost, status, expires_at"
        )
        .single();

      if (uErr || !updated) {
        return res.status(500).json({
          ok: false,
          error: uErr?.message || "Failed to pause session",
        });
      }

      invalidateSessionCache(sessionId, evId);

      //queue ledger write
      const { queued, queueId } = await queueLedgerEvent(
        sessionId,
        evId,
        "SessionPaused",
        { evId }
      );

      emit(broadcast, "SessionPaused", {
        eventType: "SessionPaused",
        sessionId,
        evId,
        status: "disconnected",
        queued,
        queueId,
      });

      return res.json({
        ok: true,
        session: {
          evId: updated.ev_id,
          sessionId: updated.session_id,
          powerRequired: updated.power_required,
          powerConsumed: updated.power_consumed,
          cost: updated.cost,
          status: updated.status,
          expiresAt: updated.expires_at,
        },
        txId: "pending",
        queueId,
      });
    } catch (e: any) {
      return res
        .status(500)
        .json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  //resume session
  router.post("/resume", async (req: Request, res: Response) => {
    try {
      const { evId, sessionId, resumeToken } = req.body as {
        evId?: string;
        sessionId?: string;
        resumeToken?: string;
      };

      if (!evId || typeof evId !== "string") {
        return res.status(400).json({ ok: false, error: "evId is required" });
      }
      if (!sessionId || typeof sessionId !== "string") {
        return res
          .status(400)
          .json({ ok: false, error: "sessionId is required" });
      }
      if (!resumeToken || typeof resumeToken !== "string") {
        return res
          .status(400)
          .json({ ok: false, error: "resumeToken is required" });
      }

      const session = await getSessionCached(sessionId, evId);

      if (!session) {
        return res.status(404).json({ ok: false, error: "Session not found" });
      }

      if (isTerminal(session.status)) {
        return res.status(400).json({
          ok: false,
          error: `Session is ${session.status} - cannot resume a terminated session`,
        });
      }

      if (isActive(session.status)) {
        return res.status(400).json({
          ok: false,
          error: `Session is already ${session.status} - no need to resume`,
        });
      }

      if (!isResumable(session.status)) {
        return res.status(400).json({
          ok: false,
          error: `Session status "${session.status}" does not allow resumption`,
        });
      }

      if (isExpired(session.expires_at)) {
        await supabase
          .from("charging_sessions")
          .update({ status: "expired" })
          .eq("session_id", sessionId);
        invalidateSessionCache(sessionId, evId);

        await queueLedgerEvent(sessionId, evId, "SessionExpired", { evId });
        emit(broadcast, "SessionExpired", {
          eventType: "SessionExpired",
          sessionId,
          evId,
          status: "expired",
        });

        return res.status(410).json({ ok: false, error: "Session expired" });
      }

      //validate resume token
      const tokenHash = hashToken(resumeToken);
      const { data: tokenRow, error: tErr } = await supabase
        .from("session_resume_tokens")
        .select("id, expires_at, revoked_at")
        .eq("session_id", sessionId)
        .eq("token_hash", tokenHash)
        .is("revoked_at", null)
        .single();

      if (tErr || !tokenRow) {
        return res
          .status(401)
          .json({ ok: false, error: "Invalid or revoked token" });
      }

      if (isExpired(tokenRow.expires_at)) {
        return res.status(401).json({ ok: false, error: "Token expired" });
      }

      //generate new token and revoke old
      const newToken = generateResumeToken();
      const newHash = hashToken(newToken);

      await supabase
        .from("session_resume_tokens")
        .update({ revoked_at: nowIso() })
        .eq("id", tokenRow.id);

      const { error: insErr } = await supabase
        .from("session_resume_tokens")
        .insert({
          session_id: sessionId,
          token_hash: newHash,
          expires_at: session.expires_at,
          revoked_at: null,
        });

      if (insErr) {
        return res.status(500).json({ ok: false, error: insErr.message });
      }

      const { data: updated, error: uErr } = await supabase
        .from("charging_sessions")
        .update({ status: "active" })
        .eq("session_id", sessionId)
        .eq("ev_id", evId)
        .select(
          "session_id, ev_id, power_required, power_consumed, cost, status, expires_at"
        )
        .single();

      if (uErr || !updated) {
        return res.status(500).json({
          ok: false,
          error: uErr?.message || "Failed to resume session",
        });
      }

      invalidateSessionCache(sessionId, evId);

      //queue ledger write
      const { queued, queueId } = await queueLedgerEvent(
        sessionId,
        evId,
        "SessionResumed",
        { evId }
      );

      emit(broadcast, "SessionResumed", {
        eventType: "SessionResumed",
        sessionId,
        evId,
        status: "active",
        queued,
        queueId,
      });

      return res.json({
        ok: true,
        session: {
          evId: updated.ev_id,
          sessionId: updated.session_id,
          powerRequired: updated.power_required,
          powerConsumed: updated.power_consumed,
          cost: updated.cost,
          status: updated.status,
          expiresAt: updated.expires_at,
        },
        resumeToken: newToken,
        txId: "pending",
        queueId,
      });
    } catch (e: any) {
      return res
        .status(500)
        .json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  //stop session
  router.post("/stop", async (req: Request, res: Response) => {
    try {
      const { evId, sessionId } = req.body as {
        evId?: string;
        sessionId?: string;
      };

      if (!evId || typeof evId !== "string") {
        return res.status(400).json({ ok: false, error: "evId is required" });
      }
      if (!sessionId || typeof sessionId !== "string") {
        return res
          .status(400)
          .json({ ok: false, error: "sessionId is required" });
      }

      const session = await getSessionCached(sessionId, evId);

      if (!session) {
        return res.status(404).json({ ok: false, error: "Session not found" });
      }

      if (isTerminal(session.status)) {
        return res
          .status(400)
          .json({ ok: false, error: `Session already ${session.status}` });
      }

      if (isExpired(session.expires_at)) {
        await supabase
          .from("charging_sessions")
          .update({ status: "expired" })
          .eq("session_id", sessionId);
        invalidateSessionCache(sessionId, evId);

        await queueLedgerEvent(sessionId, evId, "SessionExpired", { evId });
        emit(broadcast, "SessionExpired", {
          eventType: "SessionExpired",
          sessionId,
          evId,
          status: "expired",
        });

        return res.status(410).json({ ok: false, error: "Session expired" });
      }

      const { data: updated, error: uErr } = await supabase
        .from("charging_sessions")
        .update({ status: "stopped" })
        .eq("session_id", sessionId)
        .eq("ev_id", evId)
        .select(
          "session_id, ev_id, power_required, power_consumed, cost, status, expires_at"
        )
        .single();

      if (uErr || !updated) {
        return res.status(500).json({
          ok: false,
          error: uErr?.message || "Failed to stop session",
        });
      }

      //revoke all resume tokens
      await supabase
        .from("session_resume_tokens")
        .update({ revoked_at: nowIso() })
        .eq("session_id", sessionId)
        .is("revoked_at", null);

      invalidateSessionCache(sessionId, evId);

      //queue ledger write
      const { queued, queueId } = await queueLedgerEvent(
        sessionId,
        evId,
        "SessionStopped",
        {
          evId,
          finalStatus: "stopped",
        }
      );

      emit(broadcast, "SessionStopped", {
        eventType: "SessionStopped",
        sessionId,
        evId,
        status: "stopped",
        queued,
        queueId,
      });

      return res.json({
        ok: true,
        session: {
          evId: updated.ev_id,
          sessionId: updated.session_id,
          powerRequired: updated.power_required,
          powerConsumed: updated.power_consumed,
          cost: updated.cost,
          status: updated.status,
          expiresAt: updated.expires_at,
        },
        txId: "pending",
        queueId,
      });
    } catch (e: any) {
      return res
        .status(500)
        .json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  return router;
}
