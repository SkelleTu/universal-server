import crypto from "crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { pgGetOrCreateSystemProject, pgInsertCollectionItem, pgListCollection, pgGetGameCache, pgUpsertGameCache } from "../lib/pglite";

const router: IRouter = Router();
const sessionTtlMs = 30 * 24 * 60 * 60 * 1000;
type Account = { username: string; passwordHash: string; playerId: string; createdAt: string };

function username(value: unknown): string { return String(value ?? "").trim().toLowerCase(); }
function validUsername(value: string): boolean { return /^[a-z0-9_]{3,24}$/.test(value); }
function passwordHash(password: string, salt = crypto.randomBytes(16).toString("hex")): string {
  return `${salt}:${crypto.scryptSync(password, salt, 32).toString("hex")}`;
}
function passwordMatches(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":"); if (!salt || !hash) return false;
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), crypto.scryptSync(password, salt, 32));
}
async function createSession(account: Account): Promise<string> {
  const project = await pgGetOrCreateSystemProject(); const token = crypto.randomBytes(32).toString("hex");
  await pgUpsertGameCache(project.id, "sessions", token, { playerId: account.playerId, username: account.username }, new Date(Date.now() + sessionTtlMs).toISOString());
  return token;
}
router.post("/game/auth/register", async (req: Request, res: Response): Promise<void> => {
  const name = username(req.body?.username); const password = String(req.body?.password ?? "");
  if (!validUsername(name)) { res.status(400).json({ error: "Usuário deve ter 3 a 24 letras, números ou _." }); return; }
  if (password.length < 6) { res.status(400).json({ error: "Senha deve ter pelo menos 6 caracteres." }); return; }
  const project = await pgGetOrCreateSystemProject(); const accounts = await pgListCollection(project.id, "accounts", 1000);
  if (accounts.some((row) => String(row.data.username) === name)) { res.status(409).json({ error: "Esse usuário já existe." }); return; }
  const account: Account = { username: name, passwordHash: passwordHash(password), playerId: crypto.randomUUID(), createdAt: new Date().toISOString() };
  await pgInsertCollectionItem(project.id, "accounts", account); const token = await createSession(account);
  res.status(201).json({ token, playerId: account.playerId, username: account.username, requiresHome: true });
});
router.post("/game/auth/login", async (req: Request, res: Response): Promise<void> => {
  const name = username(req.body?.username); const password = String(req.body?.password ?? ""); const project = await pgGetOrCreateSystemProject();
  const row = (await pgListCollection(project.id, "accounts", 1000)).find((item) => String(item.data.username) === name);
  const account = row?.data as Account | undefined;
  if (!account || !passwordMatches(password, account.passwordHash)) { res.status(401).json({ error: "Usuário ou senha incorretos." }); return; }
  const token = await createSession(account); res.json({ token, playerId: account.playerId, username: account.username });
});
router.get("/game/auth/session", async (req: Request, res: Response): Promise<void> => {
  const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim(); if (!token) { res.status(401).json({ error: "Sessão obrigatória." }); return; }
  const project = await pgGetOrCreateSystemProject(); const session = await pgGetGameCache(project.id, "sessions", token);
  if (!session) { res.status(401).json({ error: "Sessão expirada." }); return; } res.json({ ok: true, ...session.data });
});
export default router;
