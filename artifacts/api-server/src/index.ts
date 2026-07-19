import app from "./app";
import { logger } from "./lib/logger";
import { initPGlite } from "./lib/pglite";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Inicializa o PGlite (PostgreSQL embedded) antes de aceitar requisições
(async () => {
  try {
    await initPGlite();

    app.listen(port, (err?: Error) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");
    });
  } catch (err) {
    logger.error({ err }, "Failed to initialize databases");
    process.exit(1);
  }
})();

