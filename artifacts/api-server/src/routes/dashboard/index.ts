import crypto from "node:crypto";
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
import { getMcpMonitorSnapshot, streamMcpMonitor } from "../mcp";

const router: IRouter = Router();

// Nunca use uma senha administrativa padrão em produção.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD?.trim();
if (!DASHBOARD_PASSWORD) {
  throw new Error("DASHBOARD_PASSWORD environment variable is required.");
}

// ── Auth ──────────────────────────────────────────────────────────────────────

router.post("/dashboard/auth", (req, res): void => {
  const { password } = req.body as { password?: string };
  if (!password) {
    res.status(400).json({ error: "Campo password é obrigatório" });
    return;
  }
  const ok = password === DASHBOARD_PASSWORD;
  if (ok) {
    // A sessão mestre é HttpOnly: o JavaScript da página nunca recebe a chave.
    const issuedAt = Date.now();
    const nonce = crypto.randomBytes(24).toString("base64url");
    const payload = `v1.${issuedAt}.${nonce}`;
    const signature = crypto.createHmac("sha256", DASHBOARD_PASSWORD).update(payload).digest("base64url");
    const cookie = `${payload}.${signature}`;
    res.cookie("universal_master_session", cookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 30,
      path: "/",
    });
  }
  res.json({ ok });
});

router.post("/dashboard/logout", (_req, res): void => {
  res.clearCookie("universal_master_session", { path: "/" });
  res.json({ ok: true });
});

// ── Middleware de autenticação ─────────────────────────────────────────────────

function validMasterCookie(raw: string | undefined): boolean {
  if (!raw) return false;
  const parts = raw.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const issuedAt = Number(parts[1]);
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > 1000 * 60 * 60 * 24 * 30 || issuedAt > Date.now() + 60_000) return false;
  const payload = parts.slice(0, 3).join(".");
  const expected = crypto.createHmac("sha256", DASHBOARD_PASSWORD).update(payload).digest("base64url");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[3]));
}

export function requireDashboard(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-dashboard-key"];
  if (key === DASHBOARD_PASSWORD) {
    next();
    return;
  }
  const cookieHeader = String(req.headers.cookie ?? "");
  const cookie = cookieHeader.split(";").map((item) => item.trim()).find((item) => item.startsWith("universal_master_session="))?.slice("universal_master_session=".length);
  if (validMasterCookie(cookie)) {
    next();
    return;
  }
  res.status(401).json({ error: "Não autorizado" });
}

// ── MCP control room ─────────────────────────────────────────────────────────
router.get("/dashboard/mcp", requireDashboard, (_req, res): void => {
  res.json(getMcpMonitorSnapshot());
});

router.get("/dashboard/mcp/stream", requireDashboard, (_req, res): void => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  streamMcpMonitor(res);
});

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
