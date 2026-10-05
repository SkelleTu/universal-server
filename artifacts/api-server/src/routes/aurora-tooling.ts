import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

const TOOLING = {
  version: "1.0.0",
  agent: "aurora",
  execution: {
    endpoint: "/api/agent/tooling/execute",
    maxSteps: 32,
    supportsPlanning: true,
    supportsDryRun: true,
    supportsStopOnError: true,
  },
  tools: [
    {
      name: "system.health",
      domain: "system",
      action: "health",
      description: "Verifies Universal Server health, database health and persistence state.",
      input: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "system.status",
      domain: "system",
      action: "status",
      description: "Returns service, database and runtime statistics.",
      input: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "system.capabilities",
      domain: "system",
      action: "capabilities",
      description: "Returns the currently registered Aurora action surface.",
      input: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "memory.list",
      domain: "memory",
      action: "list",
      description: "Lists persistent Aurora memories.",
      input: { type: "object", properties: { limit: { type: "number", minimum: 1, maximum: 500 } } },
    },
    {
      name: "memory.save",
      domain: "memory",
      action: "save",
      description: "Persists a new Aurora memory.",
      input: { type: "object", required: ["text"], properties: { text: { type: "string" }, tags: { type: "array", items: { type: "string" } }, source: { type: "string" } } },
    },
    {
      name: "memory.update",
      domain: "memory",
      action: "update",
      description: "Updates an existing Aurora memory.",
      input: { type: "object", required: ["id", "text"], properties: { id: { type: "number", minimum: 1 }, text: { type: "string" }, tags: { type: "array", items: { type: "string" } }, source: { type: "string" } } },
    },
    {
      name: "settings.get",
      domain: "settings",
      action: "get",
      description: "Reads an Aurora setting by key.",
      input: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    },
    {
      name: "settings.set",
      domain: "settings",
      action: "set",
      description: "Writes an Aurora setting by key.",
      input: { type: "object", required: ["key", "value"], properties: { key: { type: "string" }, value: {} } },
    },
    {
      name: "avatar.state",
      domain: "avatar",
      action: "state",
      description: "Reads the current avatar runtime state.",
      input: { type: "object", properties: {} },
    },
    {
      name: "avatar.control",
      domain: "avatar",
      action: "gesture",
      description: "Controls an avatar pose, movement or gesture through the runtime action surface.",
      input: { type: "object", properties: { target: { type: "string" } } },
    },
    {
      name: "avatar.expression",
      domain: "avatar",
      action: "setexpression",
      description: "Changes the avatar expression.",
      input: { type: "object", required: ["expression"], properties: { expression: { type: "string" } } },
    },
    {
      name: "avatar.outfit",
      domain: "avatar",
      action: "setoutfit",
      description: "Changes the avatar outfit.",
      input: { type: "object", required: ["outfit"], properties: { outfit: { type: "string" } } },
    },
    {
      name: "scene.state",
      domain: "scene",
      action: "state",
      description: "Reads the current scene runtime state.",
      input: { type: "object", properties: {} },
    },
    {
      name: "scene.set",
      domain: "scene",
      action: "set",
      description: "Selects a scene preset.",
      input: { type: "object", required: ["preset"], properties: { preset: { type: "string" } } },
    },
    {
      name: "scene.transition",
      domain: "scene",
      action: "transition",
      description: "Transitions the current scene to a preset.",
      input: { type: "object", properties: { preset: { type: "string" }, transition: { type: "string" } } },
    },
    {
      name: "animation.state",
      domain: "animation",
      action: "state",
      description: "Reads the current animation runtime state.",
      input: { type: "object", properties: {} },
    },
    {
      name: "animation.play",
      domain: "animation",
      action: "play",
      description: "Starts an animation with optional looping and speed.",
      input: { type: "object", required: ["name"], properties: { name: { type: "string" }, loop: { type: "boolean" }, speed: { type: "number", minimum: 0.01, maximum: 8 } } },
    },
    {
      name: "animation.stop",
      domain: "animation",
      action: "stop",
      description: "Stops the current animation.",
      input: { type: "object", properties: {} },
    },
    {
      name: "voice.speak",
      domain: "voice",
      action: "speak",
      description: "Requests spoken output through the Aura runtime voice surface.",
      input: { type: "object", required: ["text"], properties: { text: { type: "string" }, language: { type: "string" }, model: { type: "string" } } },
    },
    {
      name: "voice.stop",
      domain: "voice",
      action: "stop",
      description: "Stops current runtime speech.",
      input: { type: "object", properties: {} },
    },
    {
      name: "interface.notify",
      domain: "interface",
      action: "notify",
      description: "Shows an interface notification.",
      input: { type: "object", required: ["message"], properties: { message: { type: "string" } } },
    },
    {
      name: "interface.panel",
      domain: "interface",
      action: "setPanel",
      description: "Selects the active interface panel.",
      input: { type: "object", required: ["panel"], properties: { panel: { type: "string" } } },
    },
    {
      name: "integratesystem.api",
      domain: "integratesystem",
      action: "api",
      description: "Executes an authenticated operation against any supported Aura System /api module through the trusted service bridge.",
      input: {
        type: "object",
        required: ["method", "path"],
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          path: { type: "string", pattern: "^/api/" },
          query: { type: "object" },
          body: {},
        },
      },
    },
    {
      name: "interface.status",
      domain: "interface",
      action: "setStatus",
      description: "Sets the visible interface status text.",
      input: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    },
  ],
} as const;

function authorized(req: Request): boolean {
  const expected = (process.env.AURA_AGENT_TOKEN || process.env.AURORA_OPERATOR_TOKEN)?.trim();
  if (!expected) return false;
  const supplied = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return supplied === expected;
}

function validObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toolFor(name: string) {
  return TOOLING.tools.find((tool) => tool.name === name);
}

router.get("/agent/tooling", (req, res) => {
  if (!authorized(req)) {
    res.status(401).json({ ok: false, error: "Aurora agent authorization required" });
    return;
  }
  res.json({ ok: true, ...TOOLING, timestamp: new Date().toISOString() });
});

router.post("/agent/tooling/execute", async (req: Request, res: Response): Promise<void> => {
  if (!authorized(req)) {
    res.status(401).json({ ok: false, error: "Aurora agent authorization required" });
    return;
  }

  const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
  const dryRun = req.body?.dryRun === true;
  const stopOnError = req.body?.stopOnError !== false;
  const maxSteps = Math.min(Math.max(Number(req.body?.maxSteps) || TOOLING.execution.maxSteps, 1), TOOLING.execution.maxSteps);

  if (steps.length === 0) {
    res.status(400).json({ ok: false, error: "steps must contain at least one tooling step" });
    return;
  }
  if (steps.length > maxSteps) {
    res.status(400).json({ ok: false, error: `too many steps; maximum is ${maxSteps}` });
    return;
  }

  const plan = steps.map((step: unknown, index: number) => {
    const item = validObject(step) ? step : {};
    const name = String(item.tool ?? "").trim();
    const tool = toolFor(name);
    return {
      index,
      tool: name,
      domain: tool?.domain ?? null,
      action: tool?.action ?? null,
      args: validObject(item.args) ? item.args : {},
      supported: Boolean(tool),
    };
  });

  const unsupported = plan.filter((step: (typeof plan)[number]) => !step.supported);
  if (unsupported.length > 0) {
    res.status(400).json({ ok: false, error: "unsupported tooling step", unsupported, availableTools: TOOLING.tools.map((tool) => tool.name) });
    return;
  }

  if (dryRun) {
    res.json({ ok: true, executed: false, dryRun: true, plan });
    return;
  }

  const origin = `${req.protocol}://${req.get("host")}`;
  const results: Array<Record<string, unknown>> = [];

  for (const step of plan) {
    try {
      const response = await fetch(`${origin}/api/agent/action`, {
        method: "POST",
        headers: {
          authorization: String(req.headers.authorization ?? ""),
          "content-type": "application/json",
          "x-trace-id": String(req.headers["x-trace-id"] ?? crypto.randomUUID()),
          "x-request-id": String(req.headers["x-request-id"] ?? crypto.randomUUID()),
          "x-aurora-tooling": "1",
        },
        body: JSON.stringify({ domain: step.domain, action: step.action, args: step.args }),
      });
      const text = await response.text();
      let body: unknown;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
      const result = { index: step.index, tool: step.tool, ok: response.ok, status: response.status, body };
      results.push(result);
      if (!response.ok && stopOnError) break;
    } catch (error) {
      results.push({ index: step.index, tool: step.tool, ok: false, error: error instanceof Error ? error.message : "tool execution failed" });
      if (stopOnError) break;
    }
  }

  const failed = results.find((result) => result.ok !== true);
  res.status(failed ? 207 : 200).json({
    ok: !failed,
    executed: true,
    dryRun: false,
    completedSteps: results.filter((result) => result.ok === true).length,
    requestedSteps: plan.length,
    results,
  });
});

export default router;
