import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { pgDeleteGameCache, pgGetGameCache, pgGetOrCreateSystemProject, pgUpsertGameCache } from "../lib/pglite";
import { invistaSessionManager, type TradingMode } from "../lib/invista-session-manager";

const router = Router();
const COLLECTION = "invista-browser-access";
const GRANT_TTL_MS = 120_000;
const redeeming = new Set<string>();

function serviceAuthorized(req: Request): boolean {
  const expected = String(process.env.INVISTA_UNIVERSAL_SERVER_KEY ?? "").trim();
  const supplied = String(req.header("x-invista-server-key") ?? "").trim();
  return Boolean(expected && supplied && supplied === expected);
}
function hashGrant(grant: string): string {
  return crypto.createHash("sha256").update(grant).digest("hex");
}
function platformOrigin(platform: string): string {
  const configured = platform === "aura" ? process.env.INVISTA_AURA_URL : process.env.INVISTA_MAIN_URL;
  const fallback = platform === "aura"
    ? "https://invista-pro-v10-aura-system-style-d6jw.onrender.com"
    : "https://invista-pro-v10-kzlv.onrender.com";
  const raw = String(configured ?? fallback).trim();
  const url = new URL(raw);
  if (process.env.NODE_ENV === "production") {
    if (url.protocol !== "https:") throw new Error("Platform URL must use HTTPS in production.");
    if (url.origin !== new URL(fallback).origin) throw new Error("Platform URL origin is not in the production allowlist.");
  }
  return url.origin;
}

// A user may explicitly enable persistent Browser Use delegation once. This does not
// expose the Deriv token; each browser launch still receives a fresh one-time grant.
router.post("/invista/browser-access/delegations", async (req: Request, res: Response): Promise<void> => {
  if (!serviceAuthorized(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }
  const userId = String(req.body?.userId ?? "").trim();
  const userEmail = String(req.body?.userEmail ?? "").trim().toLowerCase();
  const platform = String(req.body?.platform ?? "").trim(); // target platform
  const sourcePlatform = String(req.body?.sourcePlatform ?? platform).trim();
  if (!userId || !userEmail.includes("@") || !["main", "aura"].includes(platform) || !["main", "aura"].includes(sourcePlatform)) {
    res.status(400).json({ ok: false, error: "userId, verified userEmail, sourcePlatform and target platform are required" }); return;
  }
  if (req.body?.userConsented !== true) { res.status(403).json({ ok: false, error: "explicit_user_consent_required" }); return; }
  const active = invistaSessionManager.getActive(userId, sourcePlatform as TradingMode);
  if (!active || active.userEmail !== userEmail) {
    res.status(409).json({ ok: false, error: "verified_active_master_session_required" }); return;
  }
  const project = await pgGetOrCreateSystemProject();
  const key = `delegation:${platform}:${userEmail}`;
  await pgUpsertGameCache(project.id, COLLECTION, key, {
    userId, userEmail, platform, sourcePlatform, sourceSessionId: active.sessionId, enabled: true,
    consentedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, null);
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.json({ ok: true, enabled: true, platform, consentedAt: new Date().toISOString() });
});

router.delete("/invista/browser-access/delegations/:platform/:userEmail", async (req: Request, res: Response): Promise<void> => {
  if (!serviceAuthorized(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }
  const platform = String(req.params.platform ?? "");
  const userEmail = decodeURIComponent(String(req.params.userEmail ?? "")).trim().toLowerCase();
  if (!["main", "aura"].includes(platform) || !userEmail.includes("@")) {
    res.status(400).json({ ok: false, error: "valid platform and email are required" }); return;
  }
  const project = await pgGetOrCreateSystemProject();
  await pgDeleteGameCache(project.id, COLLECTION, `delegation:${platform}:${userEmail}`);
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.json({ ok: true, revoked: true });
});

// Only the authenticated platform backend may issue a grant. Grants are opaque,
// hashed at rest, short-lived, one-use, and scoped to one platform and user.
router.post("/invista/browser-access/grants", async (req: Request, res: Response): Promise<void> => {
  if (!serviceAuthorized(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }
  const userId = String(req.body?.userId ?? "").trim();
  const platform = String(req.body?.platform ?? "").trim();
  const consent = req.body?.userConsented === true;
  if (!userId || !["main", "aura"].includes(platform)) { res.status(400).json({ ok: false, error: "userId and platform are required" }); return; }
  if (!consent) { res.status(403).json({ ok: false, error: "explicit_user_consent_required" }); return; }
  const activeSession = invistaSessionManager.getActive(userId, platform as TradingMode);
  if (!activeSession || !activeSession.userEmail || !activeSession.userEmail.includes("@")) {
    res.status(409).json({ ok: false, error: "source_platform_session_with_verified_email_required" });
    return;
  }
  const grant = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + GRANT_TTL_MS).toISOString();
  const project = await pgGetOrCreateSystemProject();
  await pgUpsertGameCache(project.id, COLLECTION, hashGrant(grant), {
    userId,
    userEmail: activeSession.userEmail.trim().toLowerCase(),
    platform,
    sessionId: activeSession.sessionId,
    delegationRequired: false,
    createdAt: new Date().toISOString(),
  }, expiresAt);
  let launchUrl: string;
  try { launchUrl = `${platformOrigin(platform)}/api/auth/universal-exchange?grant=${encodeURIComponent(grant)}`; }
  catch { await pgDeleteGameCache(project.id, COLLECTION, hashGrant(grant)); res.status(503).json({ ok: false, error: "platform_origin_not_configured" }); return; }
  res.status(201).json({ ok: true, grant, launchUrl, expiresAt, oneTime: true });
});

// MCP uses this server-to-server endpoint to request a fresh one-time launch URL
// for an account that has explicitly enabled persistent delegation.
router.post("/invista/browser-access/agent-launch", async (req: Request, res: Response): Promise<void> => {
  if (!serviceAuthorized(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }
  const userEmail = String(req.body?.userEmail ?? "").trim().toLowerCase();
  const platform = String(req.body?.platform ?? "").trim(); // target platform
  const sourcePlatform = String(req.body?.sourcePlatform ?? platform).trim();
  if (!userEmail.includes("@") || !["main", "aura"].includes(platform) || !["main", "aura"].includes(sourcePlatform)) {
    res.status(400).json({ ok: false, error: "userEmail, sourcePlatform and target platform are required" }); return;
  }
  const project = await pgGetOrCreateSystemProject();
  const delegation = await pgGetGameCache(project.id, COLLECTION, `delegation:${platform}:${userEmail}`);
  if (!delegation || delegation.data?.enabled !== true || delegation.data?.userEmail !== userEmail) {
    res.status(403).json({ ok: false, error: "persistent_browser_delegation_not_enabled" }); return;
  }
  const activeSession = invistaSessionManager.getActiveByEmail(userEmail, sourcePlatform as TradingMode);
  if (!activeSession || activeSession.userId !== String(delegation.data.userId ?? "")) {
    res.status(409).json({ ok: false, error: "delegated_master_session_not_active" }); return;
  }
  const grant = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + GRANT_TTL_MS).toISOString();
  await pgUpsertGameCache(project.id, COLLECTION, hashGrant(grant), {
    userId: activeSession.userId, userEmail, platform, sourcePlatform, sessionId: activeSession.sessionId,
    createdAt: new Date().toISOString(),
  }, expiresAt);
  let launchUrl: string;
  try { launchUrl = `${platformOrigin(platform)}/api/auth/universal-exchange?grant=${encodeURIComponent(grant)}`; }
  catch { await pgDeleteGameCache(project.id, COLLECTION, hashGrant(grant)); res.status(503).json({ ok: false, error: "platform_origin_not_configured" }); return; }
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.json({ ok: true, launchUrl, expiresAt, oneTime: true, platform });
});

// Server-to-server redemption only. The grant is deleted before returning identity,
// so replaying the same link cannot create a second authenticated browser session.
router.post("/invista/browser-access/redeem", async (req: Request, res: Response): Promise<void> => {
  if (!serviceAuthorized(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }
  const grant = String(req.body?.grant ?? "").trim();
  if (grant.length < 32 || grant.length > 256) { res.status(400).json({ ok: false, error: "invalid_grant" }); return; }
  const key = hashGrant(grant);
  if (redeeming.has(key)) { res.status(401).json({ ok: false, error: "grant_expired_or_used" }); return; }
  redeeming.add(key);
  try {
    const project = await pgGetOrCreateSystemProject();
    const stored = await pgGetGameCache(project.id, COLLECTION, key);
    if (!stored) { res.status(401).json({ ok: false, error: "grant_expired_or_used" }); return; }
    // Consume before revealing identity. The in-process lock closes the concurrent
    // double-redemption window for this single active service instance.
    await pgDeleteGameCache(project.id, COLLECTION, key);
    const userId = String(stored.data.userId ?? "");
    const platform = String(stored.data.platform ?? ""); // target platform
    const sourcePlatform = String(stored.data.sourcePlatform ?? platform);
    const sessionId = String(stored.data.sessionId ?? "");
    const userEmail = String(stored.data.userEmail ?? "").trim().toLowerCase();
    if (!userId || !["main", "aura"].includes(platform) || !["main", "aura"].includes(sourcePlatform) || !sessionId || !userEmail.includes("@")) {
      res.status(401).json({ ok: false, error: "invalid_grant_payload" });
      return;
    }
    const activeSession = invistaSessionManager.getActive(userId, sourcePlatform as TradingMode);
    if (!activeSession || activeSession.sessionId !== sessionId || activeSession.userEmail !== userEmail) {
      res.status(401).json({ ok: false, error: "master_source_session_inactive" });
      return;
    }
    // Persistent MCP launches require an enabled delegation. A one-time grant
    // minted by the explicitly consented /grants endpoint is separately scoped
    // to that source session and does not imply persistent delegation.
    if (stored.data.delegationRequired !== false) {
      const delegation = await pgGetGameCache(project.id, COLLECTION, `delegation:${platform}:${userEmail}`);
      if (delegation?.data?.enabled !== true || delegation.data.userId !== userId) {
        res.status(401).json({ ok: false, error: "browser_delegation_revoked" });
        return;
      }
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json({ ok: true, userId, userEmail, platform, sourcePlatform, sessionId, redeemedAt: new Date().toISOString() });
  } finally {
    redeeming.delete(key);
  }
});

export default router;
