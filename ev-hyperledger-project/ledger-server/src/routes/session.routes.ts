import { Router, Request, Response } from "express";
import { supabase } from "../lib/supabase";
import { generateResumeToken, hashToken } from "../lib/tokens";
import { logLedgerEvent } from "../lib/fabricLogger";

type ContractRef = { get: () => any | null };
type Broadcaster = (data: any) => void;

function nowIso() {
  return new Date().toISOString();
}

function isExpired(expiresAt: string): boolean {
  return Date.now() >= new Date(expiresAt).getTime();
}

async function expireIfNeeded(sessionId: string, expiresAt: string) {
  if (!isExpired(expiresAt)) return false;

  await supabase
    .from("charging_sessions")
    .update({ status: "expired" })
    .eq("session_id", sessionId);

  return true;
}

/**
 * Emit SSE in the exact shape your UI already expects:
 * { eventName, txId, payload: { timestamp, txId, payload: string } }
 */
function emit(broadcast: Broadcaster | undefined, eventName: string, txId: string | null, obj: any) {
  broadcast?.({
    eventName,
    txId: txId ?? "",
    payload: {
      timestamp: new Date().toISOString(),
      txId: txId ?? "",
      payload: JSON.stringify(obj),
    },
  });
}

export function createSessionsRouter(
  contractRef: ContractRef,
  broadcast?: Broadcaster
) {
  const router = Router();

  /** POST /api/sessions/start */
  router.post("/start", async (req: Request, res: Response) => {
    try {
      const { evId, powerRequired, hours = 6 } = req.body as {
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

      const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

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

      const resumeToken = generateResumeToken();
      const tokenHash = hashToken(resumeToken);

      const { error: tErr } = await supabase.from("session_resume_tokens").insert({
        session_id: session.session_id,
        token_hash: tokenHash,
        expires_at: expiresAt,
        revoked_at: null,
      });

      if (tErr) {
        return res.status(500).json({ ok: false, error: tErr.message });
      }

      const { txId, eventKey } = await logLedgerEvent({
        contract: contractRef.get(),
        sessionId: session.session_id,
        eventType: "SessionStarted",
        payload: { evId, powerRequired, expiresAt, tokenHash },
      });

      emit(broadcast, "SessionStarted", txId, {
        eventType: "SessionStarted",
        sessionId: session.session_id,
        evId,
        powerRequired,
        expiresAt,
        eventKey,
      });

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
        txId,
        eventKey,
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  /** POST /api/sessions/stop */
  router.post("/stop", async (req: Request, res: Response) => {
    try {
      const { evId, sessionId } = req.body as { evId?: string; sessionId?: string };

      if (!evId || typeof evId !== "string") {
        return res.status(400).json({ ok: false, error: "evId is required" });
      }
      if (!sessionId || typeof sessionId !== "string") {
        return res.status(400).json({ ok: false, error: "sessionId is required" });
      }

      const { data: session, error: sErr } = await supabase
        .from("charging_sessions")
        .select(
          "session_id, ev_id, power_required, power_consumed, cost, status, expires_at"
        )
        .eq("session_id", sessionId)
        .eq("ev_id", evId)
        .single();

      if (sErr || !session) {
        return res.status(404).json({ ok: false, error: "Session not found" });
      }

      const expired = await expireIfNeeded(sessionId, session.expires_at);
      if (expired) {
        const { txId, eventKey } = await logLedgerEvent({
          contract: contractRef.get(),
          sessionId,
          eventType: "SessionExpired",
          payload: { evId },
        });

        emit(broadcast, "SessionExpired", txId, {
          eventType: "SessionExpired",
          sessionId,
          evId,
          eventKey,
        });

        return res.status(410).json({
          ok: false,
          error: "Session expired",
          txId,
          eventKey,
        });
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
          error: uErr?.message || "Failed to stop session",
        });
      }

      const { txId, eventKey } = await logLedgerEvent({
        contract: contractRef.get(),
        sessionId,
        eventType: "SessionStopped",
        payload: { evId },
      });

      emit(broadcast, "SessionStopped", txId, {
        eventType: "SessionStopped",
        sessionId,
        evId,
        eventKey,
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
        txId,
        eventKey,
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  /** POST /api/sessions/resume */
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
        return res.status(400).json({ ok: false, error: "sessionId is required" });
      }
      if (!resumeToken || typeof resumeToken !== "string") {
        return res.status(400).json({ ok: false, error: "resumeToken is required" });
      }

      const { data: session, error: sErr } = await supabase
        .from("charging_sessions")
        .select(
          "session_id, ev_id, power_required, power_consumed, cost, status, expires_at"
        )
        .eq("session_id", sessionId)
        .eq("ev_id", evId)
        .single();

      if (sErr || !session) {
        return res.status(404).json({ ok: false, error: "Session not found" });
      }

      const expired = await expireIfNeeded(sessionId, session.expires_at);
      if (expired) {
        const { txId, eventKey } = await logLedgerEvent({
          contract: contractRef.get(),
          sessionId,
          eventType: "SessionExpired",
          payload: { evId },
        });

        emit(broadcast, "SessionExpired", txId, {
          eventType: "SessionExpired",
          sessionId,
          evId,
          eventKey,
        });

        return res.status(410).json({
          ok: false,
          error: "Session expired",
          txId,
          eventKey,
        });
      }

      const tokenHash = hashToken(resumeToken);

      const { data: tokenRow, error: tErr } = await supabase
        .from("session_resume_tokens")
        .select("id, expires_at, revoked_at")
        .eq("session_id", sessionId)
        .eq("token_hash", tokenHash)
        .is("revoked_at", null)
        .single();

      if (tErr || !tokenRow) {
        return res.status(401).json({ ok: false, error: "Invalid token" });
      }
      if (isExpired(tokenRow.expires_at)) {
        return res.status(401).json({ ok: false, error: "Token expired" });
      }

      // rotate token
      const newToken = generateResumeToken();
      const newHash = hashToken(newToken);

      await supabase.from("session_resume_tokens").update({ revoked_at: nowIso() }).eq("id", tokenRow.id);

      const { error: insErr } = await supabase.from("session_resume_tokens").insert({
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
        return res.status(500).json({ ok: false, error: uErr?.message || "Failed to resume session" });
      }

      const { txId, eventKey } = await logLedgerEvent({
        contract: contractRef.get(),
        sessionId,
        eventType: "SessionResumed",
        payload: { evId },
      });

      emit(broadcast, "SessionResumed", txId, {
        eventType: "SessionResumed",
        sessionId,
        evId,
        eventKey,
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
        txId,
        eventKey,
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  return router;
}
