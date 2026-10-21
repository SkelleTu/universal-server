import crypto from "node:crypto";

export async function executeSupremeInternal(request: { target?: "agent" | "integratesystem"; domain?: string; action?: string; args?: Record<string, unknown>; traceId?: string; requestId?: string }) {
  const traceId = request.traceId?.trim() || crypto.randomUUID();
  const requestId = request.requestId?.trim() || crypto.randomUUID();
  const operatorMode = String(process.env.AURORA_OPERATOR_MODE ?? "supreme").trim().toLowerCase() || "supreme";
  const target = request.target ?? "agent";
  const base = target === "integratesystem" ? process.env.INTEGRATESYSTEM_URL?.replace(/\/$/, "") : `http://127.0.0.1:${process.env.PORT ?? "10000"}`;
  if (!base) throw new Error("IntegrateSystem URL is not configured");
  const response = await fetch(`${base}/api/agent/action`, { method: "POST", headers: { "content-type": "application/json", "x-trace-id": traceId, "x-request-id": requestId, "x-aurora-operator-mode": operatorMode }, body: JSON.stringify({ domain: request.domain, action: request.action, args: request.args ?? {}, operatorMode, traceId, requestId }) });
  const text = await response.text();
  let result: unknown;
  try { result = text ? JSON.parse(text) : null; } catch { result = { raw: text }; }
  return { ok: response.ok, executed: true, target, status: response.status, traceId, requestId, operatorMode, result };
}
