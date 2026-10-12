import { Router, type Request } from "express";

const router = Router();

type Platform = "v10" | "aura";

function authorized(req: Request): boolean {
  const configured = String(process.env.INVISTA_UNIVERSAL_SERVER_KEY ?? "").trim();
  const supplied = String(req.header("x-invista-server-key") ?? "").trim();
  if (!configured || !supplied) return false;
  const a = Buffer.from(configured, "utf8");
  const b = Buffer.from(supplied, "utf8");
  return a.length === b.length && require("node:crypto").timingSafeEqual(a, b);
}

function platformConfig(platform: Platform) {
  if (platform === "v10") {
    return {
      baseUrl: String(process.env.INVISTA_V10_BASE_URL ?? "").trim(),
      key: String(process.env.INVISTA_V10_INTERNAL_KEY ?? "").trim(),
    };
  }
  return {
    baseUrl: String(process.env.INVISTA_AURA_BASE_URL ?? "").trim(),
    key: String(process.env.INVISTA_AURA_INTERNAL_KEY ?? "").trim(),
  };
}

// Internal service bridge. It never accepts arbitrary target URLs and never returns credentials.
router.post("/invista/master-access/:platform/demo-check", async (req, res): Promise<void> => {
  if (!authorized(req)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const platform = String(req.params.platform ?? "").toLowerCase() as Platform;
  if (platform !== "v10" && platform !== "aura") {
    res.status(404).json({ ok: false, error: "platform_not_found" });
    return;
  }

  const config = platformConfig(platform);
  if (!config.baseUrl || !config.key) {
    res.status(503).json({ ok: false, platform, authenticated: false, error: "platform_bridge_not_configured" });
    return;
  }

  let target: URL;
  try {
    target = new URL(config.baseUrl);
  } catch {
    res.status(503).json({ ok: false, platform, authenticated: false, error: "platform_url_invalid" });
    return;
  }
  if (target.protocol !== "https:" && process.env.NODE_ENV === "production") {
    res.status(503).json({ ok: false, platform, authenticated: false, error: "platform_url_must_use_https" });
    return;
  }

  try {
    const response = await fetch(
      new URL(`/api/internal/platform/${platform}/master/demo-auth-check`, target),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-invista-server-key": config.key,
        },
        body: "{}",
        signal: AbortSignal.timeout(12_000),
      },
    );

    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      res.status(response.status === 401 || response.status === 403 ? 502 : response.status).json({
        ok: false, platform, authenticated: false,
        error: response.status === 401 || response.status === 403 ? "platform_internal_auth_failed" : "platform_auth_check_failed",
      });
      return;
    }

    // Enforce response platform binding; don't accept a cross-platform or malformed response.
    if (!payload || payload.platform !== platform || typeof payload.authenticated !== "boolean") {
      res.status(502).json({ ok: false, platform, authenticated: false, error: "platform_response_mismatch" });
      return;
    }
    res.status(200).json({
      ok: payload.ok === true,
      platform,
      masterFound: payload.masterFound === true,
      demoTokenPresent: payload.demoTokenPresent === true,
      authenticated: payload.authenticated === true,
      accountType: payload.authenticated === true ? "demo" : null,
    });
  } catch (error) {
    const isTimeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    res.status(502).json({
      ok: false, platform, authenticated: false,
      error: isTimeout ? "platform_auth_check_timeout" : "platform_unreachable",
    });
  }
});

export default router;
