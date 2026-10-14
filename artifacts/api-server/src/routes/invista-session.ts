import { Router } from "express";
import { invistaSessionManager, type TradingMode } from "../lib/invista-session-manager";

const router = Router();

function serviceKeyOk(req: Parameters<import("express").RequestHandler>[0]) {
  const configured = process.env.INVISTA_UNIVERSAL_SERVER_KEY;
  if (!configured) return process.env.NODE_ENV !== "production";
  const supplied = String(req.header("x-invista-server-key") || "");
  return supplied.length > 0 && supplied === configured;
}

router.post("/invista/session/register", (req, res): void => {
  if (!serviceKeyOk(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  const { userId, platform, userEmail } = req.body || {};
  if (!userId || !["main", "aura"].includes(platform)) { res.status(400).json({ error: "userId and platform are required" }); return; }
  const email = typeof userEmail === "string" && userEmail.includes("@") ? userEmail.trim().toLowerCase() : undefined;
  const session = invistaSessionManager.register(String(userId), platform as TradingMode, email);
  res.json({ ok: true, session });
});

router.post("/invista/session/heartbeat", (req, res): void => {
  if (!serviceKeyOk(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  const { sessionId, userId, platform, tradingArmed } = req.body || {};
  if (!sessionId || !userId || !["main", "aura"].includes(platform)) { res.status(400).json({ error: "sessionId, userId and platform are required" }); return; }
  const session = invistaSessionManager.heartbeat(
    String(sessionId), String(userId), platform as TradingMode,
    typeof tradingArmed === "boolean" ? tradingArmed : undefined,
  );
  if (!session) { res.status(404).json({ error: "session_not_found" }); return; }
  res.json({ ok: true, session });
});

router.post("/invista/session/arm", (req, res): void => {
  if (!serviceKeyOk(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  const { sessionId, userId, armed } = req.body || {};
  if (!sessionId || !userId || typeof armed !== "boolean") { res.status(400).json({ error: "sessionId, userId and armed are required" }); return; }
  const session = invistaSessionManager.setTradingArmed(String(sessionId), String(userId), armed);
  if (!session) { res.status(404).json({ error: "session_not_found" }); return; }
  res.json({ ok: true, session });
});

router.post("/invista/session/disconnect", (req, res): void => {
  if (!serviceKeyOk(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  const { sessionId, userId } = req.body || {};
  if (!sessionId || !userId) { res.status(400).json({ error: "sessionId and userId are required" }); return; }
  const ok = invistaSessionManager.disconnect(String(sessionId), String(userId));
  res.json({ ok });
});

router.get("/invista/session/remote-status", (req, res): void => {
  if (!serviceKeyOk(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }
  const sessionId = String(req.query.sessionId ?? "");
  const userId = String(req.query.userId ?? "");
  const platform = String(req.query.platform ?? "");
  if (!sessionId || !userId || !["main", "aura"].includes(platform)) {
    res.status(400).json({ ok: false, error: "sessionId, userId and platform are required", active: false });
    return;
  }
  const active = invistaSessionManager.getActive(userId, platform as TradingMode);
  const matches = Boolean(active && active.sessionId === sessionId);
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.json({ ok: true, active: matches, checkedAt: new Date().toISOString() });
});

router.get("/invista/sessions", (req, res): void => {
  if (!serviceKeyOk(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  res.json({ ok: true, sessions: invistaSessionManager.list() });
});

export default router;
