import { sqlite } from "./sqlite";
import type { DatabaseSnapshot } from "./pglite";
import { logger } from "./logger";

export function sqReplaceFromSnapshot(snapshot: DatabaseSnapshot): void {
  sqlite.exec("PRAGMA foreign_keys = OFF; BEGIN;");
  try {
    sqlite.exec("DELETE FROM request_logs; DELETE FROM game_cache; DELETE FROM collections; DELETE FROM projects;");
    const project = sqlite.prepare("INSERT INTO projects (id, name, description, api_key, created_at) VALUES (?, ?, ?, ?, ?)");
    const collection = sqlite.prepare("INSERT INTO collections (id, project_id, collection, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
    const log = sqlite.prepare("INSERT INTO request_logs (id, project_id, method, endpoint, status, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    const cache = sqlite.prepare("INSERT INTO game_cache (id, project_id, namespace, cache_key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");

    for (const p of snapshot.projects) project.run(p.id, p.name, p.description, p.api_key, p.created_at);
    for (const c of snapshot.collections) collection.run(c.id, c.project_id, c.collection, JSON.stringify(c.data), c.created_at, c.updated_at);
    for (const r of snapshot.request_logs) log.run(r.id, r.project_id, r.method, r.endpoint, r.status, r.created_at);
    for (const c of snapshot.game_cache) cache.run(c.id, c.project_id, c.namespace, c.cache_key, JSON.stringify(c.data), c.expires_at, c.created_at, c.updated_at);

    sqlite.exec("COMMIT; PRAGMA foreign_keys = ON;");
    logger.info("SQLite mirror rebuilt from durable snapshot");
  } catch (err) {
    sqlite.exec("ROLLBACK; PRAGMA foreign_keys = ON;");
    throw err;
  }
}
