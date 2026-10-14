import { Router } from "express";
import { invistaSessionManager, type TradingMode } from "../lib/invista-session-manager";
import { consumeInvistaLaunchTicket, issueInvistaLaunchTicket } from "../lib/invista-launch-tickets";

const router = Router();

function serviceKeyOk(req: Parameters<import("express").RequestHandler>[0]) {
  const configured = process.env.INVISTA_UNIVERSAL_SERVER_KEY;
  if (!configured) return process.env.NODE_ENV !== "production";
  const supplied = String(req.header("x-invista-server-key") || "");
  return supplied.length > 0 && supplied === configured;
}

router.post("/invista/session/register", (req, res): void => {
  if (!serviceKeyOk(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  const { userId, platform } = req.body || {};
  if (!userId || !["main", "aura"].includes(platform)) { res.status(400).json({ error: "userId and platform are required" }); return; }
  const session = invistaSessionManager.register(String(userId), platform as TradingMode);
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

/**
 * Internal service-to-service endpoint. Only a trusted platform backend may
 * request a launch ticket, and only for a currently healthy user session.
 * The returned ticket is single-use and expires quickly.
 */
router.post("/invista/session/launch-ticket", (req, res): void => {
  if (!serviceKeyOk(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  const userId = String(req.body?.userId ?? "").trim();
  const platform = String(req.body?.platform ?? "") as TradingMode;
  if (!userId || !["main", "aura"].includes(platform)) {
    res.status(400).json({ error: "userId and platform are required" }); return;
  }
  const active = invistaSessionManager.list().find(
    (session) => session.userId === userId && session.platform === platform && session.healthy,
  );
  if (!active) { res.status(404).json({ error: "active_session_not_found" }); return; }
  const issued = issueInvistaLaunchTicket(userId, platform);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, ...issued, platform });
});

/**
 * Internal service-to-service exchange. The platform must immediately create
 * its own normal server-side login session for the returned user. Never expose
 * this endpoint directly to a browser; the single-use ticket is the only
 * browser-carried secret and is consumed atomically.
 */
router.post("/invista/session/consume-ticket", (req, res): void => {
  if (!serviceKeyOk(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  const ticket = String(req.body?.ticket ?? "");
  const session = consumeInvistaLaunchTicket(ticket);
  res.setHeader("Cache-Control", "no-store");
  if (!session) { res.status(401).json({ error: "invalid_or_expired_ticket" }); return; }
  res.json({ ok: true, ...session });
});

router.get("/invista/sessions", (req, res): void => {
  if (!serviceKeyOk(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  res.json({ ok: true, sessions: invistaSessionManager.list() });
});

export default router;
