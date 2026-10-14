import { Router, type Request, type Response } from "express";
import { disconnectAndDeleteDerivSession, getDerivSessionStatus, saveAndConnectDerivSession } from "../lib/invista-deriv-session-manager";

const router = Router();
type Platform = "main" | "aura";
function authorized(req: Request): boolean {
  const expected = String(process.env.INVISTA_UNIVERSAL_SERVER_KEY ?? "").trim();
  const supplied = String(req.header("x-invista-server-key") ?? "").trim();
  return Boolean(expected && supplied && supplied === expected);
}
function validPlatform(value: unknown): value is Platform { return value === "main" || value === "aura"; }

router.post("/invista/deriv/session", async (req: Request, res: Response): Promise<void> => {
  if (!authorized(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }
  const userId = String(req.body?.userId ?? "").trim();
  const platform = req.body?.platform;
  const token = String(req.body?.token ?? "").trim();
  const accountType = String(req.body?.accountType ?? "").trim().toLowerCase();
  const accountId = String(req.body?.accountId ?? "").trim() || undefined;
  if (!userId || !validPlatform(platform) || !token || !["demo", "real"].includes(accountType)) {
    res.status(400).json({ ok: false, error: "userId, platform, token and accountType (demo|real) are required" }); return;
  }
  try {
    const state = await saveAndConnectDerivSession({ userId, platform, token, accountType: accountType as "demo" | "real", accountId });
    res.json({ ok: true, ...state });
  } catch (error) {
    res.status(502).json({ ok: false, connected: false, error: error instanceof Error ? error.message : "Deriv session connection failed" });
  }
});

router.get("/invista/deriv/session/:platform/:userId", async (req: Request, res: Response): Promise<void> => {
  if (!authorized(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }
  const platform = String(req.params.platform ?? "");
  const userId = String(req.params.userId ?? "").trim();
  if (!validPlatform(platform) || !userId) { res.status(400).json({ ok: false, error: "platform and userId are required" }); return; }
  try { res.json({ ok: true, ...(await getDerivSessionStatus(userId, platform)) }); }
  catch { res.status(500).json({ ok: false, error: "session_status_unavailable" }); }
});

router.delete("/invista/deriv/session/:platform/:userId", async (req: Request, res: Response): Promise<void> => {
  if (!authorized(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }
  const platform = String(req.params.platform ?? "");
  const userId = String(req.params.userId ?? "").trim();
  if (!validPlatform(platform) || !userId) { res.status(400).json({ ok: false, error: "platform and userId are required" }); return; }
  try { res.json({ ok: true, ...(await disconnectAndDeleteDerivSession(userId, platform)) }); }
  catch { res.status(500).json({ ok: false, error: "session_delete_failed" }); }
});

export default router;
