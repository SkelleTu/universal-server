import crypto from "node:crypto";
import { pgDeleteGameCache, pgGetOrCreateSystemProject, pgListGameCache, pgUpsertGameCache } from "./pglite";

export type TradingMode = "main" | "aura";

export interface InvistaSession {
  sessionId: string;
  userId: string;
  userEmail?: string;
  platform: TradingMode;
  connectedAt: string;
  lastHeartbeatAt: string;
  lastInvistaHeartbeatAt: string;
  tradingArmed: boolean;
  lastActivityAt: string;
  status: "ready" | "armed" | "stopped" | "disconnected";
}

class InvistaSessionManager {
  private sessions = new Map<string, InvistaSession>();
  private readonly ttlMs = Number(process.env.INVISTA_SESSION_TTL_MS || 120_000);
  private readonly namespace = "invista-auth-session";

  private async persist(session: InvistaSession): Promise<void> {
    const project = await pgGetOrCreateSystemProject();
    await pgUpsertGameCache(project.id, this.namespace, session.sessionId, session as unknown as Record<string, unknown>, null);
  }

  async initialize(): Promise<void> {
    const project = await pgGetOrCreateSystemProject();
    const rows = await pgListGameCache(project.id, this.namespace, 500);
    const now = Date.now();
    for (const row of rows) {
      const value = row.data as unknown as InvistaSession;
      if (!value?.sessionId || !value.userId || !["main", "aura"].includes(value.platform) || !value.lastHeartbeatAt) {
        await pgDeleteGameCache(project.id, this.namespace, row.cache_key);
        continue;
      }
      if (now - Date.parse(value.lastHeartbeatAt) > this.ttlMs) {
        await pgDeleteGameCache(project.id, this.namespace, row.cache_key);
        continue;
      }
      // A process restart must never restore an armed trading state.
      value.tradingArmed = false;
      value.status = "ready";
      this.sessions.set(value.sessionId, value);
      await this.persist(value);
    }
    console.log(`[UNIVERSAL_SESSION] Restored ${this.sessions.size} active platform session(s) from persistent storage.`);
  }

  async register(userId: string, platform: TradingMode, userEmail?: string): Promise<InvistaSession> {
    const now = new Date().toISOString();
    const existing = [...this.sessions.values()].find(
      s => s.userId === userId && s.platform === platform
        && s.status !== "disconnected"
        && Date.now() - Date.parse(s.lastHeartbeatAt) <= this.ttlMs
    );
    if (existing) {
      if (userEmail) existing.userEmail = userEmail.trim().toLowerCase();
      existing.lastHeartbeatAt = now;
      existing.lastInvistaHeartbeatAt = now;
      existing.lastActivityAt = now;
      existing.status = existing.tradingArmed ? "armed" : "ready";
      await this.persist(existing);
      return existing;
    }
    const session: InvistaSession = {
      sessionId: crypto.randomUUID(),
      userId,
      ...(userEmail ? { userEmail: userEmail.trim().toLowerCase() } : {}),
      platform,
      connectedAt: now,
      lastHeartbeatAt: now,
      lastInvistaHeartbeatAt: now,
      tradingArmed: false,
      lastActivityAt: now,
      status: "ready",
    };
    this.sessions.set(session.sessionId, session);
    await this.persist(session);
    return session;
  }

  async heartbeat(sessionId: string, userId: string, platform: TradingMode, tradingArmed?: boolean): Promise<InvistaSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId || session.platform !== platform) return null;
    const now = new Date().toISOString();
    session.lastHeartbeatAt = now;
    session.lastInvistaHeartbeatAt = now;
    session.lastActivityAt = now;
    if (typeof tradingArmed === "boolean") session.tradingArmed = tradingArmed;
    session.status = session.tradingArmed ? "armed" : "ready";
    await this.persist(session);
    return session;
  }

  async setTradingArmed(sessionId: string, userId: string, armed: boolean): Promise<InvistaSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return null;
    session.tradingArmed = armed;
    session.lastActivityAt = new Date().toISOString();
    session.status = armed ? "armed" : "ready";
    await this.persist(session);
    return session;
  }

  async disconnect(sessionId: string, userId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return false;
    session.status = "disconnected";
    this.sessions.delete(sessionId);
    const project = await pgGetOrCreateSystemProject();
    await pgDeleteGameCache(project.id, this.namespace, sessionId);
    return true;
  }

  get(sessionId: string, userId: string) {
    const session = this.sessions.get(sessionId);
    return session && session.userId === userId ? session : null;
  }

  getActive(userId: string, platform: TradingMode): InvistaSession | null {
    const now = Date.now();
    const session = [...this.sessions.values()].find(
      item => item.userId === userId && item.platform === platform
        && item.status !== "disconnected"
        && now - Date.parse(item.lastHeartbeatAt) <= this.ttlMs,
    );
    return session ?? null;
  }

  getActiveByEmail(userEmail: string, platform: TradingMode): InvistaSession | null {
    const email = String(userEmail ?? "").trim().toLowerCase();
    if (!email) return null;
    const now = Date.now();
    const session = [...this.sessions.values()].find(
      item => item.userEmail === email && item.platform === platform
        && item.status !== "disconnected"
        && now - Date.parse(item.lastHeartbeatAt) <= this.ttlMs,
    );
    return session ?? null;
  }

  list() {
    return [...this.sessions.values()].map(s => ({
      ...s,
      healthy: Date.now() - new Date(s.lastHeartbeatAt).getTime() <= this.ttlMs,
    }));
  }

  async prune(): Promise<void> {
    const cutoff = Date.now() - this.ttlMs;
    const project = await pgGetOrCreateSystemProject();
    for (const [id, session] of this.sessions) {
      if (new Date(session.lastHeartbeatAt).getTime() < cutoff) {
        session.status = "disconnected";
        this.sessions.delete(id);
        await pgDeleteGameCache(project.id, this.namespace, id);
      }
    }
  }
}

export const invistaSessionManager = new InvistaSessionManager();
setInterval(() => { void invistaSessionManager.prune().catch((error) => console.warn("[UNIVERSAL_SESSION] Prune failed:", error instanceof Error ? error.message : String(error))); }, 30_000).unref();
