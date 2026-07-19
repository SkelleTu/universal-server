// PostgreSQL embedded — @electric-sql/pglite (WASM, sem servidor externo)
// Roda dentro do próprio processo Node.js. Persiste em arquivo.
import { PGlite } from "@electric-sql/pglite";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { logger } from "./logger";

const VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const DATA_DIR = VOLUME_PATH
  ? path.join(VOLUME_PATH, "universal-server")
  : path.resolve(process.cwd(), "data");

const PG_DIR = path.join(DATA_DIR, "postgres");

if (!fs.existsSync(PG_DIR)) {
  fs.mkdirSync(PG_DIR, { recursive: true });
}

let _pg: PGlite;

export async function initPGlite(): Promise<void> {
  _pg = new PGlite(`file://${PG_DIR}`);

  await _pg.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      api_key     TEXT UNIQUE NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS collections (
      id          SERIAL PRIMARY KEY,
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      collection  TEXT NOT NULL,
      data        JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS request_logs (
      id          SERIAL PRIMARY KEY,
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      method      TEXT,
      endpoint    TEXT,
      status      INTEGER DEFAULT 200,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_pg_coll ON collections(project_id, collection);
    CREATE INDEX IF NOT EXISTS idx_pg_logs ON request_logs(project_id);
  `);

  logger.info({ dir: PG_DIR, volume: VOLUME_PATH ?? "local" }, "PGlite (embedded PostgreSQL) ready");
}

function pg(): PGlite {
  if (!_pg) throw new Error("PGlite não foi inicializado. Chame initPGlite() antes.");
  return _pg;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type Project = {
  id: number;
  name: string;
  description: string | null;
  api_key: string;
  created_at: string;
};

export type CollectionRow = {
  id: number;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type Stats = {
  requestsToday: number;
  totalCollections: number;
  totalProjects: number;
};

// ── Projects ──────────────────────────────────────────────────────────────────

export async function pgListProjects(): Promise<Project[]> {
  const res = await pg().query<Project>(
    "SELECT id, name, description, api_key, created_at::text FROM projects ORDER BY created_at DESC",
  );
  return res.rows;
}

export async function pgGetProjectByApiKey(apiKey: string): Promise<Project | null> {
  const res = await pg().query<Project>(
    "SELECT id, name, description, api_key, created_at::text FROM projects WHERE api_key = $1",
    [apiKey],
  );
  return res.rows[0] ?? null;
}

export async function pgInsertProject(
  name: string,
  description: string | null,
): Promise<Project> {
  const apiKey = crypto.randomBytes(32).toString("hex");
  const res = await pg().query<Project>(
    "INSERT INTO projects (name, description, api_key) VALUES ($1, $2, $3) RETURNING id, name, description, api_key, created_at::text",
    [name, description, apiKey],
  );
  return res.rows[0];
}

export async function pgDeleteProject(id: number): Promise<boolean> {
  const res = await pg().query("DELETE FROM projects WHERE id = $1 RETURNING id", [id]);
  return (res.rows?.length ?? 0) > 0;
}

// ── Collections ───────────────────────────────────────────────────────────────

export async function pgListCollection(
  projectId: number,
  collection: string,
): Promise<CollectionRow[]> {
  const res = await pg().query<CollectionRow>(
    "SELECT id, data, created_at::text, updated_at::text FROM collections WHERE project_id = $1 AND collection = $2 ORDER BY created_at DESC",
    [projectId, collection],
  );
  return res.rows;
}

export async function pgGetCollectionItem(
  projectId: number,
  collection: string,
  id: number,
): Promise<CollectionRow | null> {
  const res = await pg().query<CollectionRow>(
    "SELECT id, data, created_at::text, updated_at::text FROM collections WHERE project_id = $1 AND collection = $2 AND id = $3",
    [projectId, collection, id],
  );
  return res.rows[0] ?? null;
}

export async function pgInsertCollectionItem(
  projectId: number,
  collection: string,
  data: Record<string, unknown>,
): Promise<CollectionRow> {
  const res = await pg().query<CollectionRow>(
    "INSERT INTO collections (project_id, collection, data) VALUES ($1, $2, $3) RETURNING id, data, created_at::text, updated_at::text",
    [projectId, collection, data],
  );
  return res.rows[0];
}

export async function pgUpdateCollectionItem(
  projectId: number,
  collection: string,
  id: number,
  data: Record<string, unknown>,
): Promise<CollectionRow | null> {
  const res = await pg().query<CollectionRow>(
    "UPDATE collections SET data = $1, updated_at = NOW() WHERE project_id = $2 AND collection = $3 AND id = $4 RETURNING id, data, created_at::text, updated_at::text",
    [data, projectId, collection, id],
  );
  return res.rows[0] ?? null;
}

export async function pgDeleteCollectionItem(
  projectId: number,
  collection: string,
  id: number,
): Promise<boolean> {
  const res = await pg().query(
    "DELETE FROM collections WHERE project_id = $1 AND collection = $2 AND id = $3 RETURNING id",
    [projectId, collection, id],
  );
  return (res.rows?.length ?? 0) > 0;
}

// ── Logs ──────────────────────────────────────────────────────────────────────

export function pgLogRequest(projectId: number, method: string, endpoint: string): void {
  // fire-and-forget — nunca bloqueia a requisição
  pg()
    .query("INSERT INTO request_logs (project_id, method, endpoint) VALUES ($1, $2, $3)", [
      projectId,
      method,
      endpoint,
    ])
    .catch(() => {});
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export async function pgGetStats(): Promise<Stats> {
  const today = new Date().toISOString().slice(0, 10);
  const [req, col, proj] = await Promise.all([
    pg().query<{ c: string }>("SELECT COUNT(*) AS c FROM request_logs WHERE created_at >= $1", [today]),
    pg().query<{ c: string }>("SELECT COUNT(DISTINCT collection || project_id::text) AS c FROM collections"),
    pg().query<{ c: string }>("SELECT COUNT(*) AS c FROM projects"),
  ]);
  return {
    requestsToday: parseInt(req.rows[0].c, 10),
    totalCollections: parseInt(col.rows[0].c, 10),
    totalProjects: parseInt(proj.rows[0].c, 10),
  };
}
