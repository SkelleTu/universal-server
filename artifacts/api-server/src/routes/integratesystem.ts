import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_READY_TIMEOUT_MS = 40000;
const DEFAULT_RETRY_DELAY_MS = 1200;
const ACTIONS = ["health", "status", "diagnostics"] as const;

function authorized(req: Request): boolean {
  const expected = process.env.AURA_AGENT_TOKEN?.trim();
  if (!expected) return true;
  const supplied = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return supplied === expected;
}

function baseUrl(): string {
  return String(process.env.INTEGRATESYSTEM_URL ?? "").replace(/\/$/, "");
}

function timeoutMs(): number {
  const value = Number(process.env.INTEGRATESYSTEM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_TIMEOUT_MS;
}

function readyTimeoutMs(): number {
  const value = Number(process.env.INTEGRATESYSTEM_READY_TIMEOUT_MS ?? DEFAULT_READY_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 5000 ? value : DEFAULT_READY_TIMEOUT_MS;
}

function retryDelayMs(): number {
  const value = Number(process.env.INTEGRATESYSTEM_RETRY_DELAY_MS ?? DEFAULT_RETRY_DELAY_MS);
  return Number.isFinite(value) && value >= 100 ? value : DEFAULT_RETRY_DELAY_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(path: string) {
  const base = baseUrl();
  if (!base) return { ok: false, configured: false, reason: "INTEGRATESYSTEM_URL is not configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
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
  } catch (error) {
    return {
      ok: false,
      configured: true,
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      timedOut: error instanceof Error && error.name === "AbortError",
      reason: error instanceof Error ? error.message : "IntegrateSystem request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForReady() {
  const startedAt = Date.now();
  let attempts = 0;
  let last: Awaited<ReturnType<typeof getJson>> = { ok: false, configured: Boolean(baseUrl()), reason: "not_checked" };

  while (Date.now() - startedAt < readyTimeoutMs()) {
    attempts += 1;
    last = await getJson("/api/runtime/status");
    if (last.ok) {
      return { ok: true, state: "ready", attempts, waitedMs: Date.now() - startedAt, last };
    }
    if (Date.now() - startedAt >= readyTimeoutMs()) break;
    await sleep(retryDelayMs());
  }

  return { ok: false, state: "timeout", attempts, waitedMs: Date.now() - startedAt, last };
}

router.get("/agent/capabilities", (req, res) => {
  if (!authorized(req)) {
    res.status(401).json({ ok: false, error: "Aurora agent authorization required" });
    return;
  }
  res.json({
    ok: true,
    service: "universal-server",
    delegatedServices: {
      integratesystem: {
        configured: Boolean(baseUrl()),
        actions: ACTIONS,
        readiness: {
          timeoutMs: readyTimeoutMs(),
          requestTimeoutMs: timeoutMs(),
          retryDelayMs: retryDelayMs(),
        },
      },
    },
    timestamp: new Date().toISOString(),
  });
});

router.post("/agent/action", async (req: Request, res: Response): Promise<void> => {
  if (!authorized(req)) {
    res.status(401).json({ ok: false, error: "Aurora agent authorization required" });
    return;
  }

  const domain = String(req.body?.domain ?? "").trim().toLowerCase();
  const action = String(req.body?.action ?? "").trim().toLowerCase();

  if (domain !== "integratesystem") return void res.status(404).json({ ok: false, error: "Unsupported delegated domain", domain, action });
  if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
    res.status(400).json({ ok: false, error: "Unsupported IntegrateSystem action", available: ACTIONS });
    return;
  }

  try {
    if (!baseUrl()) {
      res.status(503).json({ ok: false, executed: false, domain, action, state: "unconfigured", error: "IntegrateSystem is not configured" });
      return;
    }

    const readiness = await waitForReady();
    if (!readiness.ok) {
      res.status(503).json({
        ok: false,
        executed: false,
        domain,
        action,
        state: readiness.state,
        error: "IntegrateSystem did not become ready in time",
        readiness,
      });
      return;
    }

    if (action === "health") {
      const [database, runtime] = await Promise.all([
        getJson("/api/db/status"),
        getJson("/api/runtime/status"),
      ]);
      const ok = database.ok && runtime.ok;
      res.status(ok ? 200 : 503).json({ ok, executed: true, domain, action, state: "ready", result: { database, runtime }, readiness });
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
        state: "ready",
        result: { service: "integratesystem", database, runtime, timestamp: new Date().toISOString() },
        readiness,
      });
      return;
    }

    const runtime = await getJson("/api/runtime/status");
    res.status(runtime.ok ? 200 : 503).json({ ok: runtime.ok, executed: runtime.ok, domain, action, state: runtime.ok ? "ready" : "degraded", result: runtime.result, readiness });
  } catch (error) {
    res.status(503).json({ ok: false, executed: false, domain, action, state: "unavailable", error: error instanceof Error ? error.message : "IntegrateSystem unavailable" });
  }
});

export default router;
