// PostgreSQL embedded — @electric-sql/pglite (WASM, sem servidor externo)
// Roda dentro do próprio processo Node.js. Persiste em arquivo.
import { PGlite } from "@electric-sql/pglite";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { logger } from "./logger";

const VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const DATA_DIR = VOLUME_PATH ? path.join(VOLUME_PATH, "universal-server") : path.resolve(process.cwd(), "data");
const PG_DIR = path.join(DATA_DIR, "postgres");

if (!fs.existsSync(PG_DIR)) fs.mkdirSync(PG_DIR, { recursive: true });

let _pg: PGlite;

export async function initPGlite(): Promise<void> {
  _pg = new PGlite(`file://${PG_DIR}`);
  await _pg.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT, api_key TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS collections (
      id SERIAL PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, collection TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS request_logs (
      id SERIAL PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      method TEXT, endpoint TEXT, status INTEGER DEFAULT 200, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS game_cache (
      id SERIAL PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, namespace TEXT NOT NULL,
      cache_key TEXT NOT NULL, data JSONB NOT NULL DEFAULT '{}', expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(project_id, namespace, cache_key)
    );
    CREATE INDEX IF NOT EXISTS idx_pg_coll ON collections(project_id, collection);
    CREATE INDEX IF NOT EXISTS idx_pg_logs ON request_logs(project_id);
    CREATE INDEX IF NOT EXISTS idx_pg_game_cache ON game_cache(project_id, namespace, cache_key);
  `);
  logger.info({ dir: PG_DIR, volume: VOLUME_PATH ?? "local" }, "PGlite (embedded PostgreSQL) ready");
}

function pg(): PGlite {
  if (!_pg) throw new Error("PGlite não foi inicializado. Chame initPGlite() antes.");
  return _pg;
}

export type Project = { id: number; name: string; description: string | null; api_key: string; created_at: string };
export type CollectionRow = { id: number; data: Record<string, unknown>; created_at: string; updated_at: string };
export type GameCacheRow = { id: number; namespace: string; cache_key: string; data: Record<string, unknown>; expires_at: string | null; created_at: string; updated_at: string };
export type Stats = { requestsToday: number; totalCollections: number; totalProjects: number; totalGameCacheEntries: number };

export async function pgListProjects(): Promise<Project[]> {
  const res = await pg().query<Project>("SELECT id, name, description, api_key, created_at::text FROM projects ORDER BY created_at DESC"); return res.rows;
}
export async function pgGetProjectByApiKey(apiKey: string): Promise<Project | null> {
  const res = await pg().query<Project>("SELECT id, name, description, api_key, created_at::text FROM projects WHERE api_key = $1", [apiKey]); return res.rows[0] ?? null;
}
export async function pgInsertProject(name: string, description: string | null): Promise<Project> {
  const apiKey = crypto.randomBytes(32).toString("hex");
  const res = await pg().query<Project>("INSERT INTO projects (name, description, api_key) VALUES ($1, $2, $3) RETURNING id, name, description, api_key, created_at::text", [name, description, apiKey]); return res.rows[0];
}
export async function pgGetOrCreateSystemProject(): Promise<Project> {
  const name = "Clamour public game";
  const existing = await pg().query<Project>("SELECT id, name, description, api_key, created_at::text FROM projects WHERE name = $1", [name]);
  return existing.rows[0] ?? pgInsertProject(name, "Internal project for public player accounts.");
}
export async function pgDeleteProject(id: number): Promise<boolean> { const res = await pg().query("DELETE FROM projects WHERE id = $1 RETURNING id", [id]); return (res.rows?.length ?? 0) > 0; }

export async function pgListCollection(projectId: number, collection: string): Promise<CollectionRow[]> {
  const res = await pg().query<CollectionRow>("SELECT id, data, created_at::text, updated_at::text FROM collections WHERE project_id = $1 AND collection = $2 ORDER BY created_at DESC", [projectId, collection]); return res.rows;
}
export async function pgGetCollectionItem(projectId: number, collection: string, id: number): Promise<CollectionRow | null> {
  const res = await pg().query<CollectionRow>("SELECT id, data, created_at::text, updated_at::text FROM collections WHERE project_id = $1 AND collection = $2 AND id = $3", [projectId, collection, id]); return res.rows[0] ?? null;
}
export async function pgInsertCollectionItem(projectId: number, collection: string, data: Record<string, unknown>): Promise<CollectionRow> {
  const res = await pg().query<CollectionRow>("INSERT INTO collections (project_id, collection, data) VALUES ($1, $2, $3) RETURNING id, data, created_at::text, updated_at::text", [projectId, collection, data]); return res.rows[0];
}
export async function pgUpdateCollectionItem(projectId: number, collection: string, id: number, data: Record<string, unknown>): Promise<CollectionRow | null> {
  const res = await pg().query<CollectionRow>("UPDATE collections SET data = $1, updated_at = NOW() WHERE project_id = $2 AND collection = $3 AND id = $4 RETURNING id, data, created_at::text, updated_at::text", [data, projectId, collection, id]); return res.rows[0] ?? null;
}
export async function pgDeleteCollectionItem(projectId: number, collection: string, id: number): Promise<boolean> { const res = await pg().query("DELETE FROM collections WHERE project_id = $1 AND collection = $2 AND id = $3 RETURNING id", [projectId, collection, id]); return (res.rows?.length ?? 0) > 0; }

export async function pgGetGameCache(projectId: number, namespace: string, cacheKey: string): Promise<GameCacheRow | null> {
  const res = await pg().query<GameCacheRow>(`SELECT id, namespace, cache_key, data, expires_at::text, created_at::text, updated_at::text FROM game_cache WHERE project_id = $1 AND namespace = $2 AND cache_key = $3 AND (expires_at IS NULL OR expires_at > NOW())`, [projectId, namespace, cacheKey]); return res.rows[0] ?? null;
}
export async function pgListGameCache(projectId: number, namespace: string, limit = 100): Promise<GameCacheRow[]> {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
  const res = await pg().query<GameCacheRow>(`SELECT id, namespace, cache_key, data, expires_at::text, created_at::text, updated_at::text FROM game_cache WHERE project_id = $1 AND namespace = $2 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY updated_at DESC LIMIT ${safeLimit}`, [projectId, namespace]);
  return res.rows;
}
export async function pgListGameCacheSince(projectId: number, namespace: string, since: string, limit = 100): Promise<GameCacheRow[]> {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
  const res = await pg().query<GameCacheRow>(`SELECT id, namespace, cache_key, data, expires_at::text, created_at::text, updated_at::text FROM game_cache WHERE project_id = $1 AND namespace = $2 AND updated_at > $3 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY updated_at ASC LIMIT ${safeLimit}`, [projectId, namespace, since]);
  return res.rows;
}
export async function pgUpsertGameCache(projectId: number, namespace: string, cacheKey: string, data: Record<string, unknown>, expiresAt: string | null): Promise<GameCacheRow> {
  const res = await pg().query<GameCacheRow>(`INSERT INTO game_cache (project_id, namespace, cache_key, data, expires_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (project_id, namespace, cache_key) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at, updated_at = NOW() RETURNING id, namespace, cache_key, data, expires_at::text, created_at::text, updated_at::text`, [projectId, namespace, cacheKey, data, expiresAt]); return res.rows[0];
}
export async function pgDeleteGameCache(projectId: number, namespace: string, cacheKey: string): Promise<boolean> { const res = await pg().query("DELETE FROM game_cache WHERE project_id = $1 AND namespace = $2 AND cache_key = $3 RETURNING id", [projectId, namespace, cacheKey]); return (res.rows?.length ?? 0) > 0; }

export async function pgGetDatabaseHealth(): Promise<{ ok: boolean; latencyMs: number }> { const started = Date.now(); try { await pg().query("SELECT 1"); return { ok: true, latencyMs: Date.now() - started }; } catch { return { ok: false, latencyMs: Date.now() - started }; } }
export function pgLogRequest(projectId: number, method: string, endpoint: string): void { pg().query("INSERT INTO request_logs (project_id, method, endpoint) VALUES ($1, $2, $3)", [projectId, method, endpoint]).catch(() => {}); }
export async function pgGetStats(): Promise<Stats> {
  const today = new Date().toISOString().slice(0, 10);
  const [req, col, proj, cache] = await Promise.all([
    pg().query<{ c: string }>("SELECT COUNT(*) AS c FROM request_logs WHERE created_at >= $1", [today]),
    pg().query<{ c: string }>("SELECT COUNT(DISTINCT collection || project_id::text) AS c FROM collections"),
    pg().query<{ c: string }>("SELECT COUNT(*) AS c FROM projects"),
    pg().query<{ c: string }>("SELECT COUNT(*) AS c FROM game_cache"),
  ]);
  return { requestsToday: parseInt(req.rows[0].c, 10), totalCollections: parseInt(col.rows[0].c, 10), totalProjects: parseInt(proj.rows[0].c, 10), totalGameCacheEntries: parseInt(cache.rows[0].c, 10) };
}

export type DatabaseSnapshot = {
  schemaVersion: 1; createdAt: string; projects: Project[];
  collections: Array<{ id: number; project_id: number; collection: string; data: Record<string, unknown>; created_at: string; updated_at: string }>;
  request_logs: Array<{ id: number; project_id: number; method: string | null; endpoint: string | null; status: number; created_at: string }>;
  game_cache: Array<{ id: number; project_id: number; namespace: string; cache_key: string; data: Record<string, unknown>; expires_at: string | null; created_at: string; updated_at: string }>;
};

export async function pgHasPersistentData(): Promise<boolean> {
  const result = await pg().query<{ projects: string; collections: string; cache: string }>("SELECT (SELECT COUNT(*) FROM projects)::text AS projects, (SELECT COUNT(*) FROM collections)::text AS collections, (SELECT COUNT(*) FROM game_cache)::text AS cache");
  const row = result.rows[0]; return Number(row.projects) > 0 || Number(row.collections) > 0 || Number(row.cache) > 0;
}

export async function pgExportSnapshot(): Promise<DatabaseSnapshot> {
  const [projects, collections, requestLogs, gameCache] = await Promise.all([
    pg().query<Project>("SELECT id, name, description, api_key, created_at::text FROM projects ORDER BY id"),
    pg().query<DatabaseSnapshot["collections"][number]>("SELECT id, project_id, collection, data, created_at::text, updated_at::text FROM collections ORDER BY id"),
    pg().query<DatabaseSnapshot["request_logs"][number]>("SELECT id, project_id, method, endpoint, status, created_at::text FROM request_logs ORDER BY id"),
    pg().query<DatabaseSnapshot["game_cache"][number]>("SELECT id, project_id, namespace, cache_key, data, expires_at::text, created_at::text, updated_at::text FROM game_cache ORDER BY id"),
  ]);
  return { schemaVersion: 1, createdAt: new Date().toISOString(), projects: projects.rows, collections: collections.rows, request_logs: requestLogs.rows, game_cache: gameCache.rows };
}

export async function pgRestoreSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  if (snapshot.schemaVersion !== 1) throw new Error(`Unsupported snapshot schema: ${snapshot.schemaVersion}`);
  await pg().exec("BEGIN");
  try {
    await pg().exec("TRUNCATE request_logs, game_cache, collections, projects RESTART IDENTITY CASCADE");
    for (const p of snapshot.projects) await pg().query("INSERT INTO projects (id, name, description, api_key, created_at) VALUES ($1, $2, $3, $4, $5)", [p.id, p.name, p.description, p.api_key, p.created_at]);
    for (const c of snapshot.collections) await pg().query("INSERT INTO collections (id, project_id, collection, data, created_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6)", [c.id, c.project_id, c.collection, JSON.stringify(c.data), c.created_at, c.updated_at]);
    for (const r of snapshot.request_logs) await pg().query("INSERT INTO request_logs (id, project_id, method, endpoint, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [r.id, r.project_id, r.method, r.endpoint, r.status, r.created_at]);
    for (const c of snapshot.game_cache) await pg().query("INSERT INTO game_cache (id, project_id, namespace, cache_key, data, expires_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)", [c.id, c.project_id, c.namespace, c.cache_key, JSON.stringify(c.data), c.expires_at, c.created_at, c.updated_at]);
    await pg().exec("SELECT setval(pg_get_serial_sequence('projects','id'), COALESCE((SELECT MAX(id) FROM projects), 1), true)");
    await pg().exec("SELECT setval(pg_get_serial_sequence('collections','id'), COALESCE((SELECT MAX(id) FROM collections), 1), true)");
    await pg().exec("SELECT setval(pg_get_serial_sequence('request_logs','id'), COALESCE((SELECT MAX(id) FROM request_logs), 1), true)");
    await pg().exec("SELECT setval(pg_get_serial_sequence('game_cache','id'), COALESCE((SELECT MAX(id) FROM game_cache), 1), true)");
    await pg().exec("COMMIT");
  } catch (err) { await pg().exec("ROLLBACK"); throw err; }
}
