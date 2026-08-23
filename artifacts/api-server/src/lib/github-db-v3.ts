import crypto from "crypto";
import { gzipSync, gunzipSync } from "zlib";
import { logger } from "./logger";

const GITHUB_API = "https://api.github.com";
const DATABASE_PATH = "universal-server-data/database.enc";
const LEGACY_MANIFEST_PATH = "runtime-backups/latest.json";
const LEGACY_CHUNK_PREFIX = "runtime-backups/chunks/";
const KEY_ENV = "UNIVERSAL_SERVER_BACKUP_ENCRYPTION_KEY";
const FORMAT = "USDB2";
const RAW_FORMAT = "USDB1";
const PERSIST_DEBOUNCE_MS = 15_000;
const MAX_DATABASE_BYTES = 50 * 1024 * 1024;

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

type StoredFile = { text: string; sha: string };
let state: DatabaseSnapshot | null = null;
let fileSha: string | null = null;
let dirty = false;
let persistTimer: NodeJS.Timeout | null = null;
let persistQueue: Promise<void> = Promise.resolve();
let lastPersistAt: string | null = null;
let lastPersistError: string | null = null;

function config(): { token: string; repo: string; key: Buffer } {
  const token = process.env.BACKUP_GITHUB_TOKEN?.trim();
  const repo = process.env.BACKUP_GITHUB_REPO?.trim();
  const encodedKey = process.env[KEY_ENV]?.trim();
  if (!token) throw new Error("BACKUP_GITHUB_TOKEN environment variable is required.");
  if (!repo) throw new Error("BACKUP_GITHUB_REPO environment variable is required.");
  if (!encodedKey) throw new Error(`${KEY_ENV} environment variable is required.`);
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) throw new Error(`${KEY_ENV} must be base64-encoded 32 bytes`);
  return { token, repo, key };
}

async function github(path: string, init: RequestInit = {}): Promise<Response> {
  const { token } = config();
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function readText(pathname: string): Promise<StoredFile | null> {
  const encoded = pathname.split("/").map(encodeURIComponent).join("/");
  const response = await github(`/repos/${config().repo}/contents/${encoded}?ref=main`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub read failed (${response.status}): ${await response.text()}`);
  const payload = (await response.json()) as { content?: string; sha?: string; encoding?: string };
  if (!payload.content || !payload.sha) throw new Error("GitHub response did not include file content and SHA");
  return { text: Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf8"), sha: payload.sha };
}

function emptyState(): DatabaseSnapshot {
  return { schemaVersion: 1, createdAt: new Date().toISOString(), projects: [], collections: [], request_logs: [], game_cache: [], nextIds: { projects: 1, collections: 1, request_logs: 1, game_cache: 1 } };
}

function normalize(input: Partial<DatabaseSnapshot>): DatabaseSnapshot {
  const base = emptyState();
  const projects = Array.isArray(input.projects) ? input.projects : [];
  const collections = Array.isArray(input.collections) ? input.collections : [];
  const logs = Array.isArray(input.request_logs) ? input.request_logs : [];
  const cache = Array.isArray(input.game_cache) ? input.game_cache : [];
  const maxId = (rows: Array<{ id: number }>) => rows.reduce((m, row) => Math.max(m, Number(row.id) || 0), 0);
  return {
    schemaVersion: 1,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : base.createdAt,
    projects,
    collections,
    request_logs: logs,
    game_cache: cache,
    nextIds: {
      projects: Math.max(Number(input.nextIds?.projects) || 1, maxId(projects) + 1),
      collections: Math.max(Number(input.nextIds?.collections) || 1, maxId(collections) + 1),
      request_logs: Math.max(Number(input.nextIds?.request_logs) || 1, maxId(logs) + 1),
      game_cache: Math.max(Number(input.nextIds?.game_cache) || 1, maxId(cache) + 1),
    },
  };
}

function encrypt(snapshot: DatabaseSnapshot, key: Buffer): Buffer {
  const compressed = gzipSync(Buffer.from(JSON.stringify(snapshot), "utf8"), { level: 9 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const payload = Buffer.concat([Buffer.from(RAW_FORMAT), iv, cipher.getAuthTag(), ciphertext]);
  if (payload.length > MAX_DATABASE_BYTES) throw new Error(`Universal Server GitHub database exceeds ${MAX_DATABASE_BYTES} bytes`);
  return payload;
}

function decryptRaw(payload: Buffer, key: Buffer): DatabaseSnapshot {
  if (payload.subarray(0, 5).toString() !== RAW_FORMAT) throw new Error("Invalid Universal Server database format");
  if (payload.length < 33) throw new Error("Universal Server database is truncated");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, payload.subarray(5, 17));
  decipher.setAuthTag(payload.subarray(17, 33));
  const compressed = Buffer.concat([decipher.update(payload.subarray(33)), decipher.final()]);
  return normalize(JSON.parse(gunzipSync(compressed).toString("utf8")) as Partial<DatabaseSnapshot>);
}

function decryptText(text: string, key: Buffer): DatabaseSnapshot {
  if (text.startsWith(`${FORMAT}\n`)) return decryptRaw(Buffer.from(text.slice(FORMAT.length + 1).trim(), "base64"), key);
  const raw = Buffer.from(text, "base64");
  return decryptRaw(raw, key);
}

function encodeText(snapshot: DatabaseSnapshot, key: Buffer): string {
  return `${FORMAT}\n${encrypt(snapshot, key).toString("base64")}\n`;
}

async function writeText(snapshot: DatabaseSnapshot): Promise<void> {
  const c = config();
  const encoded = DATABASE_PATH.split("/").map(encodeURIComponent).join("/");
  const body: Record<string, unknown> = {
    message: `chore(database): persist Universal Server state ${snapshot.createdAt}`,
    content: Buffer.from(encodeText(snapshot, c.key), "utf8").toString("base64"),
    branch: "main",
  };
  if (fileSha) body.sha = fileSha;
  const response = await github(`/repos/${c.repo}/contents/${encoded}`, { method: "PUT", body: JSON.stringify(body) });
  if (!response.ok) {
    if (response.status === 409 || response.status === 422) {
      const latest = await readText(DATABASE_PATH);
      fileSha = latest?.sha ?? null;
      if (fileSha) {
        body.sha = fileSha;
        const retry = await github(`/repos/${c.repo}/contents/${encoded}`, { method: "PUT", body: JSON.stringify(body) });
        if (retry.ok) {
          const result = (await retry.json()) as { content?: { sha?: string } };
          fileSha = result.content?.sha ?? fileSha;
          lastPersistAt = new Date().toISOString();
          lastPersistError = null;
          return;
        }
      }
    }
    throw new Error(`GitHub database write failed (${response.status}): ${await response.text()}`);
  }
  const result = (await response.json()) as { content?: { sha?: string } };
  fileSha = result.content?.sha ?? fileSha;
  lastPersistAt = new Date().toISOString();
  lastPersistError = null;
}

async function quarantineInvalid(file: StoredFile): Promise<void> {
  try {
    const path = `recovery/invalid-database-${new Date().toISOString().replace(/[:.]/g, "-")}.b64`;
    const body = {
      message: "chore(recovery): quarantine invalid database snapshot",
      content: Buffer.from(file.text, "utf8").toString("base64"),
      branch: "main",
    };
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    await github(`/repos/${config().repo}/contents/${encoded}`, { method: "PUT", body: JSON.stringify(body) });
  } catch (err) {
    logger.warn({ err }, "Could not quarantine invalid GitHub database snapshot");
  }
}

async function loadLegacy(): Promise<DatabaseSnapshot | null> {
  const manifest = await readText(LEGACY_MANIFEST_PATH);
  if (!manifest) return null;
  try {
    const json = JSON.parse(manifest.text) as { chunkCount?: number };
    const count = Number(json.chunkCount ?? 0);
    if (!Number.isInteger(count) || count < 1) return null;
    const chunks: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      const chunk = await readText(`${LEGACY_CHUNK_PREFIX}${String(i).padStart(6, "0")}.bin`);
      if (!chunk) throw new Error(`Missing legacy chunk ${i}`);
      chunks.push(Buffer.from(chunk.text, "base64"));
    }
    const payload = Buffer.concat(chunks);
    if (payload.subarray(0, 5).toString() !== "USBK1") throw new Error("Invalid legacy Universal Server backup format");
    const c = config();
    const decipher = crypto.createDecipheriv("aes-256-gcm", c.key, payload.subarray(5, 17));
    decipher.setAuthTag(payload.subarray(17, 33));
    const compressed = Buffer.concat([decipher.update(payload.subarray(33)), decipher.final()]);
    return normalize(JSON.parse(gunzipSync(compressed).toString("utf8")) as Partial<DatabaseSnapshot>);
  } catch (err) {
    logger.warn({ err }, "Legacy GitHub backup could not be migrated; starting with a new database");
    return null;
  }
}

async function enqueuePersistNow(): Promise<void> {
  if (!state) return;
  const snapshot = databaseSnapshot();
  dirty = false;
  persistQueue = persistQueue.then(() => writeText(snapshot)).catch((err) => {
    dirty = true;
    lastPersistError = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "GitHub database persistence failed");
  });
  await persistQueue;
}

export async function initGitHubDatabase(): Promise<void> {
  if (state) return;
  const c = config();
  const current = await readText(DATABASE_PATH);
  if (current) {
    try {
      state = decryptText(current.text, c.key);
      fileSha = current.sha;
      lastPersistAt = new Date().toISOString();
      logger.info({ repository: c.repo, path: DATABASE_PATH, format: current.text.startsWith(`${FORMAT}\n`) ? FORMAT : RAW_FORMAT }, "GitHub database loaded");
      return;
    } catch (err) {
      logger.warn({ err }, "Existing GitHub database snapshot is invalid; preserving and rebuilding");
      await quarantineInvalid(current);
    }
  }
  state = (await loadLegacy()) ?? emptyState();
  dirty = true;
  await enqueuePersistNow();
  logger.info({ repository: c.repo, path: DATABASE_PATH, initializedFresh: !state.projects.length && !state.collections.length }, "GitHub database initialized");
}

function db(): DatabaseSnapshot {
  if (!state) throw new Error("GitHub database was not initialized");
  return state;
}

export async function createProject(name: string, description: string | null): Promise<Project> {
  const now = new Date().toISOString();
  const project: Project = { id: db().nextIds.projects++, name, description, api_key: crypto.randomBytes(32).toString("hex"), created_at: now };
  db().projects.unshift(project);
  await persistDatabase();
  return project;
}

export async function deleteProject(id: number): Promise<boolean> { const before = db().projects.length; db().projects = db().projects.filter((p) => p.id !== id); db().collections = db().collections.filter((r) => r.project_id !== id); db().game_cache = db().game_cache.filter((r) => r.project_id !== id); if (db().projects.length === before) return false; scheduleGitHubPersist(); return true; }
export async function insertCollection(projectId: number, collection: string, data: Record<string, unknown>): Promise<CollectionRow> { const now = new Date().toISOString(); const row = { id: db().nextIds.collections++, project_id: projectId, collection, data, created_at: now, updated_at: now }; db().collections.unshift(row); scheduleGitHubPersist(); return row; }
export async function updateCollection(projectId: number, collection: string, id: number, data: Record<string, unknown>): Promise<CollectionRow | null> { const row = db().collections.find((r) => r.project_id === projectId && r.collection === collection && r.id === id); if (!row) return null; row.data = data; row.updated_at = new Date().toISOString(); scheduleGitHubPersist(); return row; }
export async function deleteCollection(projectId: number, collection: string, id: number): Promise<boolean> { const index = db().collections.findIndex((r) => r.project_id === projectId && r.collection === collection && r.id === id); if (index < 0) return false; db().collections.splice(index, 1); scheduleGitHubPersist(); return true; }
export async function upsertGameCache(projectId: number, namespace: string, cacheKey: string, data: Record<string, unknown>, expiresAt: string | null): Promise<GameCacheRow> { const now = new Date().toISOString(); const row = db().game_cache.find((r) => r.project_id === projectId && r.namespace === namespace && r.cache_key === cacheKey); if (row) { row.data = data; row.expires_at = expiresAt; row.updated_at = now; scheduleGitHubPersist(); return row; } const created = { id: db().nextIds.game_cache++, project_id: projectId, namespace, cache_key: cacheKey, data, expires_at: expiresAt, created_at: now, updated_at: now }; db().game_cache.unshift(created); scheduleGitHubPersist(); return created; }
export async function deleteGameCache(projectId: number, namespace: string, cacheKey: string): Promise<boolean> { const index = db().game_cache.findIndex((r) => r.project_id === projectId && r.namespace === namespace && r.cache_key === cacheKey); if (index < 0) return false; db().game_cache.splice(index, 1); scheduleGitHubPersist(); return true; }
export async function insertLog(projectId: number, method: string, endpoint: string): Promise<void> { db().request_logs.unshift({ id: db().nextIds.request_logs++, project_id: projectId, method, endpoint, status: 200, created_at: new Date().toISOString() }); if (db().request_logs.length > 5000) db().request_logs.length = 5000; }

export function getProjectByApiKey(apiKey: string): Project | null { const key = apiKey.trim(); return db().projects.find((p) => p.api_key === key) ?? null; }
export function listProjects(): Project[] { return [...db().projects].sort((a, b) => b.created_at.localeCompare(a.created_at)); }
export function getOrCreateSystemProject(): Promise<Project> { const existing = listProjects().find((p) => p.name === "Clamour public game"); return existing ? Promise.resolve(existing) : createProject("Clamour public game", "Internal project for public player accounts."); }
export function listCollection(projectId: number, collection: string, limit = 1000): CollectionRow[] { const safe = Math.min(Math.max(Math.floor(limit), 1), 1000); return db().collections.filter((r) => r.project_id === projectId && r.collection === collection).slice(0, safe); }
export function getCollectionItem(projectId: number, collection: string, id: number): CollectionRow | null { return db().collections.find((r) => r.project_id === projectId && r.collection === collection && r.id === id) ?? null; }
export function getGameCache(projectId: number, namespace: string, cacheKey: string): GameCacheRow | null { return db().game_cache.find((r) => r.project_id === projectId && r.namespace === namespace && r.cache_key === cacheKey && (!r.expires_at || Date.parse(r.expires_at) > Date.now())) ?? null; }
export function listGameCache(projectId: number, namespace: string, limit = 100): GameCacheRow[] { const safe = Math.min(Math.max(Math.floor(limit), 1), 200); return db().game_cache.filter((r) => r.project_id === projectId && r.namespace === namespace && (!r.expires_at || Date.parse(r.expires_at) > Date.now())).slice(0, safe); }
export function listGameCacheSince(projectId: number, namespace: string, since: string, limit = 100): GameCacheRow[] { const cutoff = Date.parse(since); const safe = Math.min(Math.max(Math.floor(limit), 1), 200); return db().game_cache.filter((r) => r.project_id === projectId && r.namespace === namespace && Date.parse(r.updated_at) > cutoff && (!r.expires_at || Date.parse(r.expires_at) > Date.now())).sort((a, b) => a.updated_at.localeCompare(b.updated_at)).slice(0, safe); }
export function getStats(): { requestsToday: number; totalCollections: number; totalProjects: number; totalGameCacheEntries: number } { const day = new Date().toISOString().slice(0, 10); return { requestsToday: db().request_logs.filter((r) => r.created_at.startsWith(day)).length, totalCollections: new Set(db().collections.map((r) => `${r.project_id}:${r.collection}`)).size, totalProjects: db().projects.length, totalGameCacheEntries: db().game_cache.length }; }
export function databaseSnapshot(): DatabaseSnapshot { return JSON.parse(JSON.stringify(db())) as DatabaseSnapshot; }
export function restoreDatabase(snapshot: DatabaseSnapshot): Promise<void> { state = normalize(snapshot); dirty = true; return enqueuePersistNow(); }
export function databaseHasPersistentData(): boolean { return Boolean(state && (state.projects.length || state.collections.length || state.game_cache.length)); }
export function githubDatabaseHealth(): { ok: boolean; latencyMs: number } { return { ok: Boolean(state), latencyMs: 0 }; }
export function githubPersistenceStatus() { return { primary: "github" as const, encrypted: true, dirty, lastPersistAt, lastPersistError }; }
export function scheduleGitHubPersist(): void { dirty = true; if (persistTimer) return; persistTimer = setTimeout(() => { persistTimer = null; void enqueuePersistNow(); }, PERSIST_DEBOUNCE_MS); }
export async function persistDatabase(): Promise<void> { await enqueuePersistNow(); }
export async function flushGitHubDatabase(reason = "manual"): Promise<void> { if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; } logger.info({ reason }, "Flushing GitHub database"); await enqueuePersistNow(); }
