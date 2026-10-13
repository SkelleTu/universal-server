import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import router from "./routes";
import healthRouter from "./routes/health";
import mcpRouter from "./routes/mcp";
import invistaRemoteAccessRouter from "./routes/invista-remote-access";
import { logger } from "./lib/logger";

const app: Express = express();

app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          // Do not log query strings: one-time SSO grants must never appear in logs.
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

const isProduction = process.env.NODE_ENV === "production";
const configuredOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (isProduction && configuredOrigins.includes("*")) {
  throw new Error("CORS_ORIGINS must not contain '*' in production.");
}

app.use(
  cors({
    origin: isProduction
      ? configuredOrigins
      : configuredOrigins.length > 0
        ? configuredOrigins
        : true,
    credentials: true,
  }),
);

// Mantém payloads do mundo/mapa sob controle para evitar uploads acidentais gigantes.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT ?? "2mb" }));
app.use(express.urlencoded({ extended: true, limit: process.env.JSON_BODY_LIMIT ?? "2mb" }));

// MCP public protocol boundary. The API router remains under /api.
app.use(mcpRouter);

// Health endpoints must be available at the root before the SPA fallback.
// Keep /api/healthz and /api/health aliases through the API router as well.
app.use(healthRouter);

// Short-lived, server-to-server browser SSO grants. Must be mounted before the SPA.
app.use("/api", invistaRemoteAccessRouter);

// API routes — sempre têm prioridade sobre qualquer rota estática
app.use("/api", router);

// Em produção (Railway/Replit), o api-server serve o dashboard como SPA estática.
// O build do dashboard gera os arquivos em artifacts/dashboard/dist/public/
if (process.env.NODE_ENV === "production") {
  const here = typeof __dirname !== "undefined" ? __dirname : process.cwd();
  const dashboardDist = path.resolve(here, "../../../artifacts/dashboard/dist/public");
  app.use(express.static(dashboardDist));
  app.get("*path", (_req, res) => {
    res.sendFile(path.join(dashboardDist, "index.html"));
  });
}

export default app;
