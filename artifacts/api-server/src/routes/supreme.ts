import { Router, type NextFunction, type Request, type Response } from "express";

const router = Router();

function configuredMode(): string {
  return String(process.env.AURORA_OPERATOR_MODE ?? "supreme").trim().toLowerCase() || "supreme";
}

function requestedMode(req: Request): string {
  return String(req.headers["x-aurora-operator-mode"] ?? req.body?.operatorMode ?? "supreme").trim().toLowerCase() || "supreme";
}

function authToken(req: Request): boolean {
  const expected = process.env.AURA_AGENT_TOKEN?.trim();
  if (!expected) return true;
  const supplied = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return supplied === expected;
}

router.use("/agent", (req: Request, res: Response, next: NextFunction) => {
  const mode = requestedMode(req);
  const allowed = configuredMode();
  const traceId = String(req.headers["x-trace-id"] ?? "").trim() || crypto.randomUUID();
  const requestId = String(req.headers["x-request-id"] ?? "").trim() || crypto.randomUUID();

  res.setHeader("x-trace-id", traceId);
  res.setHeader("x-request-id", requestId);
  res.setHeader("x-aurora-operator-mode", allowed);
  res.locals.traceId = traceId;
  res.locals.requestId = requestId;
  res.locals.operatorMode = allowed;

  if (mode !== allowed) {
    res.status(403).json({
      ok: false,
      error: "Aurora operator mode is not permitted",
      requestedMode: mode,
      activeMode: allowed,
      traceId,
      requestId,
    });
    return;
  }

  next();
});

router.get("/supreme/tool", (req: Request, res: Response) => {
  if (!authToken(req)) {
    res.status(401).json({ ok: false, error: "Aurora agent authorization required" });
    return;
  }
  const mode = configuredMode();
  res.json({
    ok: true,
    name: "supreme_operator",
    version: "1.0.0",
    operatorMode: mode,
    transport: "http",
    entrypoint: "/api/supreme/tool",
    capabilities: ["health", "capabilities", "diagnostics", "action", "integratesystem"],
    correlation: ["traceId", "requestId"],
    actionSchema: {
      type: "object",
      required: ["domain", "action"],
      properties: {
        domain: { type: "string" },
        action: { type: "string" },
        args: { type: "object" },
        operatorMode: { type: "string", enum: ["supreme"] },
      },
    },
  });
});

router.post("/supreme/tool", async (req: Request, res: Response): Promise<void> => {
  if (!authToken(req)) {
    res.status(401).json({ ok: false, error: "Aurora agent authorization required" });
    return;
  }

  const mode = requestedMode(req);
  const allowed = configuredMode();
  const traceId = String(req.headers["x-trace-id"] ?? req.body?.traceId ?? "").trim() || crypto.randomUUID();
  const requestId = String(req.headers["x-request-id"] ?? req.body?.requestId ?? "").trim() || crypto.randomUUID();

  if (mode !== allowed) {
    res.status(403).json({ ok: false, error: "Aurora operator mode is not permitted", requestedMode: mode, activeMode: allowed, traceId, requestId });
    return;
  }

  const target = String(req.body?.target ?? "agent").trim().toLowerCase();
  if (target === "integratesystem") {
    const base = process.env.INTEGRATESYSTEM_URL?.replace(/\/$/, "");
    if (!base) {
      res.status(503).json({ ok: false, error: "IntegrateSystem URL is not configured", traceId, requestId, operatorMode: allowed });
      return;
    }
    const path = String(req.body?.path ?? "/api/health").trim() || "/api/health";
    const response = await fetch(`${base}/${path.replace(/^\//, "")}`, {
      method: String(req.body?.method ?? "GET").toUpperCase(),
      headers: {
        ...(process.env.INTEGRATESYSTEM_TOKEN ? { authorization: `Bearer ${process.env.INTEGRATESYSTEM_TOKEN}` } : {}),
        "x-trace-id": traceId,
        "x-request-id": requestId,
        "x-aurora-operator-mode": allowed,
        ...(req.body?.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(req.body?.body !== undefined ? { body: JSON.stringify(req.body.body) } : {}),
    });
    const text = await response.text();
    let result: unknown;
    try { result = text ? JSON.parse(text) : null; } catch { result = { raw: text }; }
    res.status(response.ok ? 200 : response.status).json({ ok: response.ok, executed: true, target, status: response.status, traceId, requestId, operatorMode: allowed, result });
    return;
  }

  const body = {
    domain: req.body?.domain,
    action: req.body?.action,
    args: req.body?.args ?? {},
    operatorMode: allowed,
    traceId,
    requestId,
  };
  const port = process.env.PORT ?? "10000";
  const response = await fetch(`http://127.0.0.1:${port}/api/agent/action`, {
    method: "POST",
    headers: {
      ...(req.headers.authorization ? { authorization: String(req.headers.authorization) } : {}),
      "content-type": "application/json",
      "x-trace-id": traceId,
      "x-request-id": requestId,
      "x-aurora-operator-mode": allowed,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let result: unknown;
  try { result = text ? JSON.parse(text) : null; } catch { result = { raw: text }; }
  res.status(response.ok ? 200 : response.status).json({ ok: response.ok, executed: true, target: "agent", status: response.status, traceId, requestId, operatorMode: allowed, result });
});

export default router;
