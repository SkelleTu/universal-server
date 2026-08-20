import app from "./app";
import { logger } from "./lib/logger";
import { initPGlite } from "./lib/pglite";
import { createDurableBackup, restoreLatestBackupIfNeeded, durableBackupConfigured } from "./lib/durable-backup";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required but was not provided.");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

const backupIntervalMs = Math.max(5 * 60_000, Number(process.env.BACKUP_INTERVAL_MS ?? 15 * 60_000));
let backupRunning = false;

async function backupNow(reason: string): Promise<void> {
  if (!durableBackupConfigured() || backupRunning) return;
  backupRunning = true;
  try {
    logger.info({ reason }, "Starting durable backup");
    await createDurableBackup();
  } catch (err) {
    logger.error({ err, reason }, "Durable backup failed");
  } finally {
    backupRunning = false;
  }
}

(async () => {
  try {
    await initPGlite();
    await restoreLatestBackupIfNeeded();

    app.listen(port, (err?: Error) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port, durableBackupConfigured: durableBackupConfigured(), backupIntervalMs }, "Server listening");
    });

    if (durableBackupConfigured()) {
      setTimeout(() => void backupNow("startup"), 10_000);
      setInterval(() => void backupNow("scheduled"), backupIntervalMs);
    }

    const gracefulBackup = () => void backupNow("shutdown");
    process.once("SIGTERM", gracefulBackup);
    process.once("SIGINT", gracefulBackup);
  } catch (err) {
    logger.error({ err }, "Failed to initialize databases");
    process.exit(1);
  }
})();
