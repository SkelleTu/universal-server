import { Router, type IRouter, type Request, type Response } from "express";
import { pgGetDatabaseHealth, pgPersistenceStatus, pgGetStats } from "../lib/pglite";

const router: IRouter = Router();

const ACTIONS = {
  system: ["health", "status", "capabilities", "time"],
} as const;

function authorized(req: Request): boolean {
  const expected = process.env.AURA_AGENT_TOKEN?.trim();
  if (!expected) return true;
  const supplied = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return supplied === expected;
}

router.get("/agent/capabilities", (req, res) => {
  if (!authorized(req)) {
    res.status(401).json({ ok: false, error: "Aurora agent authorization required" });
    return;
  }
  res.json({
    ok: true,
    service: "universal-server",
    agent: "aurora",
    version: process.env.SERVER_VERSION ?? "1.0.0",
    actions: ACTIONS,
    timestamp: new Date().toISOString(),
  });
});

router.post("/agent/action", async (req: Request, res: Response): Promise<void> => {
  if (!authorized(req)) {
    res.status(401).json({ ok: false, error: "Aurora agent authorization required" });
    return;
  }

  const domain = String(req.body?.domain ?? "").trim().toLowerCase();
  const action = String(req.body?.action ?? "").trim().toLowerCase();
  const args = req.body?.args && typeof req.body.args === "object" ? req.body.args : {};

  if (!domain || !action) {
    res.status(400).json({ ok: false, error: "domain and action are required" });
    return;
  }

  if (domain !== "system" || !(ACTIONS.system as readonly string[]).includes(action)) {
    res.status(404).json({ ok: false, error: "Unsupported Aurora action", domain, action, available: ACTIONS });
    return;
  }

  if (action === "health") {
    const database = await pgGetDatabaseHealth();
    const persistence = pgPersistenceStatus();
    res.json({
      ok: database.ok,
      executed: true,
      domain,
      action,
      result: { status: database.ok ? "ok" : "degraded", database, persistence },
    });
    return;
  }

  if (action === "status") {
    const [database, stats] = await Promise.all([pgGetDatabaseHealth(), pgGetStats()]);
    res.json({
      ok: database.ok,
      executed: true,
      domain,
      action,
      result: {
        service: "universal-server",
        version: process.env.SERVER_VERSION ?? "1.0.0",
        environment: process.env.NODE_ENV ?? "development",
        database,
        stats,
        timestamp: new Date().toISOString(),
      },
    });
    return;
  }

  if (action === "capabilities") {
    res.json({ ok: true, executed: true, domain, action, result: { actions: ACTIONS } });
    return;
  }

  res.json({
    ok: true,
    executed: true,
    domain,
    action,
    result: { timestamp: new Date().toISOString(), timezone: args.timezone ?? "UTC" },
  });
});

export default router;
