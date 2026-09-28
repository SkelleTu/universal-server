import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();
const DEFAULT_TIMEOUT_MS = 8000;

function authorized(req: Request): boolean {
  const expected = process.env.AURA_AGENT_TOKEN?.trim();
  if (!expected) return true;
  const supplied = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return supplied === expected;
}

function baseUrl(): string {
  return String(process.env.INTEGRATESYSTEM_URL ?? "").replace(/\/$/, "");
}

async function getJson(path: string) {
  const base = baseUrl();
  if (!base) return { ok: false, configured: false, reason: "INTEGRATESYSTEM_URL is not configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.INTEGRATESYSTEM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS));
  const startedAt = Date.now();
  try {
    const response = await fetch(`${base}${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    let result: unknown = null;
    try { result = text ? JSON.parse(text) : null; } catch { result = { raw: text }; }
    return {
      ok: response.ok,
      configured: true,
      statusCode: response.status,
      latencyMs: Date.now() - startedAt,
      result,
    };
  } finally {
    clearTimeout(timer);
  }
}

router.post("/agent/action", async (req: Request, res: Response): Promise<void> => {
  if (!authorized(req)) {
    res.status(401).json({ ok: false, error: "Aurora agent authorization required" });
    return;
  }

  const domain = String(req.body?.domain ?? "").trim().toLowerCase();
  const action = String(req.body?.action ?? "").trim().toLowerCase();

  if (domain !== "integratesystem") return void res.status(404).json({ ok: false, error: "Unsupported delegated domain", domain, action });
  if (!["health", "status", "diagnostics"].includes(action)) {
    res.status(400).json({ ok: false, error: "Unsupported IntegrateSystem action", available: ["health", "status", "diagnostics"] });
    return;
  }

  try {
    if (action === "health") {
      const [database, runtime] = await Promise.all([
        getJson("/api/db/status"),
        getJson("/api/runtime/status"),
      ]);
      const ok = database.ok && runtime.ok;
      res.status(ok ? 200 : 503).json({ ok, executed: true, domain, action, result: { database, runtime } });
      return;
    }

    if (action === "status") {
      const [database, runtime] = await Promise.all([
        getJson("/api/db/status"),
        getJson("/api/runtime/status"),
      ]);
      res.status(database.ok || runtime.ok ? 200 : 503).json({
        ok: database.ok && runtime.ok,
        executed: true,
        domain,
        action,
        result: { service: "integratesystem", database, runtime, timestamp: new Date().toISOString() },
      });
      return;
    }

    const runtime = await getJson("/api/runtime/status");
    res.status(runtime.ok ? 200 : 503).json({ ok: runtime.ok, executed: true, domain, action, result: runtime.result });
  } catch (error) {
    res.status(503).json({ ok: false, executed: false, domain, action, error: error instanceof Error ? error.message : "IntegrateSystem unavailable" });
  }
});

export default router;
