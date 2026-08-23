import { Router, type IRouter } from "express";
import { pgGetDatabaseHealth } from "../lib/pglite";

const router: IRouter = Router();
const startTime = Date.now();

router.get("/healthz", async (_req, res): Promise<void> => {
  const github = await pgGetDatabaseHealth();
  const healthy = github.ok;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    serverTime: new Date().toISOString(),
    expirationAt: process.env.SERVER_EXPIRATION_AT ?? null,
    database: github,
    persistence: {
      primary: "github",
      encrypted: true,
    },
  });
});

export default router;
