import crypto from "node:crypto";
import {
  pgDeleteGameCache, pgGetGameCache, pgGetOrCreateSystemProject, pgListGameCache, pgUpsertGameCache,
} from "./pglite";
import { createDerivAccountContext, type DerivAccountType } from "./deriv-account-gateway";

type Platform = "main" | "aura";
type StoredCredential = { userId: string; platform: Platform; accountType: DerivAccountType; accountId?: string; encryptedToken: string; active: boolean; updatedAt: string };
type LiveSession = { key: string; userId: string; platform: Platform; accountType: DerivAccountType; accountId: string; socket: WebSocket; connectedAt: string; lastMessageAt: string; heartbeat?: ReturnType<typeof setInterval>; intentionalClose?: boolean };
const live = new Map<string, LiveSession>();
const connecting = new Set<string>();
const reconnectAttempts = new Map<string, number>();
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const namespace = "invista-deriv-token";

function storageKey(userId: string, platform: Platform): string { return `${platform}:${userId}`; }
function encryptionKey(): Buffer {
  const raw = String(process.env.UNIVERSAL_OPERATOR_ENCRYPTION_KEY ?? process.env.UNIVERSAL_SERVER_BACKUP_ENCRYPTION_KEY ?? "").trim();
  if (!raw) throw new Error("UNIVERSAL_OPERATOR_ENCRYPTION_KEY or UNIVERSAL_SERVER_BACKUP_ENCRYPTION_KEY is required for Deriv token vault.");
  return crypto.createHash("sha256").update(raw).digest();
}
function encrypt(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}
function decrypt(value: string): string {
  const [iv, tag, data] = value.split(".");
  if (!iv || !tag || !data) throw new Error("Stored Deriv token ciphertext is invalid.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
async function credential(userId: string, platform: Platform): Promise<StoredCredential | null> {
  const project = await pgGetOrCreateSystemProject();
  const row = await pgGetGameCache(project.id, namespace, storageKey(userId, platform));
  return row ? row.data as unknown as StoredCredential : null;
}
function closeLive(key: string): void {
  const session = live.get(key);
  if (!session) return;
  if (session.heartbeat) clearInterval(session.heartbeat);
  live.delete(key);
  try { session.socket.close(1000, "session replaced or revoked"); } catch {}
}
function scheduleReconnect(userId: string, platform: Platform): void {
  const key = storageKey(userId, platform);
  const previous = reconnectTimers.get(key);
  if (previous) clearTimeout(previous);
  const attempt = Math.min((reconnectAttempts.get(key) ?? 0) + 1, 8);
  reconnectAttempts.set(key, attempt);
  const delayMs = Math.min(1000 * (2 ** (attempt - 1)), 60_000);
  const timer = setTimeout(async () => {
    reconnectTimers.delete(key);
    try {
      const saved = await credential(userId, platform);
      if (!saved) { reconnectAttempts.delete(key); return; }
      await connectCredential(saved);
      reconnectAttempts.delete(key);
    } catch (error) {
      console.warn("[DERIV_SESSION] Reconnect attempt failed:", userId, platform, error instanceof Error ? error.message : String(error));
      scheduleReconnect(userId, platform);
    }
  }, delayMs);
  timer.unref?.();
  reconnectTimers.set(key, timer);
}

async function connectCredential(record: StoredCredential): Promise<{ connected: boolean; accountId: string; accountType: DerivAccountType }> {
  const key = storageKey(record.userId, record.platform);
  if (connecting.has(key)) throw new Error("Deriv session connection is already in progress.");
  connecting.add(key);
  try {
    closeLive(key);
    const token = decrypt(record.encryptedToken);
    const context = await createDerivAccountContext(token, record.accountType, record.accountId);
    const socket = new WebSocket(context.websocketUrl);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { try { socket.close(); } catch {} reject(new Error("Deriv WebSocket connection timed out.")); }, 15000);
      socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Deriv WebSocket connection failed.")); }, { once: true });
    });
    const session: LiveSession = { key, userId: record.userId, platform: record.platform, accountType: record.accountType, accountId: context.accountId, socket, connectedAt: new Date().toISOString(), lastMessageAt: new Date().toISOString() };
    socket.addEventListener("message", () => { session.lastMessageAt = new Date().toISOString(); });
    socket.addEventListener("close", () => {
      if (session.heartbeat) clearInterval(session.heartbeat);
      if (live.get(key) === session) live.delete(key);
      if (session.intentionalClose) return;
      scheduleReconnect(session.userId, session.platform);
    });
    session.heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ ping: 1 })); } catch {}
      }
    }, 30000);
    session.heartbeat.unref?.();
    live.set(key, session);
    return { connected: true, accountId: context.accountId, accountType: record.accountType };
  } finally { connecting.delete(key); }
}

export async function saveAndConnectDerivSession(input: { userId: string; platform: Platform; token: string; accountType: DerivAccountType; accountId?: string }) {
  const userId = String(input.userId ?? "").trim();
  const token = String(input.token ?? "").trim();
  if (!userId || !token || !["main", "aura"].includes(input.platform) || !["demo", "real"].includes(input.accountType)) throw new Error("userId, token, platform and accountType are required.");
  const record: StoredCredential = { userId, platform: input.platform, accountType: input.accountType, accountId: input.accountId?.trim() || undefined, encryptedToken: encrypt(token), active: true, updatedAt: new Date().toISOString() };
  const project = await pgGetOrCreateSystemProject();
  await pgUpsertGameCache(project.id, namespace, storageKey(userId, input.platform), record as unknown as Record<string, unknown>, null);
  try {
    const state = await connectCredential(record);
    return { ...state, platform: input.platform };
  } catch (error) {
    // Keep the encrypted credential for controlled retry after a transient outage,
    // but never report the session as connected unless WebSocket open succeeded.
    scheduleReconnect(input.userId, input.platform);
    throw error;
  }
}

export async function reconnectSavedDerivSessions(): Promise<void> {
  const project = await pgGetOrCreateSystemProject();
  const rows = await pgListGameCache(project.id, namespace, 200);
  for (const row of rows) {
    const record = row.data as unknown as StoredCredential;
    if (!record?.userId || record.active !== true || !["main", "aura"].includes(record.platform) || !["demo", "real"].includes(record.accountType) || !record.encryptedToken) continue;
    try { await connectCredential(record); }
    catch (error) { console.warn("[DERIV_SESSION] Reconnect failed for user/platform:", record.userId, record.platform, error instanceof Error ? error.message : String(error)); scheduleReconnect(record.userId, record.platform); }
  }
}

export async function getDerivSessionStatus(userId: string, platform: Platform) {
  const record = await credential(userId, platform);
  const session = live.get(storageKey(userId, platform));
  return { configured: Boolean(record), active: record?.active === true, connected: Boolean(session && session.socket.readyState === WebSocket.OPEN), accountType: record?.accountType ?? null, accountId: session?.accountId ?? record?.accountId ?? null, connectedAt: session?.connectedAt ?? null, lastMessageAt: session?.lastMessageAt ?? null };
}

export async function disconnectDerivSession(userId: string, platform: Platform) {
  const key = storageKey(userId, platform);
  const project = await pgGetOrCreateSystemProject();
  const row = await pgGetGameCache(project.id, namespace, key);
  closeLive(key);
  if (row) {
    const record = row.data as unknown as StoredCredential;
    await pgUpsertGameCache(project.id, namespace, key, { ...record, active: false, updatedAt: new Date().toISOString() } as unknown as Record<string, unknown>, null);
  }
  const timer = reconnectTimers.get(key);
  if (timer) clearTimeout(timer);
  reconnectTimers.delete(key);
  reconnectAttempts.delete(key);
  return { ok: true, disconnected: true, credentialPreserved: Boolean(row) };
}

export async function disconnectAndDeleteDerivSession(userId: string, platform: Platform) {
  const key = storageKey(userId, platform);
  closeLive(key);
  const project = await pgGetOrCreateSystemProject();
  await pgDeleteGameCache(project.id, namespace, key);
  return { ok: true, disconnected: true };
}
