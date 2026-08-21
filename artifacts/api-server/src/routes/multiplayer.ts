import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { pgGetProjectByApiKey, pgListGameCache, pgListGameCacheSince } from "../lib/pglite";

const router: IRouter = Router();
type AuthedRequest = Request & { project?: { id: number; name: string } };

async function authenticate(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const apiKey = (req.headers["x-api-key"] as string | undefined) ?? (req.query["api_key"] as string | undefined);
  if (!apiKey) { res.status(401).json({ error: "Header x-api-key é obrigatório" }); return; }
  const project = await pgGetProjectByApiKey(apiKey);
  if (!project) { res.status(403).json({ error: "Chave de API inválida" }); return; }
  req.project = { id: project.id, name: project.name };
  next();
}

router.get("/game/players", authenticate, async (req: AuthedRequest, res: Response): Promise<void> => {
  const limit = Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 64;
  const rows = await pgListGameCache(req.project!.id, "players", limit);
  res.json({ serverTime: new Date().toISOString(), players: rows.map((row) => ({
    playerId: row.cache_key,
    data: row.data,
    updatedAt: row.updated_at,
  })) });
});

router.get("/game/events", authenticate, async (req: AuthedRequest, res: Response): Promise<void> => {
  const since = typeof req.query.since === "string" && !Number.isNaN(Date.parse(req.query.since)) ? req.query.since : new Date(0).toISOString();
  const limit = Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 100;
  const rows = await pgListGameCacheSince(req.project!.id, "events", since, limit);
  res.json({ serverTime: new Date().toISOString(), events: rows.map((row) => ({
    eventId: row.cache_key,
    data: row.data,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })) });
});

export default router;
