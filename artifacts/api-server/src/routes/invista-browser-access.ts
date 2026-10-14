import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { pgDeleteGameCache, pgGetGameCache, pgGetOrCreateSystemProject, pgUpsertGameCache } from "../lib/pglite";

const router = Router();
const COLLECTION = "invista-browser-access";
const GRANT_TTL_MS = 120_000;

function serviceAuthorized(req: Request): boolean {
  const expected = String(process.env.INVISTA_UNIVERSAL_SERVER_KEY ?? "").trim();
  const supplied = String(req.header("x-invista-server-key") ?? "").trim();
  return Boolean(expected && supplied && supplied === expected);
}
function hashGrant(grant: string): string {
  return crypto.createHash("sha256").update(grant).digest("hex");
}
function platformOrigin(platform: string): string {
  const raw = platform === "aura" ? process.env.INVISTA_AURA_URL : process.env.INVISTA_MAIN_URL;
  if (!raw) throw new Error(`Missing platform URL for ${platform}`);
  const url = new URL(raw);
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") throw new Error("Platform URL must use HTTPS in production.");
  return url.origin;
}

// Only the authenticated platform backend may issue a grant. Grants are opaque,
// hashed at rest, short-lived, one-use, and scoped to one platform and user.
router.post("/invista/browser-access/grants", async (req: Request, res: Response): Promise<void> => {
  if (!serviceAuthorized(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }
  const userId = String(req.body?.userId ?? "").trim();
  const platform = String(req.body?.platform ?? "").trim();
  const consent = req.body?.userConsented === true;
  if (!userId || !["main", "aura"].includes(platform)) { res.status(400).json({ ok: false, error: "userId and platform are required" }); return; }
  if (!consent) { res.status(403).json({ ok: false, error: "explicit_user_consent_required" }); return; }
  const grant = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + GRANT_TTL_MS).toISOString();
  const project = await pgGetOrCreateSystemProject();
  await pgUpsertGameCache(project.id, COLLECTION, hashGrant(grant), { userId, platform, createdAt: new Date().toISOString() }, expiresAt);
  let launchUrl: string;
  try { launchUrl = `${platformOrigin(platform)}/api/auth/universal-exchange?grant=${encodeURIComponent(grant)}`; }
  catch { await pgDeleteGameCache(project.id, COLLECTION, hashGrant(grant)); res.status(503).json({ ok: false, error: "platform_origin_not_configured" }); return; }
  res.status(201).json({ ok: true, grant, launchUrl, expiresAt, oneTime: true });
});

// Server-to-server redemption only. The grant is deleted before returning identity,
// so replaying the same link cannot create a second authenticated browser session.
router.post("/invista/browser-access/redeem", async (req: Request, res: Response): Promise<void> => {
  if (!serviceAuthorized(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }
  const grant = String(req.body?.grant ?? "").trim();
  if (grant.length < 32 || grant.length > 256) { res.status(400).json({ ok: false, error: "invalid_grant" }); return; }
  const project = await pgGetOrCreateSystemProject();
  const key = hashGrant(grant);
  const stored = await pgGetGameCache(project.id, COLLECTION, key);
  if (!stored) { res.status(401).json({ ok: false, error: "grant_expired_or_used" }); return; }
  await pgDeleteGameCache(project.id, COLLECTION, key);
  const userId = String(stored.data.userId ?? "");
  const platform = String(stored.data.platform ?? "");
  if (!userId || !["main", "aura"].includes(platform)) { res.status(401).json({ ok: false, error: "invalid_grant_payload" }); return; }
  res.json({ ok: true, userId, platform, redeemedAt: new Date().toISOString() });
});

export default router;
