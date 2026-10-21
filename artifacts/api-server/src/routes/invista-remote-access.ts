import crypto from "node:crypto";
import { Router } from "express";

/**
 * One-time handoff tickets between the trusted Invista backend and its own
 * authenticated web session. This does not expose Deriv tokens or session
 * cookies. The platform must exchange the ticket server-to-server before
 * creating a new, isolated browser session.
 *
 * Tickets intentionally have a short TTL and are single-use. The in-memory
 * store is acceptable only for short-lived grants; losing grants on restart
 * fails closed and users can request a new grant.
 */
const router = Router();
type Platform = "main" | "aura";
interface Grant {
  digest: string;
  userId: string;
  platform: Platform;
  expiresAt: number;
}
const grants = new Map<string, Grant>();
const TTL_MS = 60_000;

function serviceAuthorized(req: import("express").Request): boolean {
  const expected = process.env.INVISTA_UNIVERSAL_SERVER_KEY;
  const supplied = req.header("x-invista-server-key") || "";
  const expectedBytes = Buffer.from(expected || "", "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return Boolean(expected && supplied && suppliedBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(suppliedBytes, expectedBytes));
}

function digest(ticket: string): string {
  return crypto.createHash("sha256").update(ticket).digest("hex");
}

function prune(): void {
  const now = Date.now();
  for (const [id, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(id);
  }
}

// Backend-only: the platform calls this after verifying the user's login.
router.post("/invista/remote-access/tickets", (req, res): void => {
  if (!serviceAuthorized(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  const { userId, platform } = req.body || {};
  if (typeof userId !== "string" || !userId.trim() ||
      (platform !== "main" && platform !== "aura")) {
    res.status(400).json({ error: "userId and a valid platform are required" }); return;
  }

  prune();
  const ticket = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + TTL_MS;
  grants.set(digest(ticket), {
    digest: digest(ticket),
    userId: userId.trim(),
    platform,
    expiresAt,
  });
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, ticket, platform, expiresAt: new Date(expiresAt).toISOString() });
});

// Backend-only: atomically consumes a ticket. A platform must verify its own
// platform identifier and then establish a fresh session in that browser.
router.post("/invista/remote-access/consume", (req, res): void => {
  if (!serviceAuthorized(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  const { ticket, platform } = req.body || {};
  if (typeof ticket !== "string" || ticket.length < 32 ||
      (platform !== "main" && platform !== "aura")) {
    res.status(400).json({ error: "ticket and valid platform are required" }); return;
  }

  prune();
  const key = digest(ticket);
  const grant = grants.get(key);
  if (!grant || grant.expiresAt <= Date.now()) {
    grants.delete(key);
    res.status(410).json({ error: "ticket_expired_or_used" }); return;
  }
  if (grant.platform !== platform) {
    res.status(403).json({ error: "ticket_platform_mismatch" }); return;
  }
  grants.delete(key);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, userId: grant.userId, platform: grant.platform });
});

export default router;
