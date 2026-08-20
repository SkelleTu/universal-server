import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  pgGetProjectByApiKey,
  pgGetGameCache,
  pgUpsertGameCache,
  pgDeleteGameCache,
  pgGetDatabaseHealth,
} from "../lib/pglite";
import {
  sqMirrorUpsertGameCache,
  sqMirrorDeleteGameCache,
  sqGetDatabaseHealth,
} from "../lib/sqlite";

const router: IRouter = Router();

type AuthedRequest = Request & { project?: { id: number; name: string } };

async function authenticate(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const apiKey =
    (req.headers["x-api-key"] as string | undefined) ??
    (req.query["api_key"] as string | undefined);

  if (!apiKey) {
    res.status(401).json({ error: "Header x-api-key é obrigatório" });
    return;
  }

  const project = await pgGetProjectByApiKey(apiKey);
  if (!project) {
    res.status(403).json({ error: "Chave de API inválida" });
    return;
  }

  req.project = { id: project.id, name: project.name };
  next();
}

function decodeKey(value: string): string {
  return decodeURIComponent(value);
}

const gameVersion = process.env.GAME_VERSION ?? "0.1.0";
const serverVersion = process.env.SERVER_VERSION ?? "1.0.0";
const expirationAt = process.env.SERVER_EXPIRATION_AT ?? null;

const cacheNamespaces = [
  "maps",
  "streetview",
  "places",
  "roads",
  "elevation",
  "weather",
  "world",
  "objects",
  "players",
  "clans",
  "events",
];

router.get("/game/status", authenticate, async (req: AuthedRequest, res): Promise<void> => {
  const [postgres, sqlite] = await Promise.all([pgGetDatabaseHealth(), Promise.resolve(sqGetDatabaseHealth())]);
  const healthy = postgres.ok && sqlite.ok;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    service: "universal-server",
    game: "Clamour in the Darkness",
    gameVersion,
    serverVersion,
    project: req.project,
    time: new Date().toISOString(),
    expirationAt,
    databases: {
      pglite: postgres,
      sqlite: sqlite,
    },
  });
});

router.get("/game/manifest", authenticate, (_req: AuthedRequest, res): void => {
  res.json({
    service: "universal-server",
    game: "Clamour in the Darkness",
    gameVersion,
    serverVersion,
    apiVersion: "1",
    serverTime: new Date().toISOString(),
    expirationAt,
    cache: {
      strategy: "persistent-server-cache",
      namespaces: cacheNamespaces,
      keyFormat: "namespace + cacheKey",
    },
    persistence: {
      primary: "PGlite/PostgreSQL",
      mirror: "SQLite",
      gitBacked: false,
    },
  });
});

router.get(
  "/game/cache/:namespace/:cacheKey",
  authenticate,
  async (req: AuthedRequest, res): Promise<void> => {
    const namespace = decodeKey(req.params.namespace as string);
    const cacheKey = decodeKey(req.params.cacheKey as string);
    const row = await pgGetGameCache(req.project!.id, namespace, cacheKey);

    if (!row) {
      res.status(404).json({ hit: false, namespace, cacheKey });
      return;
    }

    res.json({
      hit: true,
      id: row.id,
      namespace: row.namespace,
      cacheKey: row.cache_key,
      data: row.data,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  },
);

router.put(
  "/game/cache/:namespace/:cacheKey",
  authenticate,
  async (req: AuthedRequest, res): Promise<void> => {
    const namespace = decodeKey(req.params.namespace as string);
    const cacheKey = decodeKey(req.params.cacheKey as string);
    const body = req.body as { data?: Record<string, unknown>; expiresAt?: string | null };

    if (!body || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
      res.status(400).json({ error: "O campo data deve ser um objeto JSON" });
      return;
    }

    const expiresAt = body.expiresAt ?? null;
    if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) {
      res.status(400).json({ error: "expiresAt deve ser uma data ISO 8601 válida ou null" });
      return;
    }

    const row = await pgUpsertGameCache(req.project!.id, namespace, cacheKey, body.data, expiresAt);
    sqMirrorUpsertGameCache(row.id, req.project!.id, namespace, cacheKey, body.data, expiresAt);

    res.status(200).json({
      ok: true,
      id: row.id,
      namespace: row.namespace,
      cacheKey: row.cache_key,
      data: row.data,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  },
);

router.delete(
  "/game/cache/:namespace/:cacheKey",
  authenticate,
  async (req: AuthedRequest, res): Promise<void> => {
    const namespace = decodeKey(req.params.namespace as string);
    const cacheKey = decodeKey(req.params.cacheKey as string);
    const deleted = await pgDeleteGameCache(req.project!.id, namespace, cacheKey);
    sqMirrorDeleteGameCache(req.project!.id, namespace, cacheKey);

    if (!deleted) {
      res.status(404).json({ ok: false, deleted: false });
      return;
    }

    res.json({ ok: true, deleted: true, namespace, cacheKey });
  },
);

export default router;
