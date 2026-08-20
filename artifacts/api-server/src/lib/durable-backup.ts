import crypto from "crypto";
import { gzipSync, gunzipSync } from "zlib";
import { pgExportSnapshot, pgHasPersistentData, pgRestoreSnapshot, type DatabaseSnapshot } from "./pglite";
import { sqReplaceFromSnapshot } from "./sqlite-restore";
import { logger } from "./logger";

const GITHUB_API = "https://api.github.com";
const BACKUP_PREFIX = "runtime-backups";
const CHUNK_BYTES = 500_000;

type BackupManifest = {
  schemaVersion: 1; createdAt: string; encrypted: true; algorithm: "aes-256-gcm"; compression: "gzip"; chunkCount: number; bytes: number;
};

function config(): { token: string; repo: string; key: Buffer } | null {
  const token = process.env.BACKUP_GITHUB_TOKEN?.trim();
  const repo = process.env.BACKUP_GITHUB_REPO?.trim();
  const encodedKey = process.env.BACKUP_ENCRYPTION_KEY?.trim();
  if (!token || !repo || !encodedKey) return null;
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must be base64-encoded 32 bytes");
  return { token, repo, key };
}

function githubHeaders(token: string): Record<string, string> { return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" }; }
async function github(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${GITHUB_API}${path}`, { ...init, headers: { ...githubHeaders(token), ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`GitHub backup API ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
function encrypt(snapshot: DatabaseSnapshot, key: Buffer): Buffer {
  const compressed = gzipSync(Buffer.from(JSON.stringify(snapshot), "utf8"), { level: 9 });
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return Buffer.concat([Buffer.from("USBK1"), iv, cipher.getAuthTag(), encrypted]);
}
function decrypt(payload: Buffer, key: Buffer): DatabaseSnapshot {
  if (payload.subarray(0, 5).toString() !== "USBK1") throw new Error("Invalid Universal Server backup format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, payload.subarray(5, 17));
  decipher.setAuthTag(payload.subarray(17, 33));
  const compressed = Buffer.concat([decipher.update(payload.subarray(33)), decipher.final()]);
  return JSON.parse(gunzipSync(compressed).toString("utf8")) as DatabaseSnapshot;
}
async function createBlob(token: string, repo: string, data: Buffer): Promise<string> {
  const result = await github(token, `/repos/${repo}/git/blobs`, { method: "POST", body: JSON.stringify({ content: data.toString("base64"), encoding: "base64" }) });
  return result.sha as string;
}

export async function createDurableBackup(): Promise<BackupManifest | null> {
  const c = config(); if (!c) return null;
  const snapshot = await pgExportSnapshot(); const encrypted = encrypt(snapshot, c.key);
  const parentRef = await github(c.token, `/repos/${c.repo}/git/ref/heads/main`); const parentSha = parentRef.object.sha as string;
  const parentCommit = await github(c.token, `/repos/${c.repo}/git/commits/${parentSha}`);
  const treeEntries: Array<{ path: string; mode: string; type: string; sha: string }> = [];
  let chunkCount = 0;
  for (let offset = 0; offset < encrypted.length; offset += CHUNK_BYTES) {
    const chunk = encrypted.subarray(offset, Math.min(offset + CHUNK_BYTES, encrypted.length));
    treeEntries.push({ path: `${BACKUP_PREFIX}/chunks/${String(chunkCount).padStart(6, "0")}.bin`, mode: "100644", type: "blob", sha: await createBlob(c.token, c.repo, chunk) });
    chunkCount++;
  }
  const preliminary: BackupManifest = { schemaVersion: 1, createdAt: snapshot.createdAt, encrypted: true, algorithm: "aes-256-gcm", compression: "gzip", chunkCount, bytes: encrypted.length };
  const manifestSha = await createBlob(c.token, c.repo, Buffer.from(JSON.stringify(preliminary, null, 2)));
  treeEntries.push({ path: `${BACKUP_PREFIX}/latest.json`, mode: "100644", type: "blob", sha: manifestSha });
  const tree = await github(c.token, `/repos/${c.repo}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree: treeEntries }) });
  const commit = await github(c.token, `/repos/${c.repo}/git/commits`, { method: "POST", body: JSON.stringify({ message: `chore(backup): universal-server snapshot ${snapshot.createdAt}`, tree: tree.sha, parents: [parentSha] }) });
  await github(c.token, `/repos/${c.repo}/git/refs/heads/main`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
  logger.info({ commitSha: commit.sha, bytes: encrypted.length, chunks: chunkCount }, "Durable backup completed");
  return preliminary;
}

async function getContent(token: string, repo: string, path: string): Promise<Buffer> {
  const file = await github(token, `/repos/${repo}/contents/${path}?ref=main`);
  return Buffer.from(String(file.content).replace(/\n/g, ""), "base64");
}

export async function restoreLatestBackupIfNeeded(): Promise<boolean> {
  const c = config(); if (!c || await pgHasPersistentData()) return false;
  try {
    const manifest = JSON.parse((await getContent(c.token, c.repo, `${BACKUP_PREFIX}/latest.json`)).toString("utf8")) as BackupManifest;
    const chunks: Buffer[] = [];
    for (let i = 0; i < manifest.chunkCount; i++) chunks.push(await getContent(c.token, c.repo, `${BACKUP_PREFIX}/chunks/${String(i).padStart(6, "0")}.bin`));
    const snapshot = decrypt(Buffer.concat(chunks), c.key);
    await pgRestoreSnapshot(snapshot); sqReplaceFromSnapshot(snapshot);
    logger.info({ createdAt: snapshot.createdAt }, "Durable backup restored"); return true;
  } catch (err) { logger.error({ err }, "Durable backup restore failed"); return false; }
}
export function durableBackupConfigured(): boolean { return config() !== null; }
