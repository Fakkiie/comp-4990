import { Router } from "express";
import { supabase } from "../lib/supabase";

export const healthRouter = Router();

healthRouter.get("/db", async (_req, res) => {
  const { error } = await supabase
    .from("charging_sessions")
    .select("session_id")
    .limit(1);
  if (error) {
    return res
      .status(500)
      .json({
        ok: false,
        db: "supabase",
        error: error.message,
        hint: error.hint ?? null,
      });
  }
  return res.json({ ok: true, db: "supabase" });
});
