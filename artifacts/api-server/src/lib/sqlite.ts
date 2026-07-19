// Uses the built-in node:sqlite module available in Node.js 22.5+
// No native addon compilation required.
import { DatabaseSync } from "node:sqlite";
import path from "path";
import fs from "fs";
import { logger } from "./logger";

const DATA_DIR = path.resolve(process.cwd(), "data");
const SQLITE_PATH = path.join(DATA_DIR, "universal-server.db");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const sqlite = new DatabaseSync(SQLITE_PATH);

// Mirror the same schema as PostgreSQL
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    api_key     TEXT UNIQUE NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS collections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    collection  TEXT NOT NULL,
    data        TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS request_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    method      TEXT,
    endpoint    TEXT,
    status      INTEGER,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sqlite_collections_project ON collections(project_id, collection);
  CREATE INDEX IF NOT EXISTS idx_sqlite_logs_project ON request_logs(project_id);
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
`);

logger.info({ path: SQLITE_PATH }, "SQLite database initialized (node:sqlite)");

// ── Helpers ──────────────────────────────────────────────────────────────────

export function sqliteInsertProject(name: string, description: string | null, apiKey: string): void {
  try {
    sqlite
      .prepare("INSERT OR IGNORE INTO projects (name, description, api_key) VALUES (?, ?, ?)")
      .run(name, description, apiKey);
  } catch (err) {
    logger.warn({ err }, "SQLite: failed to insert project");
  }
}

export function sqliteDeleteProject(id: number): void {
  try {
    sqlite.prepare("DELETE FROM projects WHERE id = ?").run(id);
  } catch (err) {
    logger.warn({ err }, "SQLite: failed to delete project");
  }
}

export function sqliteInsertCollection(
  projectId: number,
  collection: string,
  data: Record<string, unknown>,
): void {
  try {
    sqlite
      .prepare("INSERT INTO collections (project_id, collection, data) VALUES (?, ?, ?)")
      .run(projectId, collection, JSON.stringify(data));
  } catch (err) {
    logger.warn({ err }, "SQLite: failed to insert collection item");
  }
}

export function sqliteUpdateCollection(
  projectId: number,
  collection: string,
  id: number,
  data: Record<string, unknown>,
): void {
  try {
    sqlite
      .prepare(
        "UPDATE collections SET data = ?, updated_at = datetime('now') WHERE project_id = ? AND collection = ? AND id = ?",
      )
      .run(JSON.stringify(data), projectId, collection, id);
  } catch (err) {
    logger.warn({ err }, "SQLite: failed to update collection item");
  }
}

export function sqliteDeleteCollection(projectId: number, collection: string, id: number): void {
  try {
    sqlite
      .prepare("DELETE FROM collections WHERE project_id = ? AND collection = ? AND id = ?")
      .run(projectId, collection, id);
  } catch (err) {
    logger.warn({ err }, "SQLite: failed to delete collection item");
  }
}

export function sqliteLogRequest(projectId: number, method: string, endpoint: string): void {
  try {
    sqlite
      .prepare("INSERT INTO request_logs (project_id, method, endpoint, status) VALUES (?, ?, ?, 200)")
      .run(projectId, method, endpoint);
  } catch {
    // swallow — logging failures should never break requests
  }
}

export default sqlite;
