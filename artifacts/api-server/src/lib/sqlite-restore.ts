import type { DatabaseSnapshot } from "./pglite";

/** Compatibility boundary for the removed SQLite mirror. */
export function sqReplaceFromSnapshot(_snapshot: DatabaseSnapshot): void {
  // GitHub is now the sole durable database. There is no local SQLite mirror.
}
