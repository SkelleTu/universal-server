import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  ListCollectionItemsParams,
  CreateCollectionItemParams,
  GetCollectionItemParams,
  UpdateCollectionItemParams,
  DeleteCollectionItemParams,
} from "@workspace/api-zod";
import {
  sqliteInsertCollection,
  sqliteUpdateCollection,
  sqliteDeleteCollection,
  sqliteLogRequest,
} from "../../lib/sqlite";

const router: IRouter = Router();

// ── API Key auth middleware ───────────────────────────────────────────────────

async function validateApiKey(
  req: import("express").Request & { project?: Record<string, unknown> },
  res: import("express").Response,
  next: import("express").NextFunction,
): Promise<void> {
  const apiKey = (req.headers["x-api-key"] as string | undefined) ?? (req.query["api_key"] as string | undefined);
  if (!apiKey) {
    res.status(401).json({ error: "Header x-api-key é obrigatório" });
    return;
  }

  const { rows } = await pool.query("SELECT id, name FROM projects WHERE api_key = $1", [apiKey]);
  if (!rows.length) {
    res.status(403).json({ error: "Chave de API inválida" });
    return;
  }

  req.project = rows[0] as Record<string, unknown>;

  // Fire-and-forget log (both PG and SQLite)
  const projectId = rows[0].id as number;
  pool
    .query(
      "INSERT INTO request_logs (project_id, method, endpoint, status) VALUES ($1, $2, $3, $4)",
      [projectId, req.method, req.path, 200],
    )
    .catch(() => {});
  sqliteLogRequest(projectId, req.method, req.path);

  next();
}

// ── GET /api/data/:collection ─────────────────────────────────────────────────

router.get("/data/:collection", validateApiKey, async (req: import("express").Request & { project?: Record<string, unknown> }, res): Promise<void> => {
  const params = ListCollectionItemsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const projectId = (req.project!.id) as number;
  const { rows } = await pool.query(
    "SELECT id, data, created_at, updated_at FROM collections WHERE project_id = $1 AND collection = $2 ORDER BY created_at DESC",
    [projectId, params.data.collection],
  );

  res.json(rows.map((r) => ({ id: r.id, ...r.data, createdAt: r.created_at, updatedAt: r.updated_at })));
});

// ── POST /api/data/:collection ────────────────────────────────────────────────

router.post("/data/:collection", validateApiKey, async (req: import("express").Request & { project?: Record<string, unknown> }, res): Promise<void> => {
  const params = CreateCollectionItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const projectId = (req.project!.id) as number;
  const data = req.body as Record<string, unknown>;

  const { rows } = await pool.query(
    "INSERT INTO collections (project_id, collection, data) VALUES ($1, $2, $3) RETURNING id, data, created_at",
    [projectId, params.data.collection, data],
  );

  const r = rows[0];
  sqliteInsertCollection(projectId, params.data.collection, data);

  res.status(201).json({ id: r.id, ...r.data, createdAt: r.created_at });
});

// ── GET /api/data/:collection/:id ─────────────────────────────────────────────

router.get("/data/:collection/:id", validateApiKey, async (req: import("express").Request & { project?: Record<string, unknown> }, res): Promise<void> => {
  const params = GetCollectionItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const projectId = (req.project!.id) as number;
  const { rows } = await pool.query(
    "SELECT id, data, created_at, updated_at FROM collections WHERE project_id = $1 AND collection = $2 AND id = $3",
    [projectId, params.data.collection, params.data.id],
  );

  if (!rows.length) {
    res.status(404).json({ error: "Item não encontrado" });
    return;
  }

  const r = rows[0];
  res.json({ id: r.id, ...r.data, createdAt: r.created_at, updatedAt: r.updated_at });
});

// ── PUT /api/data/:collection/:id ─────────────────────────────────────────────

router.put("/data/:collection/:id", validateApiKey, async (req: import("express").Request & { project?: Record<string, unknown> }, res): Promise<void> => {
  const params = UpdateCollectionItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const projectId = (req.project!.id) as number;
  const data = req.body as Record<string, unknown>;

  const { rows } = await pool.query(
    "UPDATE collections SET data = $1, updated_at = NOW() WHERE project_id = $2 AND collection = $3 AND id = $4 RETURNING id, data, updated_at",
    [data, projectId, params.data.collection, params.data.id],
  );

  if (!rows.length) {
    res.status(404).json({ error: "Item não encontrado" });
    return;
  }

  const r = rows[0];
  sqliteUpdateCollection(projectId, params.data.collection, params.data.id, data);

  res.json({ id: r.id, ...r.data, updatedAt: r.updated_at });
});

// ── DELETE /api/data/:collection/:id ──────────────────────────────────────────

router.delete("/data/:collection/:id", validateApiKey, async (req: import("express").Request & { project?: Record<string, unknown> }, res): Promise<void> => {
  const params = DeleteCollectionItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const projectId = (req.project!.id) as number;
  const { rows } = await pool.query(
    "DELETE FROM collections WHERE project_id = $1 AND collection = $2 AND id = $3 RETURNING id",
    [projectId, params.data.collection, params.data.id],
  );

  if (!rows.length) {
    res.status(404).json({ error: "Item não encontrado" });
    return;
  }

  sqliteDeleteCollection(projectId, params.data.collection, params.data.id);

  res.json({ ok: true, deleted: rows[0].id });
});

export default router;
