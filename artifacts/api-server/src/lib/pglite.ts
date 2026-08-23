import {
  initGitHubDatabase,
  createProject,
  getOrCreateSystemProject,
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
  listGameCacheSince,
  getStats,
  databaseSnapshot,
  databaseHasPersistentData,
  restoreDatabase,
  githubDatabaseHealth,
  githubPersistenceStatus,
  flushGitHubDatabase,
  type Project,
  type CollectionRow,
  type GameCacheRow,
  type DatabaseSnapshot,
} from "./github-db-v3";

export type { Project, CollectionRow, GameCacheRow, DatabaseSnapshot } from "./github-db-v3";
export type Stats = { requestsToday: number; totalCollections: number; totalProjects: number; totalGameCacheEntries: number };

export async function initPGlite(): Promise<void> { await initGitHubDatabase(); }
export async function pgListProjects(): Promise<Project[]> { return listProjects(); }
export async function pgGetProjectByApiKey(apiKey: string): Promise<Project | null> { return getProjectByApiKey(apiKey.trim()); }
export async function pgInsertProject(name: string, description: string | null): Promise<Project> { return createProject(name, description); }
export async function pgGetOrCreateSystemProject(): Promise<Project> { return getOrCreateSystemProject(); }
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
export function pgLogRequest(projectId: number, method: string, endpoint: string): void { void insertLog(projectId, method, endpoint); }
export async function pgGetStats(): Promise<Stats> { return getStats(); }
export async function pgHasPersistentData(): Promise<boolean> { return databaseHasPersistentData(); }
export async function pgExportSnapshot(): Promise<DatabaseSnapshot> { return databaseSnapshot(); }
export async function pgRestoreSnapshot(snapshot: DatabaseSnapshot): Promise<void> { await restoreDatabase(snapshot); }
export function pgPersistenceStatus(): ReturnType<typeof githubPersistenceStatus> { return githubPersistenceStatus(); }
export async function pgFlushPersistence(reason = "manual"): Promise<void> { await flushGitHubDatabase(reason); }
