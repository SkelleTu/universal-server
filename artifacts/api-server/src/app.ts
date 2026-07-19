import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API routes — sempre têm prioridade sobre qualquer rota estática
app.use("/api", router);

// Em produção (Railway), o api-server serve o dashboard como SPA estática.
// O build do dashboard gera os arquivos em artifacts/dashboard/dist/public/
// Process.cwd() = raiz do repo quando iniciado via `node artifacts/api-server/dist/index.mjs`
if (process.env.NODE_ENV === "production") {
  const dashboardDist = path.resolve(process.cwd(), "artifacts/dashboard/dist/public");

  // Arquivos estáticos (JS, CSS, assets)
  app.use(express.static(dashboardDist));

  // Fallback SPA — qualquer rota desconhecida entrega o index.html
  // para que o React Router client-side funcione
  app.get("*path", (_req, res) => {
    res.sendFile(path.join(dashboardDist, "index.html"));
  });
}

export default app;
