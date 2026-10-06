import { Router, type Request } from "express";
import { createDerivAccountContext, type DerivAccountType } from "../lib/deriv-account-gateway";

const router = Router();

function authorized(req: Request): boolean {
  const configured = String(process.env.INVISTA_UNIVERSAL_SERVER_KEY ?? "").trim();
  if (!configured) return process.env.NODE_ENV !== "production";
  return String(req.header("x-invista-server-key") ?? "") === configured;
}

router.get("/deriv/accounts", async (req, res): Promise<void> => {
  if (!authorized(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }
  const token = String(req.header("x-deriv-token") ?? "").trim();
  if (!token) { res.status(400).json({ ok: false, error: "x-deriv-token is required" }); return; }

  try {
    const { getDerivAccounts } = await import("../lib/deriv-account-gateway");
    const accounts = await getDerivAccounts(token);
    res.json({ ok: true, accounts });
  } catch (error) {
    res.status(502).json({ ok: false, error: error instanceof Error ? error.message : "Deriv account lookup failed" });
  }
});

router.post("/deriv/account-context", async (req, res): Promise<void> => {
  if (!authorized(req)) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }

  const token = String(req.header("x-deriv-token") ?? req.body?.token ?? "").trim();
  const accountType = String(req.body?.accountType ?? "").trim().toLowerCase() as DerivAccountType;
  const preferredAccountId = String(req.body?.accountId ?? "").trim() || undefined;

  if (!token || !["demo", "real"].includes(accountType)) {
    res.status(400).json({ ok: false, error: "token and accountType (demo|real) are required" });
    return;
  }

  try {
    const context = await createDerivAccountContext(token, accountType, preferredAccountId);
    res.json({
      ok: true,
      accountId: context.accountId,
      accountType: context.accountType,
      websocketUrl: context.websocketUrl,
      appId: context.appId,
    });
  } catch (error) {
    res.status(502).json({ ok: false, error: error instanceof Error ? error.message : "Deriv account context failed" });
  }
});

export default router;
