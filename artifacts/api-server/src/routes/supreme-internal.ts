import crypto from "node:crypto";

export type SupremeTarget = "agent" | "integratesystem";

export interface SupremeInternalRequest {
  target?: SupremeTarget;
  domain?: string;
  action?: string;
  args?: Record<string, unknown>;
  traceId?: string;
  requestId?: string;
}

export async function executeSupremeInternal(request: SupremeInternalRequest) {
  const traceId = request.traceId?.trim() || crypto.randomUUID();
  const requestId = request.requestId?.trim() || crypto.randomUUID();
  const operatorMode = String(process.env.AURORA_OPERATOR_MODE ?? "supreme").trim().toLowerCase() || "supreme";
  const target = request.target ?? "agent";

  if (target === "integratesystem") {
    const base = process.env.INTEGRATESYSTEM_URL?.replace(/\/$/, "");
    if (!base) throw new Error("IntegrateSystem URL is not configured");
    const response = await fetch(`${base}/api/agent/action`, {
      method: "POST",
      headers: {
        ...(process.env.INTEGRATESYSTEM_TOKEN ? { authorization: `Bearer ${process.env.INTEGRATESYSTEM_TOKEN}` } : {}),
        "content-type": "application/json",
        "x-trace-id": traceId,
        "x-request-id": requestId,
        "x-aurora-operator-mode": operatorMode,
      },
      body: JSON.stringify({
        domain: request.domain,
        action: request.action,
        args: request.args ?? {},
        operatorMode,
        traceId,
        requestId,
      }),
    });
    const text = await response.text();
    let result: unknown;
    try { result = text ? JSON.parse(text) : null; } catch { result = { raw: text }; }
    return { ok: response.ok, executed: true, target, status: response.status, traceId, requestId, operatorMode, result };
  }

  const port = process.env.PORT ?? "10000";
  const response = await fetch(`http://127.0.0.1:${port}/api/agent/action`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-trace-id": traceId,
      "x-request-id": requestId,
      "x-aurora-operator-mode": operatorMode,
    },
    body: JSON.stringify({
      domain: request.domain,
      action: request.action,
      args: request.args ?? {},
      operatorMode,
      traceId,
      requestId,
    }),
  });
  const text = await response.text();
  let result: unknown;
  try { result = text ? JSON.parse(text) : null; } catch { result = { raw: text }; }
  return { ok: response.ok, executed: true, target: "agent", status: response.status, traceId, requestId, operatorMode, result };
}
