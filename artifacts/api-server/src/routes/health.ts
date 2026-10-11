import { Router, type IRouter } from "express";
import { pgGetDatabaseHealth, pgPersistenceStatus } from "../lib/pglite";

const router: IRouter = Router();
const startTime = Date.now();

router.get(["/healthz", "/health"], async (_req, res): Promise<void> => {
  const github = await pgGetDatabaseHealth();
  const persistence = pgPersistenceStatus();
  // A live process with failed GitHub persistence is not healthy: writes must be durable.
  const healthy = github.ok && !persistence.lastPersistError;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    serverTime: new Date().toISOString(),
    expirationAt: process.env.SERVER_EXPIRATION_AT ?? null,
    database: github,
    persistence: {
      primary: "github",
      encrypted: true,
      dirty: persistence.dirty,
      lastPersistAt: persistence.lastPersistAt,
      lastPersistError: persistence.lastPersistError,
    },
  });
});

export default router;
