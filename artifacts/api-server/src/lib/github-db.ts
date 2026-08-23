import crypto from "crypto";
import { gzipSync, gunzipSync } from "zlib";
import { logger } from "./logger";

const GITHUB_API = "https://api.github.com";
const DATABASE_PATH = "universal-server-data/database.enc";
const LEGACY_MANIFEST_PATH = "runtime-backups/latest.json";
const LEGACY_CHUNK_PREFIX = "runtime-backups/chunks/";
const ENCRYPTION_ENV = "UNIVERSAL_SERVER_BACKUP_ENCRYPTION_KEY";

export type Project = { id: number; name: string; description: string | null; api_key: string; created_at: string };
export type CollectionRow = { id: number; data: Record<string, unknown>; created_at: string; updated_at: string; project_id?: number; collection?: string };
export type GameCacheRow = { id: number; namespace: string; cache_key: string; data: Record<string, unknown>; expires_at: string | null; created_at: string; updated_at: string; project_id?: number };
export type DatabaseSnapshot = {
  schemaVersion: 1;
  createdAt: string;
  projects: Project[];
  collections: Array<{ id: number; project_id: number; collection: string; data: Record<string, unknown>; created_at: string; updated_at: string }>;
  request_logs: Array<{ id: number; project_id: number; method: string | null; endpoint: string | null; status: number; created_at: string }>;
  game_cache: Array<{ id: number; project_id: number; namespace: string; cache_key: string; data: Record<string, unknown>; expires_at: string | null; created_at: string; updated_at: string }>;
  nextIds: { projects: number; collections: number; request_logs: number; game_cache: number };
};

let state: DatabaseSnapshot | null = null;
let fileSha: string | null = null;
let writeQueue: Promise<unknown> = Promise.resolve();

function config(): { token: string; repo: string; key: Buffer } {
  const token = process.env.BACKUP_GITHUB_TOKEN?.trim();
  const repo = process.env.BACKUP_GITHUB_REPO?.trim();
  const encodedKey = process.env[ENCRYPTION_ENV]?.trim();
  if (!token) throw new Error("BACKUP_GITHUB_TOKEN environment variable is required.");
  if (!repo) throw new Error("BACKUP_GITHUB_REPO environment variable is required.");
  if (!encodedKey) throw new Error(`${ENCRYPTION_ENV} environment variable is required.`);
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) throw new Error(`${ENCRYPTION_ENV} must be base64-encoded 32 bytes`);
  return { token, repo, key };
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function github(path: string, init: RequestInit = {}): Promise<Response> {
  const c = config();
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: { ...headers(c.token), ...(init.headers ?? {}) },
  });
}

async function readContent(pathname: string): Promise<{ data: Buffer; sha: string } | null> {
  const encodedPath = pathname.split("/").map(encodeURIComponent).join("/");
  const response = await github(`/repos/${config().repo}/contents/${encodedPath}?ref=main`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub database read failed (${response.status}): ${await response.text()}`);
  const payload = (await response.json()) as { content?: string; sha?: string; encoding?: string };
  if (!payload.content || !payload.sha) throw new Error("GitHub database file response was incomplete");
  return { data: Buffer.from(payload.content.replace(/\n/g, ""), "base64"), sha: payload.sha };
}

function encrypt(snapshot: DatabaseSnapshot, key: Buffer): Buffer {
  const compressed = gzipSync(Buffer.from(JSON.stringify(snapshot), "utf8"), { level: 9 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return Buffer.concat([Buffer.from("USDB1"), iv, cipher.getAuthTag(), encrypted]);
}

function decrypt(payload: Buffer, key: Buffer): DatabaseSnapshot {
  if (payload.subarray(0, 5).toString() !== "USDB1") throw new Error("Invalid Universal Server GitHub database format");
  if (payload.length < 33) throw new Error("Universal Server GitHub database is truncated");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, payload.subarray(5, 17));
  decipher.setAuthTag(payload.subarray(17, 33));
  const compressed = Buffer.concat([decipher.update(payload.subarray(33)), decipher.final()]);
  const parsed = JSON.parse(gunzipSync(compressed).toString("utf8")) as Partial<DatabaseSnapshot>;
  return normalize(parsed);
}

function emptyState(): DatabaseSnapshot {
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    projects: [],
    collections: [],
    request_logs: [],
    game_cache: [],
    nextIds: { projects: 1, collections: 1, request_logs: 1, game_cache: 1 },
  };
}

function normalize(input: Partial<DatabaseSnapshot>): DatabaseSnapshot {
  const base = emptyState();
  const projects = Array.isArray(input.projects) ? input.projects : [];
  const collections = Array.isArray(input.collections) ? input.collections : [];
  const logs = Array.isArray(input.request_logs) ? input.request_logs : [];
  const cache = Array.isArray(input.game_cache) ? input.game_cache : [];
  const max = (values: Array<{ id: number }>): number => values.reduce((m, item) => Math.max(m, Number(item.id) || 0), 0);
  return {
    schemaVersion: 1,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : base.createdAt,
    projects,
    collections,
    request_logs: logs,
    game_cache: cache,
    nextIds: {
      projects: Math.max(Number(input.nextIds?.projects) || 1, max(projects) + 1),
      collections: Math.max(Number(input.nextIds?.collections) || 1, max(collections) + 1),
      request_logs: Math.max(Number(input.nextIds?.request_logs) || 1, max(logs) + 1),
      game_cache: Math.max(Number(input.nextIds?.game_cache) || 1, max(cache) + 1),
    },
  };
}

async function loadLegacyBackup(): Promise<DatabaseSnapshot | null> {
  const manifestContent = await readContent(LEGACY_MANIFEST_PATH);
  if (!manifestContent) return null;
  try {
    const manifest = JSON.parse(manifestContent.data.toString("utf8")) as { chunkCount?: number };
    const chunkCount = Number(manifest.chunkCount ?? 0);
    if (!Number.isInteger(chunkCount) || chunkCount < 1) return null;
    const chunks: Buffer[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const chunk = await readContent(`${LEGACY_CHUNK_PREFIX}${String(i).padStart(6, "0")}.bin`);
      if (!chunk) throw new Error(`Legacy GitHub backup chunk ${i} is missing`);
      chunks.push(chunk.data);
    }
    return normalize(decryptLegacy(Buffer.concat(chunks), config().key));
  } catch (err) {
    logger.warn({ err }, "Legacy GitHub backup could not be migrated; preserving legacy files and starting a new database");
    return null;
  }
}

function decryptLegacy(payload: Buffer, key: Buffer): DatabaseSnapshot {
  if (payload.subarray(0, 5).toString() !== "USBK1") throw new Error("Invalid legacy Universal Server backup format");
  if (payload.length < 33) throw new Error("Legacy Universal Server backup is truncated");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, payload.subarray(5, 17));
  decipher.setAuthTag(payload.subarray(17, 33));
  const compressed = Buffer.concat([decipher.update(payload.subarray(33)), decipher.final()]);
  return normalize(JSON.parse(gunzipSync(compressed).toString("utf8")) as Partial<DatabaseSnapshot>);
}

async function writeToGitHub(snapshot: DatabaseSnapshot): Promise<void> {
  const c = config();
  const encrypted = encrypt(snapshot, c.key);
  const encodedPath = DATABASE_PATH.split("/").map(encodeURIComponent).join("/");
  const body: Record<string, unknown> = {
    message: `chore(database): persist Universal Server state ${snapshot.createdAt}`,
    content: encrypted.toString("base64"),
    branch: "main",
  };
  if (fileSha) body.sha = fileSha;
  const response = await github(`/repos/${c.repo}/contents/${encodedPath}`, { method: "PUT", body: JSON.stringify(body) });
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 409 || response.status === 422) {
      fileSha = null;
      const latest = await readContent(DATABASE_PATH);
      if (latest) fileSha = latest.sha;
    }
    throw new Error(`GitHub database write failed (${response.status}): ${text}`);
  }
  const result = (await response.json()) as { content?: { sha?: string } };
  fileSha = result.content?.sha ?? fileSha;
}

export async function initGitHubDatabase(): Promise<void> {
  if (state) return;
  const current = await readContent(DATABASE_PATH);
  if (current) {
    state = decrypt(current.data, config().key);
    fileSha = current.sha;
    logger.info({ repository: config().repo, path: DATABASE_PATH }, "GitHub database loaded");
    return;
  }
  const legacy = await loadLegacyBackup();
  state = legacy ?? emptyState();
  await writeToGitHub(state);
  logger.info({ repository: config().repo, path: DATABASE_PATH, migratedLegacyBackup: Boolean(legacy) }, "GitHub database initialized");
}

function db(): DatabaseSnapshot {
  if (!state) throw new Error("GitHub database was not initialized. Call initGitHubDatabase() first.");
  return state;
}

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(task, task);
  writeQueue = result.catch(() => undefined);
  return result;
}

export async function persistDatabase(): Promise<void> {
  const snapshot = db();
  await enqueueWrite(async () => writeToGitHub(snapshot));
}

export async function createProject(name: string, description: string | null): Promise<Project> {
  const now = new Date().toISOString();
  const project: Project = { id: db().nextIds.projects++, name, description, api_key: crypto.randomBytes(32).toString("hex"), created_at: now };
  db().projects.unshift(project); await persistDatabase(); return project;
}

export async function deleteProject(id: number): Promise<boolean> {
  const before = db().projects.length;
  db().projects = db().projects.filter((project) => project.id !== id);
  db().collections = db().collections.filter((row) => row.project_id !== id);
  db().game_cache = db().game_cache.filter((row) => row.project_id !== id);
  if (db().projects.length === before) return false;
  await persistDatabase(); return true;
}

export async function insertCollection(projectId: number, collection: string, data: Record<string, unknown>): Promise<CollectionRow> {
  const now = new Date().toISOString();
  const row = { id: db().nextIds.collections++, project_id: projectId, collection, data, created_at: now, updated_at: now };
  db().collections.unshift(row); await persistDatabase(); return row;
}

export async function updateCollection(projectId: number, collection: string, id: number, data: Record<string, unknown>): Promise<CollectionRow | null> {
  const row = db().collections.find((item) => item.project_id === projectId && item.collection === collection && item.id === id);
  if (!row) return null;
  row.data = data; row.updated_at = new Date().toISOString(); await persistDatabase(); return row;
}

export async function deleteCollection(projectId: number, collection: string, id: number): Promise<boolean> {
  const index = db().collections.findIndex((item) => item.project_id === projectId && item.collection === collection && item.id === id);
  if (index < 0) return false;
  db().collections.splice(index, 1); await persistDatabase(); return true;
}

export async function insertLog(projectId: number, method: string, endpoint: string): Promise<void> {
  db().request_logs.unshift({ id: db().nextIds.request_logs++, project_id: projectId, method, endpoint, status: 200, created_at: new Date().toISOString() });
  if (db().request_logs.length > 5000) db().request_logs.length = 5000;
  await persistDatabase();
}

export async function upsertGameCache(projectId: number, namespace: string, cacheKey: string, data: Record<string, unknown>, expiresAt: string | null): Promise<GameCacheRow> {
  const now = new Date().toISOString();
  const existing = db().game_cache.find((item) => item.project_id === projectId && item.namespace === namespace && item.cache_key === cacheKey);
  if (existing) { existing.data = data; existing.expires_at = expiresAt; existing.updated_at = now; await persistDatabase(); return existing; }
  const row = { id: db().nextIds.game_cache++, project_id: projectId, namespace, cache_key: cacheKey, data, expires_at: expiresAt, created_at: now, updated_at: now };
  db().game_cache.unshift(row); await persistDatabase(); return row;
}

export async function deleteGameCache(projectId: number, namespace: string, cacheKey: string): Promise<boolean> {
  const index = db().game_cache.findIndex((item) => item.project_id === projectId && item.namespace === namespace && item.cache_key === cacheKey);
  if (index < 0) return false;
  db().game_cache.splice(index, 1); await persistDatabase(); return true;
}

export function getProjectByApiKey(apiKey: string): Project | null { return db().projects.find((project) => project.api_key === apiKey) ?? null; }
export function listProjects(): Project[] { return [...db().projects].sort((a, b) => b.created_at.localeCompare(a.created_at)); }
export function listCollection(projectId: number, collection: string, limit = 1000): CollectionRow[] { return db().collections.filter((row) => row.project_id === projectId && row.collection === collection).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit); }
export function getCollectionItem(projectId: number, collection: string, id: number): CollectionRow | null { return db().collections.find((row) => row.project_id === projectId && row.collection === collection && row.id === id) ?? null; }
export function getGameCache(projectId: number, namespace: string, cacheKey: string): GameCacheRow | null { const row = db().game_cache.find((item) => item.project_id === projectId && item.namespace === namespace && item.cache_key === cacheKey) ?? null; if (!row) return null; if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null; return row; }
export function listGameCache(projectId: number, namespace: string, limit = 100): GameCacheRow[] { const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 200); return db().game_cache.filter((row) => row.project_id === projectId && row.namespace === namespace && (!row.expires_at || Date.parse(row.expires_at) > Date.now())).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, safeLimit); }
export function listGameCacheSince(projectId: number, namespace: string, since: string, limit = 100): GameCacheRow[] { const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 200); const cutoff = Date.parse(since); return db().game_cache.filter((row) => row.project_id === projectId && row.namespace === namespace && Date.parse(row.updated_at) > cutoff && (!row.expires_at || Date.parse(row.expires_at) > Date.now())).sort((a, b) => a.updated_at.localeCompare(b.updated_at)).slice(0, safeLimit); }
export function getStats(): { requestsToday: number; totalCollections: number; totalProjects: number; totalGameCacheEntries: number } { const today = new Date().toISOString().slice(0, 10); const requestsToday = db().request_logs.filter((row) => row.created_at.slice(0, 10) === today).length; const collectionKeys = new Set(db().collections.map((row) => `${row.project_id}:${row.collection}`)); return { requestsToday, totalCollections: collectionKeys.size, totalProjects: db().projects.length, totalGameCacheEntries: db().game_cache.length }; }
export function databaseSnapshot(): DatabaseSnapshot { return JSON.parse(JSON.stringify(db())) as DatabaseSnapshot; }
export function databaseHasPersistentData(): boolean { return db().projects.length > 0 || db().collections.length > 0 || db().game_cache.length > 0; }
export async function restoreDatabase(snapshot: DatabaseSnapshot): Promise<void> { state = normalize(snapshot); await persistDatabase(); }
export function githubDatabaseHealth(): { ok: boolean; latencyMs: number } { return state ? { ok: true, latencyMs: 0 } : { ok: false, latencyMs: 0 }; }
