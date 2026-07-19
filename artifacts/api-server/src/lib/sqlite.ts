// Banco secundário — espelho simultâneo de todas as escritas do PGlite.
// node:sqlite built-in (Node 22.5+). Síncrono. Fire-and-forget nas rotas.
import { DatabaseSync } from "node:sqlite";
import path from "path";
import fs from "fs";
import { logger } from "./logger";

const VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const DATA_DIR = VOLUME_PATH
  ? path.join(VOLUME_PATH, "universal-server")
  : path.resolve(process.cwd(), "data");

const SQLITE_PATH = path.join(DATA_DIR, "universal-server.db");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const sqlite = new DatabaseSync(SQLITE_PATH);

sqlite.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    api_key     TEXT UNIQUE NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS collections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    collection  TEXT NOT NULL,
    data        TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS request_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    method      TEXT,
    endpoint    TEXT,
    status      INTEGER DEFAULT 200,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sq_coll ON collections(project_id, collection);
  CREATE INDEX IF NOT EXISTS idx_sq_logs ON request_logs(project_id);
`);

logger.info({ path: SQLITE_PATH }, "SQLite mirror ready");

// ── Espelhos de escrita (fire-and-forget) ─────────────────────────────────────

export function sqMirrorInsertProject(name: string, description: string | null, apiKey: string): void {
  try {
    sqlite.prepare("INSERT OR IGNORE INTO projects (name, description, api_key) VALUES (?, ?, ?)").run(name, description, apiKey);
  } catch (err) {
    logger.warn({ err }, "SQLite mirror: insertProject failed");
  }
}

export function sqMirrorDeleteProject(id: number): void {
  try {
    sqlite.prepare("DELETE FROM projects WHERE id = ?").run(id);
  } catch (err) {
    logger.warn({ err }, "SQLite mirror: deleteProject failed");
  }
}

export function sqMirrorInsertCollection(
  pgId: number,
  projectId: number,
  collection: string,
  data: Record<string, unknown>,
): void {
  try {
    // Insere com o mesmo id do PGlite para manter referência cruzada
    sqlite
      .prepare("INSERT OR IGNORE INTO collections (id, project_id, collection, data) VALUES (?, ?, ?, ?)")
      .run(pgId, projectId, collection, JSON.stringify(data));
  } catch (err) {
    logger.warn({ err }, "SQLite mirror: insertCollection failed");
  }
}

export function sqMirrorUpdateCollection(id: number, data: Record<string, unknown>): void {
  try {
    sqlite
      .prepare("UPDATE collections SET data = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(data), id);
  } catch (err) {
    logger.warn({ err }, "SQLite mirror: updateCollection failed");
  }
}

export function sqMirrorDeleteCollection(id: number): void {
  try {
    sqlite.prepare("DELETE FROM collections WHERE id = ?").run(id);
  } catch (err) {
    logger.warn({ err }, "SQLite mirror: deleteCollection failed");
  }
}

export function sqMirrorLogRequest(projectId: number, method: string, endpoint: string): void {
  try {
    sqlite
      .prepare("INSERT INTO request_logs (project_id, method, endpoint) VALUES (?, ?, ?)")
      .run(projectId, method, endpoint);
  } catch {
    // silencioso
  }
}
