import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import router from "./routes";
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

// API routes — sempre têm prioridade sobre qualquer rota estática
app.use("/api", router);

// Em produção (Railway/Replit), o api-server serve o dashboard como SPA estática.
// O build do dashboard gera os arquivos em artifacts/dashboard/dist/public/
if (process.env.NODE_ENV === "production") {
  const dashboardDist = path.resolve(process.cwd(), "artifacts/dashboard/dist/public");
  app.use(express.static(dashboardDist));
  app.get("*path", (_req, res) => {
    res.sendFile(path.join(dashboardDist, "index.html"));
  });
}

export default app;
