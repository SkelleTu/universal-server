import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";

const router = Router();

const RESOURCE_URL = String(process.env.MCP_RESOURCE_URL ?? "https://universal-server1.onrender.com").replace(/\/$/, "");
const OAUTH_ISSUER = String(process.env.MCP_OAUTH_ISSUER ?? "https://integrated-system-gzyu.onrender.com").replace(/\/$/, "");
const MCP_SECRET = String(process.env.MCP_OAUTH_SECRET ?? "");
const PORT = String(process.env.PORT ?? "10000");

type Claims = {
  iss: string;
  aud: string;
  sub: string;
  username?: string;
  scope?: string;
  iat: number;
  exp: number;
};

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: Record<string, boolean>;
  securitySchemes: Array<{ type: "oauth2"; scopes: string[] }>;
  _meta: { securitySchemes: Array<{ type: "oauth2"; scopes: string[] }> };
};

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function constantTime(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function verifyToken(token: string, requiredScope: string): Claims | null {
  if (!MCP_SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, payload, signature] = parts;
  let header: any;
  let claims: Claims;
  try {
    header = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header?.alg !== "HS256" || header?.typ !== "JWT") return null;
  const expected = b64url(crypto.createHmac("sha256", MCP_SECRET).update(`${head}.${payload}`).digest());
  if (!constantTime(expected, signature)) return null;
  const now = Math.floor(Date.now() / 1000);
  const scopes = String(claims.scope ?? "").split(/\s+/).filter(Boolean);
  if (claims.iss !== OAUTH_ISSUER || claims.aud !== RESOURCE_URL || !claims.sub || claims.exp <= now || claims.iat > now + 120) return null;
  if (!scopes.includes(requiredScope)) return null;
  return claims;
}

function auth(req: Request, scope: string): Claims | null {
  const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return token ? verifyToken(token, scope) : null;
}

function authChallenge(res: Response, scope: string) {
  const metadata = `${RESOURCE_URL}/.well-known/oauth-protected-resource`;
  res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${metadata}", scope="${scope}"`);
}

function jsonRpc(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function errorRpc(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const commonRead: Tool["securitySchemes"] = [{ type: "oauth2", scopes: ["aura.read"] }];
const executeSecurity: Tool["securitySchemes"] = [{ type: "oauth2", scopes: ["aura.execute"] }];

const tools: Tool[] = [
  {
    name: "get_profile",
    title: "Get connected profile",
    description: "Returns the authenticated Aura profile represented by the current OpenAI connection.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        name: { type: "string" },
        nickname: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: commonRead,
    _meta: { securitySchemes: commonRead },
  },
  {
    name: "get_universal_health",
    title: "Get Universal Server health",
    description: "Use this to inspect the health of the Universal Server without changing state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    securitySchemes: commonRead,
    _meta: { securitySchemes: commonRead },
  },
  {
    name: "get_capabilities",
    title: "Get system capabilities",
    description: "Use this to inspect the capabilities exposed through the Universal Server and Supreme Operator.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    securitySchemes: commonRead,
    _meta: { securitySchemes: commonRead },
  },
  {
    name: "get_diagnostics",
    title: "Get Aurora diagnostics",
    description: "Use this to inspect Aurora correlation and diagnostic state without changing system state.",
    inputSchema: {
      type: "object",
      properties: { traceId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    securitySchemes: commonRead,
    _meta: { securitySchemes: commonRead },
  },
  {
    name: "get_aurora_status",
    title: "Get Aurora Agent status",
    description: "Use this to check the deployed Aurora Agent health endpoint without changing state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    securitySchemes: commonRead,
    _meta: { securitySchemes: commonRead },
  },
  {
    name: "execute_supreme_action",
    title: "Execute a Supreme Operator action",
    description: "Use this only when the user explicitly asks the Aura ecosystem to perform an operation. The action is routed through the existing Supreme Operator and preserves trace and request correlation.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", minLength: 1 },
        action: { type: "string", minLength: 1 },
        args: { type: "object" },
      },
      required: ["domain", "action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    securitySchemes: executeSecurity,
    _meta: { securitySchemes: executeSecurity },
  },
];

async function localJson(path: string, options: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
    signal: options.signal ?? AbortSignal.timeout(10000),
  });
  const text = await response.text();
  let result: unknown = null;
  try { result = text ? JSON.parse(text) : null; } catch { result = { raw: text }; }
  return { ok: response.ok, status: response.status, result };
}

async function toolCall(name: string, args: any, claims: Claims) {
  const traceId = crypto.randomUUID();
  const requestId = crypto.randomUUID();

  if (name === "get_profile") {
    return { structuredContent: { id: claims.sub, name: claims.username ?? "Aura user", nickname: claims.username ?? "Aura user" }, content: [{ type: "text", text: JSON.stringify({ id: claims.sub, name: claims.username ?? "Aura user" }) }] };
  }

  if (name === "get_universal_health") {
    const result = await localJson("/api/healthz", { headers: { "x-trace-id": traceId, "x-request-id": requestId } });
    return { structuredContent: { ok: result.ok, status: result.status, result: result.result, traceId, requestId }, content: [{ type: "text", text: JSON.stringify(result.result) }] };
  }

  if (name === "get_capabilities") {
    const result = await localJson("/api/agent/capabilities", { headers: { "x-trace-id": traceId, "x-request-id": requestId, "x-aurora-operator-mode": "supreme" } });
    return { structuredContent: { ok: result.ok, status: result.status, result: result.result, traceId, requestId }, content: [{ type: "text", text: JSON.stringify(result.result) }] };
  }

  if (name === "get_diagnostics") {
    const trace = args?.traceId ? `?traceId=${encodeURIComponent(String(args.traceId))}` : "";
    const result = await localJson(`/api/diagnostics/aurora${trace}`, { headers: { "x-trace-id": traceId, "x-request-id": requestId, "x-aurora-operator-mode": "supreme" } });
    return { structuredContent: { ok: result.ok, status: result.status, result: result.result, traceId, requestId }, content: [{ type: "text", text: JSON.stringify(result.result) }] };
  }

  if (name === "get_aurora_status") {
    const base = String(process.env.AURORA_AGENT_URL ?? "https://aurora-agent-o9x5.onrender.com").replace(/\/$/, "");
    const response = await fetch(`${base}/health`, { headers: { Accept: "application/json", "x-trace-id": traceId, "x-request-id": requestId }, signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    let result: unknown = null;
    try { result = text ? JSON.parse(text) : null; } catch { result = { raw: text }; }
    return { structuredContent: { ok: response.ok, status: response.status, result, traceId, requestId }, content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (name === "execute_supreme_action") {
    const body = {
      target: "agent",
      domain: String(args?.domain ?? "").trim().toLowerCase(),
      action: String(args?.action ?? "").trim().toLowerCase(),
      args: args?.args && typeof args.args === "object" ? args.args : {},
      operatorMode: "supreme",
      traceId,
      requestId,
    };
    if (!body.domain || !body.action) throw new Error("domain and action are required");
    const result = await localJson("/api/supreme/tool", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trace-id": traceId,
        "x-request-id": requestId,
        "x-aurora-operator-mode": "supreme",
        "authorization": `Bearer ${MCP_SECRET}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(50000),
    });
    return { structuredContent: { ok: result.ok, status: result.status, executed: Boolean((result.result as any)?.executed), result: result.result, traceId, requestId }, content: [{ type: "text", text: JSON.stringify(result.result) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
}

function requireScope(req: Request, res: Response, scope: string): Claims | null {
  const claims = auth(req, scope);
  if (!claims) {
    authChallenge(res, scope);
    return null;
  }
  return claims;
}

router.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: RESOURCE_URL,
    authorization_servers: [OAUTH_ISSUER],
    scopes_supported: ["aura.read", "aura.execute"],
    resource_documentation: `${RESOURCE_URL}/mcp`,
  });
});

router.post("/mcp", async (req: Request, res: Response): Promise<void> => {
  const message = req.body ?? {};
  const id = message?.id ?? null;
  const method = String(message?.method ?? "");

  if (method === "initialize" || method === "server/discover") {
    res.json(jsonRpc(id, {
      protocolVersion: method === "server/discover" ? "2026-07-28" : "2025-11-25",
      serverInfo: { name: "aura-supreme-operator", version: "1.0.0" },
      capabilities: { tools: { listChanged: false } },
      instructions: "Use read tools to inspect the Aura ecosystem before execution. Use execute_supreme_action only for an explicit user-requested operation. The Supreme Operator is the central execution gate for Universal Server and delegated IntegrateSystem actions.",
    }));
    return;
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    res.status(202).end();
    return;
  }

  const claims = requireScope(req, res, method === "tools/call" ? "aura.execute" : "aura.read");
  if (!claims) return;

  if (method === "tools/list") {
    res.json(jsonRpc(id, { tools }));
    return;
  }

  if (method === "tools/call") {
    const name = String(message?.params?.name ?? "");
    const args = message?.params?.arguments ?? {};
    const tool = tools.find((item) => item.name === name);
    if (!tool) {
      res.json(errorRpc(id, -32602, `Unknown tool: ${name}`));
      return;
    }
    const required = tool.securitySchemes[0]?.scopes?.[0] ?? "aura.read";
    const authorized = verifyToken(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim(), required);
    if (!authorized) {
      authChallenge(res, required);
      res.json(jsonRpc(id, {
        isError: true,
        content: [{ type: "text", text: "Authentication or scope required." }],
        _meta: { "mcp/www_authenticate": [`Bearer resource_metadata="${RESOURCE_URL}/.well-known/oauth-protected-resource", scope="${required}"`] },
      }));
      return;
    }
    try {
      const result = await toolCall(name, args, authorized);
      res.json(jsonRpc(id, result));
    } catch (error) {
      res.json(jsonRpc(id, { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Tool execution failed." }] }));
    }
    return;
  }

  res.json(errorRpc(id, -32601, `Method not found: ${method}`));
});

router.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "MCP GET is not used by this stateless Streamable HTTP endpoint." });
});

export default router;
