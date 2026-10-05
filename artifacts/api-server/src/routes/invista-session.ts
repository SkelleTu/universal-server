import { Router } from "express";
import { invistaSessionManager, type TradingMode } from "../lib/invista-session-manager";

const router = Router();

function serviceKeyOk(req: any) {
  const configured = process.env.INVISTA_UNIVERSAL_SERVER_KEY;
  if (!configured) return process.env.NODE_ENV !== "production";
  const supplied = String(req.header("x-invista-server-key") || "");
  return supplied.length > 0 && supplied === configured;
}

router.post("/invista/session/register", (req, res) => {
  if (!serviceKeyOk(req)) return res.status(401).json({ error: "unauthorized" });
  const { userId, platform } = req.body || {};
  if (!userId || !["main", "aura"].includes(platform)) {
    return res.status(400).json({ error: "userId and platform are required" });
  }
  const session = invistaSessionManager.register(String(userId), platform as TradingMode);
  res.json({ ok: true, session });
});

router.post("/invista/session/heartbeat", (req, res) => {
  if (!serviceKeyOk(req)) return res.status(401).json({ error: "unauthorized" });
  const { sessionId, userId, platform, tradingArmed } = req.body || {};
  if (!sessionId || !userId || !["main", "aura"].includes(platform)) {
    return res.status(400).json({ error: "sessionId, userId and platform are required" });
  }
  const session = invistaSessionManager.heartbeat(
    String(sessionId), String(userId), platform as TradingMode,
    typeof tradingArmed === "boolean" ? tradingArmed : undefined,
  );
  if (!session) return res.status(404).json({ error: "session_not_found" });
  res.json({ ok: true, session });
});

router.post("/invista/session/arm", (req, res) => {
  if (!serviceKeyOk(req)) return res.status(401).json({ error: "unauthorized" });
  const { sessionId, userId, armed } = req.body || {};
  if (!sessionId || !userId || typeof armed !== "boolean") {
    return res.status(400).json({ error: "sessionId, userId and armed are required" });
  }
  const session = invistaSessionManager.setTradingArmed(String(sessionId), String(userId), armed);
  if (!session) return res.status(404).json({ error: "session_not_found" });
  res.json({ ok: true, session });
});

router.post("/invista/session/disconnect", (req, res) => {
  if (!serviceKeyOk(req)) return res.status(401).json({ error: "unauthorized" });
  const { sessionId, userId } = req.body || {};
  if (!sessionId || !userId) return res.status(400).json({ error: "sessionId and userId are required" });
  const ok = invistaSessionManager.disconnect(String(sessionId), String(userId));
  res.json({ ok });
});

router.get("/invista/sessions", (req, res) => {
  if (!serviceKeyOk(req)) return res.status(401).json({ error: "unauthorized" });
  res.json({ ok: true, sessions: invistaSessionManager.list() });
});

export default router;
