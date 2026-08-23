import {
  initGitHubDatabase,
  createProject,
  deleteProject,
  insertCollection,
  updateCollection,
  deleteCollection,
  insertLog,
  upsertGameCache,
  deleteGameCache,
  getProjectByApiKey,
  listProjects,
  listCollection,
  getCollectionItem,
  getGameCache,
  listGameCache,
  listGameCacheSince,
  getStats,
  databaseSnapshot,
  databaseHasPersistentData,
  restoreDatabase,
  githubDatabaseHealth,
  type Project,
  type CollectionRow,
  type GameCacheRow,
  type DatabaseSnapshot,
} from "./github-db";

export type { Project, CollectionRow, GameCacheRow, DatabaseSnapshot } from "./github-db";
export type Stats = { requestsToday: number; totalCollections: number; totalProjects: number; totalGameCacheEntries: number };

// Compatibility facade: existing routes keep their pg* API, but the primary
// database now lives in GitHub. No PGlite/WASM or local database is created.
export async function initPGlite(): Promise<void> {
  await initGitHubDatabase();
}

export async function pgListProjects(): Promise<Project[]> { return listProjects(); }
export async function pgGetProjectByApiKey(apiKey: string): Promise<Project | null> { return getProjectByApiKey(apiKey); }
export async function pgInsertProject(name: string, description: string | null): Promise<Project> { return createProject(name, description); }
export async function pgGetOrCreateSystemProject(): Promise<Project> {
  const existing = listProjects().find((project) => project.name === "Clamour public game");
  return existing ?? createProject("Clamour public game", "Internal project for public player accounts.");
}
export async function pgDeleteProject(id: number): Promise<boolean> { return deleteProject(id); }

export async function pgListCollection(projectId: number, collection: string, limit = 1000): Promise<CollectionRow[]> { return listCollection(projectId, collection, limit); }
export async function pgGetCollectionItem(projectId: number, collection: string, id: number): Promise<CollectionRow | null> { return getCollectionItem(projectId, collection, id); }
export async function pgInsertCollectionItem(projectId: number, collection: string, data: Record<string, unknown>): Promise<CollectionRow> { return insertCollection(projectId, collection, data); }
export async function pgUpdateCollectionItem(projectId: number, collection: string, id: number, data: Record<string, unknown>): Promise<CollectionRow | null> { return updateCollection(projectId, collection, id, data); }
export async function pgDeleteCollectionItem(projectId: number, collection: string, id: number): Promise<boolean> { return deleteCollection(projectId, collection, id); }

export async function pgGetGameCache(projectId: number, namespace: string, cacheKey: string): Promise<GameCacheRow | null> { return getGameCache(projectId, namespace, cacheKey); }
export async function pgListGameCache(projectId: number, namespace: string, limit = 100): Promise<GameCacheRow[]> { return listGameCache(projectId, namespace, limit); }
export async function pgListGameCacheSince(projectId: number, namespace: string, since: string, limit = 100): Promise<GameCacheRow[]> { return listGameCacheSince(projectId, namespace, since, limit); }
export async function pgUpsertGameCache(projectId: number, namespace: string, cacheKey: string, data: Record<string, unknown>, expiresAt: string | null): Promise<GameCacheRow> { return upsertGameCache(projectId, namespace, cacheKey, data, expiresAt); }
export async function pgDeleteGameCache(projectId: number, namespace: string, cacheKey: string): Promise<boolean> { return deleteGameCache(projectId, namespace, cacheKey); }

export async function pgGetDatabaseHealth(): Promise<{ ok: boolean; latencyMs: number }> { return githubDatabaseHealth(); }
export function pgLogRequest(projectId: number, method: string, endpoint: string): void {
  void insertLog(projectId, method, endpoint).catch(() => undefined);
}
export async function pgGetStats(): Promise<Stats> { return getStats(); }
export async function pgHasPersistentData(): Promise<boolean> { return databaseHasPersistentData(); }
export async function pgExportSnapshot(): Promise<DatabaseSnapshot> { return databaseSnapshot(); }
export async function pgRestoreSnapshot(snapshot: DatabaseSnapshot): Promise<void> { await restoreDatabase(snapshot); }
