import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { pgGetProjectByApiKey, pgGetGameCache, pgUpsertGameCache } from "../lib/pglite";
import { sqMirrorUpsertGameCache } from "../lib/sqlite";

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

function playerCacheKey(playerId: string): string {
  return encodeURIComponent(playerId.trim());
}

router.get("/game/player-state/:playerId", authenticate, async (req: AuthedRequest, res): Promise<void> => {
  const playerId = decodeURIComponent(req.params.playerId as string).trim();
  if (!playerId) { res.status(400).json({ error: "playerId é obrigatório" }); return; }

  const row = await pgGetGameCache(req.project!.id, "players", playerCacheKey(playerId));
  if (!row) { res.json({ found: false, state: null }); return; }

  res.json({ found: true, state: row.data });
});

router.put("/game/player-state/:playerId", authenticate, async (req: AuthedRequest, res): Promise<void> => {
  const playerId = decodeURIComponent(req.params.playerId as string).trim();
  if (!playerId) { res.status(400).json({ error: "playerId é obrigatório" }); return; }
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    res.status(400).json({ error: "body deve ser um objeto JSON" });
    return;
  }

  const state = { ...req.body, playerId };
  const row = await pgUpsertGameCache(req.project!.id, "players", playerCacheKey(playerId), state, null);
  sqMirrorUpsertGameCache(row.id, req.project!.id, "players", playerCacheKey(playerId), state, null);

  res.json({ ok: true, state: row.data, updatedAt: row.updated_at });
});

export default router;
