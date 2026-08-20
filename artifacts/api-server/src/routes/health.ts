import { Router, type IRouter } from "express";
import { pgGetDatabaseHealth } from "../lib/pglite";
import { sqGetDatabaseHealth } from "../lib/sqlite";

const router: IRouter = Router();
const startTime = Date.now();

router.get("/healthz", async (_req, res): Promise<void> => {
  const [pglite, sqlite] = await Promise.all([
    pgGetDatabaseHealth(),
    Promise.resolve(sqGetDatabaseHealth()),
  ]);

  const healthy = pglite.ok && sqlite.ok;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    serverTime: new Date().toISOString(),
    expirationAt: process.env.SERVER_EXPIRATION_AT ?? null,
    databases: { pglite, sqlite },
  });
});

export default router;
