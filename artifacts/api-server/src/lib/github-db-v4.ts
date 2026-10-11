import crypto from "crypto";
import { gzipSync, gunzipSync } from "zlib";
import { logger } from "./logger";

const API = "https://api.github.com";
const DB_PATH = "universal-server-data/database.enc";
const LEGACY_MANIFEST = "runtime-backups/latest.json";
const LEGACY_PREFIX = "runtime-backups/chunks/";
const KEY_ENV = "UNIVERSAL_SERVER_BACKUP_ENCRYPTION_KEY";
const LEGACY_KEY_ENV = "BACKUP_ENCRYPTION_KEY";
const TEXT_FORMAT = "USDB2";
const RAW_FORMAT = "USDB1";
const DEBOUNCE_MS = 15_000;

export type Project = { id: number; name: string; description: string | null; api_key: string; created_at: string };
export type CollectionRow = { id: number; data: Record<string, unknown>; created_at: string; updated_at: string; project_id?: number; collection?: string };
export type GameCacheRow = { id: number; namespace: string; cache_key: string; data: Record<string, unknown>; expires_at: string | null; created_at: string; updated_at: string; project_id?: number };
export type DatabaseSnapshot = {
  schemaVersion: 1; createdAt: string; projects: Project[];
  collections: Array<{ id: number; project_id: number; collection: string; data: Record<string, unknown>; created_at: string; updated_at: string }>;
  request_logs: Array<{ id: number; project_id: number; method: string | null; endpoint: string | null; status: number; created_at: string }>;
  game_cache: Array<{ id: number; project_id: number; namespace: string; cache_key: string; data: Record<string, unknown>; expires_at: string | null; created_at: string; updated_at: string }>;
  nextIds: { projects: number; collections: number; request_logs: number; game_cache: number };
};

type FileState = { text: string; sha: string };
let state: DatabaseSnapshot | null = null;
let sha: string | null = null;
let dirty = false;
let timer: NodeJS.Timeout | null = null;
let queue: Promise<void> = Promise.resolve();
let lastPersistAt: string | null = null;
let lastPersistError: string | null = null;

function cfg() {
  const token = process.env.BACKUP_GITHUB_TOKEN?.trim();
  const repo = process.env.BACKUP_GITHUB_REPO?.trim();
  if (!token) throw new Error("BACKUP_GITHUB_TOKEN environment variable is required.");
  if (!repo) throw new Error("BACKUP_GITHUB_REPO environment variable is required.");
  const encodings = [process.env[KEY_ENV]?.trim(), process.env[LEGACY_KEY_ENV]?.trim()]
    .filter((value): value is string => Boolean(value));
  if (encodings.length === 0) throw new Error(`${KEY_ENV} or ${LEGACY_KEY_ENV} environment variable is required.`);
  const keys = encodings.map((encoded) => {
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) throw new Error(`${KEY_ENV} or ${LEGACY_KEY_ENV} must be base64-encoded 32 bytes`);
    return key;
  });
  return { token, repo, key: keys[0]!, keys };
}

async function gh(path: string, init: RequestInit = {}) {
  const { token } = cfg();
  return fetch(`${API}${path}`, { ...init, headers: {
    Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", ...(init.headers ?? {})
  }});
}

async function readFile(path: string): Promise<FileState | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const r = await gh(`/repos/${cfg().repo}/contents/${encoded}?ref=main`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub read failed (${r.status}): ${await r.text()}`);
  const p = await r.json() as { content?: string; sha?: string };
  if (!p.content || !p.sha) throw new Error("GitHub response did not include content and SHA");
  return { text: Buffer.from(p.content.replace(/\n/g, ""), "base64").toString("utf8"), sha: p.sha };
}

async function readFileBytes(path: string): Promise<{ bytes: Buffer; sha: string } | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const r = await gh(`/repos/${cfg().repo}/contents/${encoded}?ref=main`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub binary read failed (${r.status}): ${await r.text()}`);
  const p = await r.json() as { content?: string; sha?: string; encoding?: string };
  if (!p.content || !p.sha || (p.encoding && p.encoding !== "base64")) {
    throw new Error("GitHub binary response did not include base64 content and SHA");
  }
  return { bytes: Buffer.from(p.content.replace(/\\n/g, ""), "base64"), sha: p.sha };
}

function empty(): DatabaseSnapshot {
  return { schemaVersion: 1, createdAt: new Date().toISOString(), projects: [], collections: [], request_logs: [], game_cache: [], nextIds: { projects: 1, collections: 1, request_logs: 1, game_cache: 1 } };
}

function normalize(input: Partial<DatabaseSnapshot>): DatabaseSnapshot {
  const base = empty();
  const projects = Array.isArray(input.projects) ? input.projects : [];
  const collections = Array.isArray(input.collections) ? input.collections : [];
  const logs = Array.isArray(input.request_logs) ? input.request_logs : [];
  const cache = Array.isArray(input.game_cache) ? input.game_cache : [];
  const maxId = (xs: Array<{ id: number }>) => xs.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
  return { schemaVersion: 1, createdAt: typeof input.createdAt === "string" ? input.createdAt : base.createdAt, projects, collections, request_logs: logs, game_cache: cache,
    nextIds: { projects: Math.max(Number(input.nextIds?.projects) || 1, maxId(projects) + 1), collections: Math.max(Number(input.nextIds?.collections) || 1, maxId(collections) + 1), request_logs: Math.max(Number(input.nextIds?.request_logs) || 1, maxId(logs) + 1), game_cache: Math.max(Number(input.nextIds?.game_cache) || 1, maxId(cache) + 1) } };
}

function encrypt(snapshot: DatabaseSnapshot, key: Buffer): Buffer {
  const gz = gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 9 });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([c.update(gz), c.final()]);
  return Buffer.concat([Buffer.from(RAW_FORMAT), iv, c.getAuthTag(), ciphertext]);
}

function decrypt(raw: Buffer, key: Buffer): DatabaseSnapshot {
  if (raw.subarray(0, 5).toString() !== RAW_FORMAT) throw new Error("Invalid Universal Server GitHub database format");
  if (raw.length < 33) throw new Error("Universal Server GitHub database is truncated");
  const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(5, 17));
  d.setAuthTag(raw.subarray(17, 33));
  const gz = Buffer.concat([d.update(raw.subarray(33)), d.final()]);
  return normalize(JSON.parse(gunzipSync(gz).toString("utf8")) as Partial<DatabaseSnapshot>);
}

function decryptWithKeys(raw: Buffer, keys: Buffer[]): DatabaseSnapshot {
  let lastError: unknown;
  for (const key of keys) {
    try {
      return decrypt(raw, key);
    } catch (err) {
      lastError = err;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown decryption error");
  throw new Error(`Unable to decrypt Universal Server backup with any configured key. Verify ${KEY_ENV}/${LEGACY_KEY_ENV}. Detail: ${detail}`);
}

function decryptLegacyWithKeys(raw: Buffer, keys: Buffer[]): DatabaseSnapshot {
  let lastError: unknown;
  for (const key of keys) {
    try {
      if (raw.subarray(0, 5).toString() !== "USBK1") throw new Error("Invalid legacy Universal Server backup format");
      if (raw.length < 33) throw new Error("Legacy Universal Server backup is truncated");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(5, 17));
      decipher.setAuthTag(raw.subarray(17, 33));
      const compressed = Buffer.concat([decipher.update(raw.subarray(33)), decipher.final()]);
      return normalize(JSON.parse(gunzipSync(compressed).toString("utf8")) as Partial<DatabaseSnapshot>);
    } catch (err) {
      lastError = err;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown decryption error");
  throw new Error(`Unable to decrypt legacy Universal Server backup with any configured key. Verify ${KEY_ENV}/${LEGACY_KEY_ENV}. Detail: ${detail}`);
}

function decodeStored(text: string, keys: Buffer[]): DatabaseSnapshot {
  const trimmed = text.trim();
  const raw = trimmed.startsWith(`${TEXT_FORMAT}\n`)
    ? Buffer.from(trimmed.slice(TEXT_FORMAT.length + 1), "base64")
    : Buffer.from(trimmed, "base64");
  return decryptWithKeys(raw, keys);
}

function snapshotHasData(snapshot: DatabaseSnapshot): boolean {
  return snapshot.projects.length > 0 ||
    snapshot.collections.length > 0 ||
    snapshot.request_logs.length > 0 ||
    snapshot.game_cache.length > 0;
}

type RecoveryScan = {
  snapshot: DatabaseSnapshot | null;
  path: string | null;
  candidateCount: number;
  unreadableCount: number;
};

async function recoverQuarantinedSnapshot(keys: Buffer[]): Promise<RecoveryScan> {
  const { repo } = cfg();
  const response = await gh(`/repos/${repo}/contents/recovery?ref=main`);
  if (response.status === 404) return { snapshot: null, path: null, candidateCount: 0, unreadableCount: 0 };
  if (!response.ok) throw new Error(`GitHub recovery listing failed (${response.status})`);

  const entries = await response.json() as Array<{ name?: string; path?: string; type?: string }>;
  const candidates = entries
    .filter((entry) => entry.type === "file" && typeof entry.path === "string" && /^invalid-database-.*\.txt$/.test(entry.name ?? ""))
    .sort((a, b) => (b.name ?? "").localeCompare(a.name ?? ""));

  let unreadableCount = 0;
  for (const entry of candidates) {
    if (!entry.path) continue;
    const file = await readFile(entry.path);
    if (!file) continue;
    try {
      const snapshot = decodeStored(file.text, keys);
      if (snapshotHasData(snapshot)) {
        logger.warn({ path: entry.path }, "Recovered non-empty Universal Server snapshot from quarantine");
        return { snapshot, path: entry.path, candidateCount: candidates.length, unreadableCount };
      }
    } catch {
      unreadableCount += 1;
    }
  }
  return { snapshot: null, path: null, candidateCount: candidates.length, unreadableCount };
}

function encodeStored(snapshot: DatabaseSnapshot, key: Buffer): string {
  return `${TEXT_FORMAT}\n${encrypt(snapshot, key).toString("base64")}\n`;
}

async function writeSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const c = cfg();
  const path = DB_PATH.split("/").map(encodeURIComponent).join("/");
  const body: Record<string, unknown> = { message: `chore(database): persist Universal Server state ${snapshot.createdAt}`, content: Buffer.from(encodeStored(snapshot, c.key), "utf8").toString("base64"), branch: "main" };
  if (sha) body.sha = sha;
  let r = await gh(`/repos/${c.repo}/contents/${path}`, { method: "PUT", body: JSON.stringify(body) });
  if (!r.ok && (r.status === 409 || r.status === 422)) {
    const latest = await readFile(DB_PATH);
    sha = latest?.sha ?? sha;
    if (sha) { body.sha = sha; r = await gh(`/repos/${c.repo}/contents/${path}`, { method: "PUT", body: JSON.stringify(body) }); }
  }
  if (!r.ok) throw new Error(`GitHub database write failed (${r.status}): ${await r.text()}`);
  const out = await r.json() as { content?: { sha?: string } };
  sha = out.content?.sha ?? sha;
  lastPersistAt = new Date().toISOString();
  lastPersistError = null;
}

async function quarantine(file: FileState): Promise<void> {
  const path = `recovery/invalid-database-${Date.now()}.txt`;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const response = await gh(`/repos/${cfg().repo}/contents/${encoded}`, {
    method: "PUT",
    body: JSON.stringify({
      message: "chore(recovery): quarantine invalid database snapshot",
      content: Buffer.from(file.text, "utf8").toString("base64"),
      branch: "main",
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to quarantine invalid GitHub database snapshot (HTTP ${response.status}). Refusing to continue recovery without a confirmed preserved copy. ${detail}`);
  }
}

async function legacy(): Promise<DatabaseSnapshot | null> {
  const manifest = await readFile(LEGACY_MANIFEST);
  if (!manifest) return null;
  try {
    const count = Number((JSON.parse(manifest.text) as { chunkCount?: number }).chunkCount ?? 0);
    if (!Number.isInteger(count) || count < 1) throw new Error("Legacy backup manifest has an invalid chunkCount");
    const chunks: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      const part = await readFileBytes(`${LEGACY_PREFIX}${String(i).padStart(6, "0")}.bin`);
      if (!part) throw new Error(`Legacy chunk ${i} missing`);
      // GitHub's Contents API already base64-decodes the file bytes above.
      // Accept both historical binary chunks and older base64-text chunks.
      let chunk = part.bytes;
      if (chunk.subarray(0, 5).toString() !== "USBK1") {
        const textChunk = chunk.toString("utf8").trim();
        if (/^[A-Za-z0-9+/]+={0,2}$/.test(textChunk)) {
          const decoded = Buffer.from(textChunk, "base64");
          if (decoded.subarray(0, 5).toString() === "USBK1") chunk = decoded;
        }
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    if (raw.subarray(0, 5).toString() !== "USBK1") throw new Error("Invalid legacy Universal Server backup format");
    return decryptLegacyWithKeys(raw, cfg().keys);
  } catch (err) {
    logger.error({ err }, "Legacy backup could not be migrated; refusing to initialize an empty database");
    throw new Error("Legacy Universal Server backup exists but could not be decrypted or migrated. Verify the configured encryption key and backup files.", { cause: err });
  }
}

function db(): DatabaseSnapshot { if (!state) throw new Error("GitHub database is not initialized"); return state; }
async function persistNow() { if (!state) return; const snapshot = JSON.parse(JSON.stringify(state)) as DatabaseSnapshot; dirty = false; queue = queue.catch(() => undefined).then(() => writeSnapshot(snapshot)).catch((err) => { dirty = true; lastPersistError = err instanceof Error ? err.message : String(err); logger.error({ err }, "GitHub database persistence failed"); throw err; }); await queue; }

export async function initGitHubDatabase(): Promise<void> {
  if (state) return;
  const c = cfg();
  const current = await readFile(DB_PATH);
  if (current) {
    sha = current.sha;
    let currentSnapshot: DatabaseSnapshot | null = null;
    let currentError: unknown = null;
    try {
      currentSnapshot = decodeStored(current.text, c.keys);
    } catch (err) {
      currentError = err;
      logger.error({ err }, "Existing GitHub database cannot be decrypted; checking preserved recovery snapshots");
      await quarantine(current);
    }

    if (currentSnapshot && snapshotHasData(currentSnapshot)) {
      state = currentSnapshot;
      lastPersistAt = new Date().toISOString();
      logger.info({ repository: c.repo, path: DB_PATH, format: current.text.trim().startsWith(`${TEXT_FORMAT}\n`) ? TEXT_FORMAT : RAW_FORMAT }, "GitHub database loaded");
      return;
    }

    const recovery = await recoverQuarantinedSnapshot(c.keys);
    if (recovery.snapshot) {
      // Preserve the current file before replacing it with recovered state.
      state = recovery.snapshot;
      dirty = true;
      await persistNow();
      logger.warn({
        repository: c.repo,
        recoveredFrom: recovery.path,
        recoveryCandidates: recovery.candidateCount,
        unreadableCandidates: recovery.unreadableCount,
      }, "Universal Server database recovered from a preserved encrypted snapshot");
      return;
    }

    if (currentSnapshot && !snapshotHasData(currentSnapshot)) {
      // A decryptable but empty current snapshot must not hide a populated legacy backup.
      // The legacy manifest and chunks are stored alongside the current snapshot.
      let legacyRecovery: DatabaseSnapshot | null = null;
      let legacyRecoveryError: unknown = null;
      try {
        legacyRecovery = await legacy();
      } catch (err) {
        legacyRecoveryError = err;
        logger.error({ err }, "Current database is empty; legacy backup validation failed");
      }
      if (legacyRecovery && snapshotHasData(legacyRecovery)) {
        state = legacyRecovery;
        dirty = true;
        await persistNow();
        logger.warn({ repository: c.repo, path: DB_PATH }, "Universal Server database recovered from populated legacy backup");
        return;
      }
      if (legacyRecoveryError) {
        throw new Error(
          "Current Universal Server database is empty and the legacy backup could not be validated. Refusing to continue with potentially incomplete state.",
          { cause: legacyRecoveryError },
        );
      }
    }

    if (currentSnapshot) {
      if (!snapshotHasData(currentSnapshot) && recovery.unreadableCount > 0) {
        throw new Error(
          "Current Universal Server database is empty while quarantined snapshots remain unreadable. Refusing to continue until the historical encryption key is restored.",
        );
      }
      state = currentSnapshot;
      lastPersistAt = new Date().toISOString();
      logger.info({ repository: c.repo, path: DB_PATH, format: current.text.trim().startsWith(`${TEXT_FORMAT}\n`) ? TEXT_FORMAT : RAW_FORMAT }, "GitHub database loaded");
      return;
    }

    throw new Error(
      "Existing Universal Server database could not be decrypted and no non-empty quarantined snapshot could be recovered. The original snapshot was preserved; verify the historical encryption key before restarting.",
      { cause: currentError },
    );
  }

  let legacySnapshot: DatabaseSnapshot | null = null;
  let legacyError: unknown = null;
  try {
    legacySnapshot = await legacy();
  } catch (err) {
    legacyError = err;
    logger.error({ err }, "Legacy snapshot could not be migrated; checking preserved recovery snapshots before failing closed");
  }
  if (legacySnapshot) {
    state = legacySnapshot;
    dirty = true;
    await persistNow();
    logger.info({ repository: c.repo, path: DB_PATH, migrated: true }, "Legacy Universal Server database migrated");
    return;
  }

  const recovery = await recoverQuarantinedSnapshot(c.keys);
  if (recovery.snapshot) {
    state = recovery.snapshot;
    dirty = true;
    await persistNow();
    logger.warn({ repository: c.repo, recoveredFrom: recovery.path }, "Universal Server database recovered from quarantine");
    return;
  }
  if (recovery.unreadableCount > 0 || legacyError) {
    throw new Error("No usable current database exists and one or more preserved snapshots could not be decrypted or migrated. Refusing to initialize an empty database until the historical encryption key is restored.", { cause: legacyError });
  }

  state = empty();
  dirty = true;
  await persistNow();
  logger.info({ repository: c.repo, path: DB_PATH, rebuilt: true }, "GitHub database initialized");
}

export async function createProject(name: string, description: string | null): Promise<Project> { const now = new Date().toISOString(); const p = { id: db().nextIds.projects++, name, description, api_key: crypto.randomBytes(32).toString("hex"), created_at: now }; db().projects.unshift(p); await persistNow(); return p; }
export async function deleteProject(id: number): Promise<boolean> { const n = db().projects.length; db().projects = db().projects.filter((p) => p.id !== id); db().collections = db().collections.filter((r) => r.project_id !== id); db().game_cache = db().game_cache.filter((r) => r.project_id !== id); if (db().projects.length === n) return false; scheduleGitHubPersist(); return true; }
export async function insertCollection(projectId: number, collection: string, data: Record<string, unknown>): Promise<CollectionRow> { const now = new Date().toISOString(); const r = { id: db().nextIds.collections++, project_id: projectId, collection, data, created_at: now, updated_at: now }; db().collections.unshift(r); scheduleGitHubPersist(); return r; }
export async function updateCollection(projectId: number, collection: string, id: number, data: Record<string, unknown>): Promise<CollectionRow | null> { const r = db().collections.find((x) => x.project_id === projectId && x.collection === collection && x.id === id); if (!r) return null; r.data = data; r.updated_at = new Date().toISOString(); scheduleGitHubPersist(); return r; }
export async function deleteCollection(projectId: number, collection: string, id: number): Promise<boolean> { const i = db().collections.findIndex((x) => x.project_id === projectId && x.collection === collection && x.id === id); if (i < 0) return false; db().collections.splice(i, 1); scheduleGitHubPersist(); return true; }
export async function upsertGameCache(projectId: number, namespace: string, cacheKey: string, data: Record<string, unknown>, expiresAt: string | null): Promise<GameCacheRow> { const now = new Date().toISOString(); const r = db().game_cache.find((x) => x.project_id === projectId && x.namespace === namespace && x.cache_key === cacheKey); if (r) { r.data = data; r.expires_at = expiresAt; r.updated_at = now; scheduleGitHubPersist(); return r; } const n = { id: db().nextIds.game_cache++, project_id: projectId, namespace, cache_key: cacheKey, data, expires_at: expiresAt, created_at: now, updated_at: now }; db().game_cache.unshift(n); scheduleGitHubPersist(); return n; }
export async function deleteGameCache(projectId: number, namespace: string, cacheKey: string): Promise<boolean> { const i = db().game_cache.findIndex((x) => x.project_id === projectId && x.namespace === namespace && x.cache_key === cacheKey); if (i < 0) return false; db().game_cache.splice(i, 1); scheduleGitHubPersist(); return true; }
export function insertLog(projectId: number, method: string, endpoint: string): void { db().request_logs.unshift({ id: db().nextIds.request_logs++, project_id: projectId, method, endpoint, status: 200, created_at: new Date().toISOString() }); if (db().request_logs.length > 5000) db().request_logs.length = 5000; }
export function getProjectByApiKey(apiKey: string): Project | null { const k = apiKey.trim(); return db().projects.find((p) => p.api_key === k) ?? null; }
export function listProjects(): Project[] { return [...db().projects].sort((a, b) => b.created_at.localeCompare(a.created_at)); }
export async function getOrCreateSystemProject(): Promise<Project> { const found = listProjects().find((p) => p.name === "Clamour public game"); return found ?? createProject("Clamour public game", "Internal project for public player accounts."); }
export function listCollection(projectId: number, collection: string, limit = 1000): CollectionRow[] { const l = Math.min(Math.max(Math.floor(limit), 1), 1000); return db().collections.filter((r) => r.project_id === projectId && r.collection === collection).slice(0, l); }
export function getCollectionItem(projectId: number, collection: string, id: number): CollectionRow | null { return db().collections.find((r) => r.project_id === projectId && r.collection === collection && r.id === id) ?? null; }
export function getGameCache(projectId: number, namespace: string, cacheKey: string): GameCacheRow | null { return db().game_cache.find((r) => r.project_id === projectId && r.namespace === namespace && r.cache_key === cacheKey && (!r.expires_at || Date.parse(r.expires_at) > Date.now())) ?? null; }
export function listGameCache(projectId: number, namespace: string, limit = 100): GameCacheRow[] { const l = Math.min(Math.max(Math.floor(limit), 1), 200); return db().game_cache.filter((r) => r.project_id === projectId && r.namespace === namespace && (!r.expires_at || Date.parse(r.expires_at) > Date.now())).slice(0, l); }
export function listGameCacheSince(projectId: number, namespace: string, since: string, limit = 100): GameCacheRow[] { const cut = Date.parse(since), l = Math.min(Math.max(Math.floor(limit), 1), 200); return db().game_cache.filter((r) => r.project_id === projectId && r.namespace === namespace && Date.parse(r.updated_at) > cut && (!r.expires_at || Date.parse(r.expires_at) > Date.now())).sort((a, b) => a.updated_at.localeCompare(b.updated_at)).slice(0, l); }
export function getStats() { const d = new Date().toISOString().slice(0, 10); return { requestsToday: db().request_logs.filter((r) => r.created_at.startsWith(d)).length, totalCollections: new Set(db().collections.map((r) => `${r.project_id}:${r.collection}`)).size, totalProjects: db().projects.length, totalGameCacheEntries: db().game_cache.length }; }
export function databaseSnapshot(): DatabaseSnapshot { return JSON.parse(JSON.stringify(db())) as DatabaseSnapshot; }
export async function restoreDatabase(snapshot: DatabaseSnapshot): Promise<void> { state = normalize(snapshot); dirty = true; await persistNow(); }
export function databaseHasPersistentData(): boolean { return Boolean(state && (state.projects.length || state.collections.length || state.request_logs.length || state.game_cache.length)); }
export function githubDatabaseHealth(): { ok: boolean; latencyMs: number } { return { ok: Boolean(state), latencyMs: 0 }; }
export function githubPersistenceStatus() { return { primary: "github" as const, encrypted: true, dirty, lastPersistAt, lastPersistError }; }
export function scheduleGitHubPersist(): void { dirty = true; if (timer) return; timer = setTimeout(() => { timer = null; void persistNow().catch(() => undefined); }, DEBOUNCE_MS); }
export async function flushGitHubDatabase(reason = "manual"): Promise<void> { if (timer) { clearTimeout(timer); timer = null; } logger.info({ reason }, "Flushing GitHub database"); await persistNow(); }
