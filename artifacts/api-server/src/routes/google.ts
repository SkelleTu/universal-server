import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { pgGetProjectByApiKey } from "../lib/pglite";

const router: IRouter = Router();
type AuthedRequest = Request & { project?: { id: number; name: string } };

async function authenticate(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const apiKey = (req.headers["x-api-key"] as string | undefined) ?? (req.query["api_key"] as string | undefined);
  if (!apiKey) {
    res.status(401).json({ error: "Header x-api-key é obrigatório" });
    return;
  }
  const project = await pgGetProjectByApiKey(apiKey);
  if (!project) {
    res.status(403).json({ error: "Chave de API inválida" });
    return;
  }
  req.project = { id: project.id, name: project.name };
  next();
}

function key(): string | null {
  const value = process.env.GOOGLE_MAPS_API_KEY?.trim();
  return value || null;
}

router.get("/game/google/capabilities", authenticate, (_req: AuthedRequest, res): void => {
  const configured = Boolean(key());
  res.json({
    configured,
    primary: {
      streetViewStatic: configured && process.env.STREET_VIEW_STATIC_API_ENABLED !== "false",
      weather: configured && process.env.GOOGLE_WEATHER_API_ENABLED !== "false",
      geocoding: configured,
      places: configured,
      roads: configured,
      elevation: configured,
      routes: configured,
      timeZone: configured,
    },
    future: {
      mapTilesStreetView: true,
      photorealistic3d: true,
      aerialView: true,
      navigationSdk: true,
    },
  });
});

router.get("/game/google/geocode", authenticate, async (req: AuthedRequest, res): Promise<void> => {
  const googleKey = key();
  const address = String(req.query.address ?? "").trim();
  if (!googleKey) { res.status(503).json({ error: "GOOGLE_MAPS_API_KEY não configurada" }); return; }
  if (!address) { res.status(400).json({ error: "address é obrigatório" }); return; }
  const params = new URLSearchParams({ address, key: googleKey });
  const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`);
  const payload = await response.json();
  res.status(response.ok ? 200 : 502).json(payload);
});

router.get("/game/google/reverse-geocode", authenticate, async (req: AuthedRequest, res): Promise<void> => {
  const googleKey = key();
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!googleKey) { res.status(503).json({ error: "GOOGLE_MAPS_API_KEY não configurada" }); return; }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) { res.status(400).json({ error: "lat e lng válidos são obrigatórios" }); return; }
  const params = new URLSearchParams({ latlng: `${lat},${lng}`, key: googleKey });
  const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`);
  const payload = await response.json();
  res.status(response.ok ? 200 : 502).json(payload);
});

router.get("/game/google/elevation", authenticate, async (req: AuthedRequest, res): Promise<void> => {
  const googleKey = key();
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!googleKey) { res.status(503).json({ error: "GOOGLE_MAPS_API_KEY não configurada" }); return; }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) { res.status(400).json({ error: "lat e lng válidos são obrigatórios" }); return; }
  const params = new URLSearchParams({ locations: `${lat},${lng}`, key: googleKey });
  const response = await fetch(`https://maps.googleapis.com/maps/api/elevation/json?${params.toString()}`);
  const payload = await response.json();
  res.status(response.ok ? 200 : 502).json(payload);
});

router.get("/game/google/timezone", authenticate, async (req: AuthedRequest, res): Promise<void> => {
  const googleKey = key();
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const timestamp = Number(req.query.timestamp ?? Math.floor(Date.now() / 1000));
  if (!googleKey) { res.status(503).json({ error: "GOOGLE_MAPS_API_KEY não configurada" }); return; }
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(timestamp)) { res.status(400).json({ error: "lat, lng e timestamp válidos são obrigatórios" }); return; }
  const params = new URLSearchParams({ location: `${lat},${lng}`, timestamp: String(Math.floor(timestamp)), key: googleKey });
  const response = await fetch(`https://maps.googleapis.com/maps/api/timezone/json?${params.toString()}`);
  const payload = await response.json();
  res.status(response.ok ? 200 : 502).json(payload);
});

export default router;
