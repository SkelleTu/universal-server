import { Router, type IRouter } from "express";

const router: IRouter = Router();

const startTime = Date.now();

router.get("/healthz", (_req, res): void => {
  res.json({ status: "ok", uptime: Math.floor((Date.now() - startTime) / 1000) });
});

export default router;
