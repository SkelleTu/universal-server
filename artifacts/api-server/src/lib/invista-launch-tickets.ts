import crypto from "node:crypto";

/**
 * Short-lived, single-use handoff tickets.
 *
 * Tickets are intentionally ephemeral: they authorize only a single handoff,
 * never contain a Deriv token, and are invalidated on first successful consume.
 * A process restart invalidates all outstanding tickets (fail-closed).
 */
interface LaunchTicket {
  digest: string;
  userId: string;
  platform: "main" | "aura";
  expiresAt: number;
}

const tickets = new Map<string, LaunchTicket>();
const TTL_MS = Math.min(
  60_000,
  Math.max(10_000, Number(process.env.INVISTA_LAUNCH_TICKET_TTL_MS || 30_000)),
);

function digest(ticket: string): string {
  return crypto.createHash("sha256").update(ticket).digest("hex");
}

function prune(now = Date.now()): void {
  for (const [key, item] of tickets) {
    if (item.expiresAt <= now) tickets.delete(key);
  }
}

export function issueInvistaLaunchTicket(
  userId: string,
  platform: "main" | "aura",
): { ticket: string; expiresInSeconds: number } {
  if (!userId.trim()) throw new Error("A user ID is required.");
  prune();
  const ticket = crypto.randomBytes(32).toString("base64url");
  const key = digest(ticket);
  tickets.set(key, {
    digest: key,
    userId: userId.trim(),
    platform,
    expiresAt: Date.now() + TTL_MS,
  });
  return { ticket, expiresInSeconds: Math.floor(TTL_MS / 1000) };
}

export function consumeInvistaLaunchTicket(
  ticket: string,
): { userId: string; platform: "main" | "aura" } | null {
  prune();
  const raw = String(ticket || "").trim();
  if (!raw || raw.length > 128) return null;
  const key = digest(raw);
  const item = tickets.get(key);
  if (!item || item.expiresAt <= Date.now()) return null;
  // Delete before returning to guarantee single use even under concurrent calls.
  tickets.delete(key);
  return { userId: item.userId, platform: item.platform };
}
