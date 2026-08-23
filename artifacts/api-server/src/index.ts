import app from "./app";
import { logger } from "./lib/logger";
import { initPGlite } from "./lib/pglite";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required but was not provided.");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

(async () => {
  try {
    await initPGlite();
    app.listen(port, "0.0.0.0", () => {
      logger.info(
        { host: "0.0.0.0", port, database: "github", persistentDatabase: true },
        "Universal Server listening",
      );
    });
  } catch (err) {
    logger.error({ err }, "Failed to initialize GitHub database");
    process.exit(1);
  }
})();
