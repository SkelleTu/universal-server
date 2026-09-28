import { Router, type NextFunction, type Request, type Response } from "express";

const router = Router();

function configuredMode(): string {
  return String(process.env.AURORA_OPERATOR_MODE ?? "supreme").trim().toLowerCase() || "supreme";
}

function requestedMode(req: Request): string {
  return String(req.headers["x-aurora-operator-mode"] ?? req.body?.operatorMode ?? "supreme").trim().toLowerCase() || "supreme";
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

export default router;
