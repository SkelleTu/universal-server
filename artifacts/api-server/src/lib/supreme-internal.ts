import { randomUUID } from "node:crypto";

export type SupremeInternalRequest = {
  target?: "agent" | "integratesystem";
  domain?: string;
  action?: string;
  args?: Record<string, unknown>;
  path?: string;
  method?: string;
  body?: unknown;
  traceId?: string;
  requestId?: string;
};

export type SupremeInternalResult = {
  ok: boolean;
  executed: boolean;
  target: string;
  status: number;
  traceId: string;
  requestId: string;
  operatorMode: "supreme";
  result?: unknown;
  error?: string;
};

/**
 * Internal Supreme Operator entrypoint for trusted code inside Universal Server.
 * No external bearer token is required here. Public HTTP access remains behind
 * the existing Supreme Operator authentication middleware.
 */
export async function executeSupremeInternal(input: SupremeInternalRequest = {}): Promise<SupremeInternalResult> {
  const traceId = input.traceId?.trim() || randomUUID();
  const requestId = input.requestId?.trim() || randomUUID();
  const target = input.target ?? "agent";
  const port = process.env.PORT ?? "10000";

  const response = await fetch(`http://127.0.0.1:${port}/api/supreme/tool`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-aurora-operator-mode": "supreme",
      "x-trace-id": traceId,
      "x-request-id": requestId,
    },
    body: JSON.stringify({ ...input, target, operatorMode: "supreme", traceId, requestId }),
  });

  const text = await response.text();
  let result: unknown;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    result = { raw: text };
  }

  return {
    ok: response.ok,
    executed: true,
    target,
    status: response.status,
    traceId,
    requestId,
    operatorMode: "supreme",
    result,
  };
}
