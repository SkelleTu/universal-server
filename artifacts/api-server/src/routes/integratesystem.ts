import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_READY_TIMEOUT_MS = 40000;
const DEFAULT_RETRY_DELAY_MS = 1200;
const ACTIONS = ["health", "status", "diagnostics"] as const;

type Correlation = { traceId: string; requestId: string; operatorMode: string };

function id(value: unknown): string {
  const text = String(value ?? "").trim();
  return text || crypto.randomUUID();
}

function correlation(req: Request): Correlation {
  return {
    traceId: id(req.headers["x-trace-id"] ?? req.body?.traceId),
    requestId: id(req.headers["x-request-id"] ?? req.body?.requestId),
    operatorMode: String(req.headers["x-aurora-operator-mode"] ?? req.body?.operatorMode ?? process.env.AURORA_OPERATOR_MODE ?? "supreme").trim().toLowerCase() || "supreme",
  };
}

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

async function getJson(path: string, correlationIds: Correlation) {
  const base = baseUrl();
  if (!base) return { ok: false, configured: false, reason: "INTEGRATESYSTEM_URL is not configured", ...correlationIds };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  const startedAt = Date.now();
  try {
    const response = await fetch(`${base}${path}`, {
      headers: {
        Accept: "application/json",
        "x-trace-id": correlationIds.traceId,
        "x-request-id": correlationIds.requestId,
        "x-aurora-operator-mode": correlationIds.operatorMode,
      },
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
      traceId: response.headers.get("x-trace-id") ?? correlationIds.traceId,
      requestId: response.headers.get("x-request-id") ?? correlationIds.requestId,
      operatorMode: response.headers.get("x-aurora-operator-mode") ?? correlationIds.operatorMode,
      result,
    };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      timedOut: error instanceof Error && error.name === "AbortError",
      traceId: correlationIds.traceId,
      requestId: correlationIds.requestId,
      operatorMode: correlationIds.operatorMode,
      reason: error instanceof Error ? error.message : "IntegrateSystem request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForReady(correlationIds: Correlation) {
  const startedAt = Date.now();
  let attempts = 0;
  let last: Awaited<ReturnType<typeof getJson>> = { ok: false, configured: Boolean(baseUrl()), reason: "not_checked", ...correlationIds };

  while (Date.now() - startedAt < readyTimeoutMs()) {
    attempts += 1;
    last = await getJson("/api/runtime/status", correlationIds);
    if (last.ok) {
      return { ok: true, state: "ready", attempts, waitedMs: Date.now() - startedAt, last, ...correlationIds };
    }
    if (Date.now() - startedAt >= readyTimeoutMs()) break;
    await sleep(retryDelayMs());
  }

  return { ok: false, state: "timeout", attempts, waitedMs: Date.now() - startedAt, last, ...correlationIds };
}

router.get("/agent/capabilities", (req, res) => {
  if (!authorized(req)) {
    res.status(401).json({ ok: false, error: "Aurora agent authorization required" });
    return;
  }
  res.json({
    ok: true,
    service: "universal-server",
    operatorMode: String(process.env.AURORA_OPERATOR_MODE ?? "supreme").trim().toLowerCase() || "supreme",
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
  const correlationIds = correlation(req);
  res.setHeader("x-trace-id", correlationIds.traceId);
  res.setHeader("x-request-id", correlationIds.requestId);
  res.setHeader("x-aurora-operator-mode", correlationIds.operatorMode);

  if (domain !== "integratesystem") return void res.status(404).json({ ok: false, error: "Unsupported delegated domain", domain, action, ...correlationIds });
  if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
    res.status(400).json({ ok: false, error: "Unsupported IntegrateSystem action", available: ACTIONS, ...correlationIds });
    return;
  }

  try {
    if (!baseUrl()) {
      res.status(503).json({ ok: false, executed: false, domain, action, state: "unconfigured", error: "IntegrateSystem is not configured", ...correlationIds });
      return;
    }

    const readiness = await waitForReady(correlationIds);
    if (!readiness.ok) {
      res.status(503).json({
        ok: false,
        executed: false,
        domain,
        action,
        state: readiness.state,
        error: "IntegrateSystem did not become ready in time",
        readiness,
        ...correlationIds,
      });
      return;
    }

    if (action === "health") {
      const [database, runtime] = await Promise.all([
        getJson("/api/db/status", correlationIds),
        getJson("/api/runtime/status", correlationIds),
      ]);
      const ok = database.ok && runtime.ok;
      res.status(ok ? 200 : 503).json({ ok, executed: true, domain, action, state: "ready", result: { database, runtime }, readiness, ...correlationIds });
      return;
    }

    if (action === "status") {
      const [database, runtime] = await Promise.all([
        getJson("/api/db/status", correlationIds),
        getJson("/api/runtime/status", correlationIds),
      ]);
      res.status(database.ok || runtime.ok ? 200 : 503).json({
        ok: database.ok && runtime.ok,
        executed: true,
        domain,
        action,
        state: "ready",
        result: { service: "integratesystem", database, runtime, timestamp: new Date().toISOString() },
        readiness,
        ...correlationIds,
      });
      return;
    }

    const runtime = await getJson("/api/runtime/status", correlationIds);
    res.status(runtime.ok ? 200 : 503).json({ ok: runtime.ok, executed: runtime.ok, domain, action, state: runtime.ok ? "ready" : "degraded", result: runtime.result, readiness, ...correlationIds });
  } catch (error) {
    res.status(503).json({ ok: false, executed: false, domain, action, state: "unavailable", error: error instanceof Error ? error.message : "IntegrateSystem unavailable", ...correlationIds });
  }
});

export default router;
