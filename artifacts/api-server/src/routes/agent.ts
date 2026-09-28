import { Router, type IRouter, type Request, type Response } from "express";
import {
  pgGetDatabaseHealth,
  pgPersistenceStatus,
  pgGetStats,
  pgGetOrCreateSystemProject,
  pgListCollection,
  pgInsertCollectionItem,
  pgUpdateCollectionItem,
  pgGetGameCache,
  pgUpsertGameCache,
  pgDeleteGameCache,
} from "../lib/pglite";
import { sqMirrorUpsertGameCache, sqMirrorDeleteGameCache } from "../lib/sqlite";

const router: IRouter = Router();

const ACTIONS = {
  system: ["health", "status", "capabilities", "time"],
  memory: ["list", "save", "update"],
  settings: ["get", "set"],
  game: ["cache_get", "cache_set", "cache_delete"],
  weather: ["current"],
} as const;

function authorized(req: Request): boolean {
  const expected = process.env.AURA_AGENT_TOKEN?.trim();
  if (!expected) return true;
  const supplied = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return supplied === expected;
}

function validObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function weather(lat: number, lng: number) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lng));
  url.searchParams.set("current", "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,is_day");
  url.searchParams.set("timezone", "auto");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Weather provider failed (${response.status})`);
  return response.json();
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
  const args = validObject(req.body?.args) ? req.body.args : {};

  if (!domain || !action) {
    res.status(400).json({ ok: false, error: "domain and action are required" });
    return;
  }

  const available = (ACTIONS as Record<string, readonly string[]>)[domain];
  if (!available || !available.includes(action)) {
    res.status(404).json({ ok: false, error: "Unsupported Aurora action", domain, action, available: ACTIONS });
    return;
  }

  const project = await pgGetOrCreateSystemProject();

  if (domain === "system") {
    if (action === "health") {
      const database = await pgGetDatabaseHealth();
      const persistence = pgPersistenceStatus();
      res.json({ ok: database.ok, executed: true, domain, action, result: { status: database.ok ? "ok" : "degraded", database, persistence } });
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

    res.json({ ok: true, executed: true, domain, action, result: { timestamp: new Date().toISOString(), timezone: args.timezone ?? "UTC" } });
    return;
  }

  if (domain === "memory") {
    if (action === "list") {
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500);
      const rows = await pgListCollection(project.id, "aurora_memory", limit);
      res.json({ ok: true, executed: true, domain, action, result: { memories: rows } });
      return;
    }

    const text = String(args.text ?? "").trim();
    if (!text) {
      res.status(400).json({ ok: false, error: "memory text is required" });
      return;
    }

    if (action === "save") {
      const row = await pgInsertCollectionItem(project.id, "aurora_memory", {
        text,
        tags: Array.isArray(args.tags) ? args.tags.slice(0, 32) : [],
        source: String(args.source ?? "aurora"),
        createdAt: new Date().toISOString(),
      });
      res.json({ ok: true, executed: true, domain, action, result: { memory: row } });
      return;
    }

    const id = Number(args.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ ok: false, error: "memory id is required for update" });
      return;
    }
    const row = await pgUpdateCollectionItem(project.id, "aurora_memory", id, {
      text,
      tags: Array.isArray(args.tags) ? args.tags.slice(0, 32) : [],
      source: String(args.source ?? "aurora"),
      updatedAt: new Date().toISOString(),
    });
    if (!row) {
      res.status(404).json({ ok: false, error: "memory not found" });
      return;
    }
    res.json({ ok: true, executed: true, domain, action, result: { memory: row } });
    return;
  }

  if (domain === "settings") {
    const key = String(args.key ?? "").trim();
    if (!key || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(key)) {
      res.status(400).json({ ok: false, error: "valid setting key is required" });
      return;
    }
    const rows = await pgListCollection(project.id, "aurora_settings", 500);
    const existing = rows.find((row) => String(row.data.key ?? "") === key);

    if (action === "get") {
      res.json({ ok: true, executed: true, domain, action, result: { key, value: existing?.data.value ?? null, found: Boolean(existing) } });
      return;
    }

    if (!("value" in args)) {
      res.status(400).json({ ok: false, error: "setting value is required" });
      return;
    }
    const data = { key, value: args.value, updatedAt: new Date().toISOString() };
    const row = existing
      ? await pgUpdateCollectionItem(project.id, "aurora_settings", existing.id, data)
      : await pgInsertCollectionItem(project.id, "aurora_settings", data);
    res.json({ ok: true, executed: true, domain, action, result: { setting: row } });
    return;
  }

  if (domain === "game") {
    const namespace = String(args.namespace ?? "").trim();
    const cacheKey = String(args.cacheKey ?? "").trim();
    if (!namespace || !cacheKey) {
      res.status(400).json({ ok: false, error: "namespace and cacheKey are required" });
      return;
    }

    if (action === "cache_get") {
      const row = await pgGetGameCache(project.id, namespace, cacheKey);
      res.json({ ok: true, executed: true, domain, action, result: { hit: Boolean(row), cache: row } });
      return;
    }

    if (action === "cache_delete") {
      const deleted = await pgDeleteGameCache(project.id, namespace, cacheKey);
      sqMirrorDeleteGameCache(project.id, namespace, cacheKey);
      res.json({ ok: deleted, executed: true, domain, action, result: { deleted, namespace, cacheKey } });
      return;
    }

    if (!validObject(args.data)) {
      res.status(400).json({ ok: false, error: "game cache data must be an object" });
      return;
    }
    const expiresAt = args.expiresAt == null ? null : String(args.expiresAt);
    if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
      res.status(400).json({ ok: false, error: "expiresAt must be a valid ISO date or null" });
      return;
    }
    const row = await pgUpsertGameCache(project.id, namespace, cacheKey, args.data, expiresAt);
    sqMirrorUpsertGameCache(row.id, project.id, namespace, cacheKey, args.data, expiresAt);
    res.json({ ok: true, executed: true, domain, action, result: { cache: row } });
    return;
  }

  if (domain === "weather") {
    const lat = Number(args.lat ?? -22.3572);
    const lng = Number(args.lng ?? -47.3841);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      res.status(400).json({ ok: false, error: "valid latitude and longitude are required" });
      return;
    }
    const data = await weather(lat, lng);
    res.json({ ok: true, executed: true, domain, action, result: { location: { latitude: lat, longitude: lng }, data } });
    return;
  }

  res.status(500).json({ ok: false, error: "Aurora action handler not implemented" });
});

export default router;
