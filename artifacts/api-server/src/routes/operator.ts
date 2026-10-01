import crypto from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { pgGetOrCreateSystemProject, pgListCollection, pgInsertCollectionItem } from "../lib/pglite";
import { requireDashboard } from "./dashboard";

const router: IRouter = Router();
const COLLECTION = "operator_credentials";
const TOKEN_COLLECTION = "operator_tokens";

function encryptionKey(): Buffer {
  const raw = String(process.env.UNIVERSAL_OPERATOR_ENCRYPTION_KEY ?? "").trim();
  if (!raw) throw new Error("UNIVERSAL_OPERATOR_ENCRYPTION_KEY is required for credential storage.");
  return crypto.createHash("sha256").update(raw).digest();
}

function encrypt(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decrypt(value: string): string {
  const [ivRaw, tagRaw, dataRaw] = String(value).split(".");
  if (!ivRaw || !tagRaw || !dataRaw) throw new Error("Invalid encrypted credential.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataRaw, "base64url")), decipher.final()]).toString("utf8");
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function validOperator(req: Request, res: Response): Promise<boolean> {
  const supplied = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!supplied) {
    res.status(401).json({ ok: false, error: "Operator token required." });
    return false;
  }
  const project = await pgGetOrCreateSystemProject();
  const rows = await pgListCollection(project.id, TOKEN_COLLECTION, 100);
  const hash = tokenHash(supplied);
  const record = rows.find((row) => row.data.tokenHash === hash && row.data.revoked !== true);
  if (!record) {
    res.status(401).json({ ok: false, error: "Invalid operator token." });
    return false;
  }
  return true;
}

router.get("/operator/status", async (req, res): Promise<void> => {
  if (!(await validOperator(req, res))) return;
  const project = await pgGetOrCreateSystemProject();
  const rows = await pgListCollection(project.id, COLLECTION, 100);
  res.json({
    ok: true,
    service: "universal-server-operator",
    credentials: rows.map((row) => ({
      id: row.id,
      platform: row.data.platform,
      label: row.data.label,
      endpoint: row.data.endpoint,
      updatedAt: row.updated_at,
    })),
  });
});

router.get("/operator/credentials/:platform", async (req, res): Promise<void> => {
  if (!(await validOperator(req, res))) return;
  const platform = String(req.params.platform ?? "").trim().toLowerCase();
  const project = await pgGetOrCreateSystemProject();
  const rows = await pgListCollection(project.id, COLLECTION, 100);
  const row = rows.find((item) => String(item.data.platform ?? "").toLowerCase() === platform);
  if (!row) {
    res.status(404).json({ ok: false, error: "Credential not found.", platform });
    return;
  }
  try {
    const payload = JSON.parse(decrypt(String(row.data.encryptedPayload)));
    res.json({ ok: true, platform, ...payload, endpoint: row.data.endpoint ?? null, label: row.data.label ?? platform });
  } catch {
    res.status(500).json({ ok: false, error: "Credential could not be decrypted." });
  }
});

router.post("/operator/token", requireDashboard, async (req, res): Promise<void> => {
  const token = crypto.randomBytes(48).toString("base64url");
  const project = await pgGetOrCreateSystemProject();
  await pgInsertCollectionItem(project.id, TOKEN_COLLECTION, {
    label: String(req.body?.label ?? "ChatGPT Operator").trim() || "ChatGPT Operator",
    tokenHash: tokenHash(token),
    createdAt: new Date().toISOString(),
    revoked: false,
  });
  res.status(201).json({ ok: true, token, warning: "Copy this token now. It is not stored in plaintext." });
});

router.post("/operator/credentials", requireDashboard, async (req, res): Promise<void> => {
  const platform = String(req.body?.platform ?? "").trim().toLowerCase();
  const label = String(req.body?.label ?? platform).trim();
  const endpoint = String(req.body?.endpoint ?? "").trim();
  const payload = req.body?.credentials;
  if (!platform || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    res.status(400).json({ ok: false, error: "platform and credentials object are required." });
    return;
  }
  try {
    const project = await pgGetOrCreateSystemProject();
    const existing = await pgListCollection(project.id, COLLECTION, 100);
    const same = existing.find((row) => String(row.data.platform ?? "").toLowerCase() === platform);
    const data = {
      platform,
      label,
      endpoint,
      encryptedPayload: encrypt(JSON.stringify(payload)),
      updatedAt: new Date().toISOString(),
    };
    if (same) {
      res.status(409).json({ ok: false, error: "Credential already exists. Replace it from the dashboard after revocation support is enabled.", id: same.id });
      return;
    }
    const created = await pgInsertCollectionItem(project.id, COLLECTION, data);
    res.status(201).json({ ok: true, id: created.id, platform, label, endpoint });
  } catch (error) {
    res.status(503).json({ ok: false, error: error instanceof Error ? error.message : "Credential storage unavailable." });
  }
});

export default router;
