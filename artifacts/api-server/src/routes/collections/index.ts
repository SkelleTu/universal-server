import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  pgGetProjectByApiKey,
  pgListCollection,
  pgGetCollectionItem,
  pgInsertCollectionItem,
  pgUpdateCollectionItem,
  pgDeleteCollectionItem,
  pgLogRequest,
} from "../../lib/pglite";
import {
  sqMirrorInsertCollection,
  sqMirrorUpdateCollection,
  sqMirrorDeleteCollection,
  sqMirrorLogRequest,
} from "../../lib/sqlite";

const router: IRouter = Router();

// ── API Key auth ──────────────────────────────────────────────────────────────

type AuthedRequest = Request & { project?: { id: number; name: string } };

async function validateApiKey(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
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

  // Logs fire-and-forget nos dois bancos
  pgLogRequest(project.id, req.method, req.path);
  sqMirrorLogRequest(project.id, req.method, req.path);

  next();
}

// ── Helper ────────────────────────────────────────────────────────────────────

function parseRow(row: { id: number; data: Record<string, unknown>; created_at: string; updated_at: string }) {
  return { id: row.id, ...row.data, createdAt: row.created_at, updatedAt: row.updated_at };
}

// ── GET /api/data/:collection ─────────────────────────────────────────────────

router.get("/data/:collection", validateApiKey, async (req: AuthedRequest, res): Promise<void> => {
  const rows = await pgListCollection(req.project!.id, req.params.collection as string);
  res.json(rows.map(parseRow));
});

// ── POST /api/data/:collection ────────────────────────────────────────────────

router.post("/data/:collection", validateApiKey, async (req: AuthedRequest, res): Promise<void> => {
  const col = req.params.collection as string;
  const data = req.body as Record<string, unknown>;
  const row = await pgInsertCollectionItem(req.project!.id, col, data);
  // Espelho SQLite
  sqMirrorInsertCollection(row.id, req.project!.id, col, data);
  res.status(201).json(parseRow(row));
});

// ── GET /api/data/:collection/:id ─────────────────────────────────────────────

router.get("/data/:collection/:id", validateApiKey, async (req: AuthedRequest, res): Promise<void> => {
  const id = Number(req.params.id);
  const row = await pgGetCollectionItem(req.project!.id, req.params.collection as string, id);
  if (!row) { res.status(404).json({ error: "Item não encontrado" }); return; }
  res.json(parseRow(row));
});

// ── PUT /api/data/:collection/:id ─────────────────────────────────────────────

router.put("/data/:collection/:id", validateApiKey, async (req: AuthedRequest, res): Promise<void> => {
  const id = Number(req.params.id);
  const data = req.body as Record<string, unknown>;
  const row = await pgUpdateCollectionItem(req.project!.id, req.params.collection as string, id, data);
  if (!row) { res.status(404).json({ error: "Item não encontrado" }); return; }
  // Espelho SQLite
  sqMirrorUpdateCollection(id, data);
  res.json(parseRow(row));
});

// ── DELETE /api/data/:collection/:id ──────────────────────────────────────────

router.delete("/data/:collection/:id", validateApiKey, async (req: AuthedRequest, res): Promise<void> => {
  const id = Number(req.params.id);
  const ok = await pgDeleteCollectionItem(req.project!.id, req.params.collection as string, id);
  if (!ok) { res.status(404).json({ error: "Item não encontrado" }); return; }
  // Espelho SQLite
  sqMirrorDeleteCollection(id);
  res.json({ ok: true, deleted: id });
});

export default router;
