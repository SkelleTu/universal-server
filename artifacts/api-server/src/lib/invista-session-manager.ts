import crypto from "node:crypto";

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

  register(userId: string, platform: TradingMode, userEmail?: string): InvistaSession {
    const now = new Date().toISOString();
    const existing = [...this.sessions.values()].find(
      s => s.userId === userId && s.platform === platform
    );
    if (existing) {
      if (userEmail) existing.userEmail = userEmail.trim().toLowerCase();
      existing.lastHeartbeatAt = now;
      existing.lastInvistaHeartbeatAt = now;
      existing.lastActivityAt = now;
      existing.status = existing.tradingArmed ? "armed" : "ready";
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
    return session;
  }

  heartbeat(sessionId: string, userId: string, platform: TradingMode, tradingArmed?: boolean) {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId || session.platform !== platform) return null;
    const now = new Date().toISOString();
    session.lastHeartbeatAt = now;
    session.lastInvistaHeartbeatAt = now;
    session.lastActivityAt = now;
    if (typeof tradingArmed === "boolean") session.tradingArmed = tradingArmed;
    session.status = session.tradingArmed ? "armed" : "ready";
    return session;
  }

  setTradingArmed(sessionId: string, userId: string, armed: boolean) {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return null;
    session.tradingArmed = armed;
    session.lastActivityAt = new Date().toISOString();
    session.status = armed ? "armed" : "ready";
    return session;
  }

  disconnect(sessionId: string, userId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return false;
    session.status = "disconnected";
    this.sessions.delete(sessionId);
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

  list() {
    return [...this.sessions.values()].map(s => ({
      ...s,
      healthy: Date.now() - new Date(s.lastHeartbeatAt).getTime() <= this.ttlMs,
    }));
  }

  prune() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, session] of this.sessions) {
      if (new Date(session.lastHeartbeatAt).getTime() < cutoff) {
        session.status = "disconnected";
        this.sessions.delete(id);
      }
    }
  }
}

export const invistaSessionManager = new InvistaSessionManager();
setInterval(() => invistaSessionManager.prune(), 30_000).unref();
