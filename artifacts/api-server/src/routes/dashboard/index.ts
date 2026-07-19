import { Router, type IRouter } from "express";
import crypto from "crypto";
import { pool } from "@workspace/db";
import {
  DashboardAuthBody,
  CreateProjectBody,
  DeleteProjectParams,
} from "@workspace/api-zod";
import { sqliteInsertProject, sqliteDeleteProject } from "../../lib/sqlite";

const router: IRouter = Router();

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD ?? "admin123";

// ── Auth ─────────────────────────────────────────────────────────────────────

router.post("/dashboard/auth", async (req, res): Promise<void> => {
  const parsed = DashboardAuthBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  res.json({ ok: parsed.data.password === DASHBOARD_PASSWORD });
});

// ── Dashboard auth middleware ─────────────────────────────────────────────────

function requireDashboard(req: Parameters<IRouter["use"]>[0] extends unknown ? never : never, res: never, next: never): void;
function requireDashboard(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction): void {
  const key = req.headers["x-dashboard-key"];
  if (key !== DASHBOARD_PASSWORD) {
    res.status(401).json({ error: "Não autorizado" });
    return;
  }
  next();
}

// ── Projects ──────────────────────────────────────────────────────────────────

router.get("/dashboard/projects", requireDashboard, async (_req, res): Promise<void> => {
  const { rows } = await pool.query("SELECT id, name, description, api_key, created_at FROM projects ORDER BY created_at DESC");
  res.json(rows);
});

router.post("/dashboard/projects", requireDashboard, async (req, res): Promise<void> => {
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, description } = parsed.data;
  const apiKey = crypto.randomBytes(32).toString("hex");

  const { rows } = await pool.query(
    "INSERT INTO projects (name, description, api_key) VALUES ($1, $2, $3) RETURNING id, name, description, api_key, created_at",
    [name, description ?? null, apiKey],
  );

  const project = rows[0];

  // Mirror to SQLite
  sqliteInsertProject(name, description ?? null, apiKey);

  res.status(201).json(project);
});

router.delete("/dashboard/projects/:id", requireDashboard, async (req, res): Promise<void> => {
  const params = DeleteProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { rows } = await pool.query("DELETE FROM projects WHERE id = $1 RETURNING id", [params.data.id]);
  if (!rows.length) {
    res.status(404).json({ error: "Projeto não encontrado" });
    return;
  }

  // Mirror to SQLite
  sqliteDeleteProject(params.data.id);

  res.json({ ok: true });
});

// ── Stats ─────────────────────────────────────────────────────────────────────

router.get("/dashboard/stats", requireDashboard, async (_req, res): Promise<void> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [reqRes, colRes, projRes] = await Promise.all([
    pool.query("SELECT COUNT(*) FROM request_logs WHERE created_at >= $1", [today]),
    pool.query("SELECT COUNT(DISTINCT collection) FROM collections"),
    pool.query("SELECT COUNT(*) FROM projects"),
  ]);

  res.json({
    requestsToday: parseInt(reqRes.rows[0].count, 10),
    totalCollections: parseInt(colRes.rows[0].count, 10),
    totalProjects: parseInt(projRes.rows[0].count, 10),
  });
});

export default router;
