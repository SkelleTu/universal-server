import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  pgListProjects,
  pgInsertProject,
  pgDeleteProject,
  pgGetStats,
} from "../../lib/pglite";
import {
  sqMirrorInsertProject,
  sqMirrorDeleteProject,
} from "../../lib/sqlite";

const router: IRouter = Router();

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD ?? "admin123";

// ── Auth ──────────────────────────────────────────────────────────────────────

router.post("/dashboard/auth", (req, res): void => {
  const { password } = req.body as { password?: string };
  if (!password) {
    res.status(400).json({ error: "Campo password é obrigatório" });
    return;
  }
  res.json({ ok: password === DASHBOARD_PASSWORD });
});

// ── Middleware de autenticação ─────────────────────────────────────────────────

function requireDashboard(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-dashboard-key"];
  if (key !== DASHBOARD_PASSWORD) {
    res.status(401).json({ error: "Não autorizado" });
    return;
  }
  next();
}

// ── Projects ──────────────────────────────────────────────────────────────────

router.get("/dashboard/projects", requireDashboard, async (_req, res): Promise<void> => {
  const projects = await pgListProjects();
  res.json(projects);
});

router.post("/dashboard/projects", requireDashboard, async (req, res): Promise<void> => {
  const { name, description } = req.body as { name?: string; description?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: "Campo name é obrigatório" });
    return;
  }
  try {
    const project = await pgInsertProject(name.trim(), description?.trim() ?? null);
    // Espelho SQLite (fire-and-forget)
    sqMirrorInsertProject(project.name, project.description, project.api_key);
    res.status(201).json(project);
  } catch (err) {
    res.status(500).json({ error: "Erro ao criar projeto" });
  }
});

router.delete("/dashboard/projects/:id", requireDashboard, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!id || isNaN(id)) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }
  const deleted = await pgDeleteProject(id);
  if (!deleted) {
    res.status(404).json({ error: "Projeto não encontrado" });
    return;
  }
  // Espelho SQLite (fire-and-forget)
  sqMirrorDeleteProject(id);
  res.json({ ok: true });
});

// ── Stats ─────────────────────────────────────────────────────────────────────

router.get("/dashboard/stats", requireDashboard, async (_req, res): Promise<void> => {
  const stats = await pgGetStats();
  res.json(stats);
});

export default router;
