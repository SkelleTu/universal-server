import app from "./app";
import { logger } from "./lib/logger";
import { initPGlite, pgFlushPersistence } from "./lib/pglite";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required but was not provided.");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

(async () => {
  try {
    await initPGlite();
    const server = app.listen(port, "0.0.0.0", () => {
      logger.info(
        { host: "0.0.0.0", port, database: "github", persistentDatabase: true },
        "Universal Server listening",
      );
    });

    let shuttingDown = false;
    const gracefulShutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, "Graceful shutdown requested");
      try {
        await pgFlushPersistence(signal);
      } catch (err) {
        logger.error({ err, signal }, "Final GitHub database flush failed");
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      process.exit(0);
    };

    process.once("SIGTERM", () => void gracefulShutdown("SIGTERM"));
    process.once("SIGINT", () => void gracefulShutdown("SIGINT"));
  } catch (err) {
    logger.error({ err }, "Failed to initialize GitHub database");
    process.exit(1);
  }
})();
