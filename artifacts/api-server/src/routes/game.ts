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

function decodeKey(value: string): string { return decodeURIComponent(value); }
function numberParam(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isWithinAraras(lat: number, lng: number): boolean {
  return lat >= -22.48 && lat <= -22.24 && lng >= -47.52 && lng <= -47.25;
}

function streetViewKey(): string | null {
  const value = process.env.GOOGLE_MAPS_API_KEY?.trim();
  return value ? value : null;
}

const gameVersion = process.env.GAME_VERSION ?? "0.1.0";
const serverVersion = process.env.SERVER_VERSION ?? "1.0.0";
const expirationAt = process.env.SERVER_EXPIRATION_AT ?? null;
const cacheNamespaces = [
  "maps", "streetview", "places", "roads", "elevation", "weather", "world", "objects", "players", "clans", "events",
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
    databases: { pglite: postgres, sqlite },
    integrations: { streetViewStaticApi: Boolean(streetViewKey()) },
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
    cache: { strategy: "persistent-server-cache", namespaces: cacheNamespaces, keyFormat: "namespace + cacheKey" },
    persistence: { primary: "PGlite/PostgreSQL", mirror: "SQLite", gitBacked: false },
    integrations: { streetViewStaticApi: Boolean(streetViewKey()), streetViewPolicy: "metadata-and-identifiers-persisted; imagery requested on demand" },
  });
});

router.get("/game/cache/:namespace/:cacheKey", authenticate, async (req: AuthedRequest, res): Promise<void> => {
  const namespace = decodeKey(req.params.namespace as string);
  const cacheKey = decodeKey(req.params.cacheKey as string);
  const row = await pgGetGameCache(req.project!.id, namespace, cacheKey);
  if (!row) { res.status(404).json({ hit: false, namespace, cacheKey }); return; }
  res.json({ hit: true, id: row.id, namespace: row.namespace, cacheKey: row.cache_key, data: row.data, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at });
});

router.put("/game/cache/:namespace/:cacheKey", authenticate, async (req: AuthedRequest, res): Promise<void> => {
  const namespace = decodeKey(req.params.namespace as string);
  const cacheKey = decodeKey(req.params.cacheKey as string);
  const body = req.body as { data?: Record<string, unknown>; expiresAt?: string | null };
  if (!body || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) { res.status(400).json({ error: "O campo data deve ser um objeto JSON" }); return; }
  const expiresAt = body.expiresAt ?? null;
  if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) { res.status(400).json({ error: "expiresAt deve ser uma data ISO 8601 válida ou null" }); return; }
  const row = await pgUpsertGameCache(req.project!.id, namespace, cacheKey, body.data, expiresAt);
  sqMirrorUpsertGameCache(row.id, req.project!.id, namespace, cacheKey, body.data, expiresAt);
  res.status(200).json({ ok: true, id: row.id, namespace: row.namespace, cacheKey: row.cache_key, data: row.data, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at });
});

router.delete("/game/cache/:namespace/:cacheKey", authenticate, async (req: AuthedRequest, res): Promise<void> => {
  const namespace = decodeKey(req.params.namespace as string);
  const cacheKey = decodeKey(req.params.cacheKey as string);
  const deleted = await pgDeleteGameCache(req.project!.id, namespace, cacheKey);
  sqMirrorDeleteGameCache(req.project!.id, namespace, cacheKey);
  if (!deleted) { res.status(404).json({ ok: false, deleted: false }); return; }
  res.json({ ok: true, deleted: true, namespace, cacheKey });
});

router.get("/game/streetview/metadata", async (req: Request, res): Promise<void> => {
  const key = streetViewKey();
  if (!key) { res.status(503).json({ error: "GOOGLE_MAPS_API_KEY não configurada" }); return; }
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radius = Math.min(Math.max(numberParam(req.query.radius, 50), 0), 100);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) { res.status(400).json({ error: "lat e lng válidos são obrigatórios" }); return; }
  if (!isWithinAraras(lat, lng)) { res.status(403).json({ error: "Public Street View is available only in Araras, SP" }); return; }

  const params = new URLSearchParams({ location: `${lat},${lng}`, radius: String(radius), source: "outdoor", key });
  const response = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?${params.toString()}`);
  const rawPayload = await response.text();
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(rawPayload) as Record<string, unknown>; }
  catch { res.status(502).json({ error: "Street View metadata returned an invalid response", details: rawPayload.slice(0, 500) }); return; }
  const status = String(payload.status ?? "UNKNOWN");
  if (!response.ok || status !== "OK") {
    res.status(status === "ZERO_RESULTS" ? 404 : 502).json({ error: "Street View metadata request failed", googleStatus: status, data: payload });
    return;
  }
  res.json({ hit: false, source: "google", data: {
    status,
    pano: payload.pano ?? null,
    location: payload.location ?? null,
    date: payload.date ?? null,
    copyright: payload.copyright ?? null,
    sourceLat: lat,
    sourceLng: lng,
    radius,
    fetchedAt: new Date().toISOString(),
  } });
});

router.get("/game/streetview/image", async (req: Request, res: Response): Promise<void> => {
  const key = streetViewKey();
  if (!key) { res.status(503).json({ error: "GOOGLE_MAPS_API_KEY não configurada" }); return; }

  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const pano = String(req.query.pano ?? "").trim();
  const heading = ((numberParam(req.query.heading, 0) % 360) + 360) % 360;
  const pitch = Math.min(Math.max(numberParam(req.query.pitch, 0), -90), 90);
  const fov = Math.min(Math.max(numberParam(req.query.fov, 90), 10), 120);
  const width = Math.min(Math.max(Math.floor(numberParam(req.query.width, 640)), 1), 640);
  const height = Math.min(Math.max(Math.floor(numberParam(req.query.height, 400)), 1), 640);
  const radius = Math.min(Math.max(numberParam(req.query.radius, 50), 0), 100);

  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    res.status(400).json({ error: "Valid lat/lng coordinates are required" }); return;
  }
  if (!isWithinAraras(lat, lng)) { res.status(403).json({ error: "Public Street View is available only in Araras, SP" }); return; }

  const params = new URLSearchParams({ size: `${width}x${height}`, heading: String(heading), pitch: String(pitch), fov: String(fov), return_error_code: "true", key });
  if (pano) params.set("pano", pano);
  else { params.set("location", `${lat},${lng}`); params.set("radius", String(radius)); params.set("source", "outdoor"); }

  const response = await fetch(`https://maps.googleapis.com/maps/api/streetview?${params.toString()}`);
  const contentType = response.headers.get("content-type") ?? "image/jpeg";
  if (!response.ok) {
    const body = await response.text();
    res.status(response.status >= 400 && response.status < 500 ? response.status : 502).json({ error: "Street View image request failed", details: body.slice(0, 500) });
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  res.setHeader("Content-Type", contentType);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(buffer);
});

router.options("/game/streetview/image", (_req: Request, res: Response): void => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.sendStatus(204);
});

export default router;
