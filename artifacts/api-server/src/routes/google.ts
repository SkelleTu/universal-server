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

function isArarasAddress(address: string): boolean {
  return /\bararas\b/i.test(address);
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

router.get("/game/google/autocomplete", async (req: Request, res: Response): Promise<void> => {
  const googleKey = key();
  const input = String(req.query.input ?? "").trim();
  const sessionToken = String(req.query.sessionToken ?? "").trim();
  if (!googleKey) { res.status(503).json({ error: "GOOGLE_MAPS_API_KEY não configurada" }); return; }
  if (input.length < 3) { res.json({ predictions: [] }); return; }

  const body: Record<string, unknown> = {
    input,
    includedRegionCodes: ["br"],
    languageCode: "pt-BR",
    locationBias: {
      circle: {
        center: { latitude: -22.3574, longitude: -47.3841 },
        radius: 15000,
      },
    },
  };
  if (sessionToken) body.sessionToken = sessionToken;

  try {
    const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": googleKey,
        "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat.mainText.text,suggestions.placePrediction.structuredFormat.secondaryText.text",
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      res.status(502).json({ error: "Google Places Autocomplete falhou", details: payload?.error?.message ?? "Google API error" });
      return;
    }

    const predictions = Array.isArray(payload?.suggestions)
      ? payload.suggestions
          .map((item: {
            placePrediction?: {
              placeId?: string;
              text?: { text?: string };
              structuredFormat?: {
                mainText?: { text?: string };
                secondaryText?: { text?: string };
              };
            };
          }) => {
            const prediction = item.placePrediction;
            return prediction?.placeId && prediction.text?.text
              ? {
                  placeId: prediction.placeId,
                  displayName: prediction.text.text,
                  mainText: prediction.structuredFormat?.mainText?.text ?? prediction.text.text,
                  secondaryText: prediction.structuredFormat?.secondaryText?.text ?? "",
                }
              : null;
          })
          .filter(Boolean)
          .slice(0, 5)
      : [];

    res.json({ predictions });
  } catch {
    res.status(502).json({ error: "Não foi possível consultar o Google Places Autocomplete" });
  }
});

router.get("/game/google/place-details", async (req: Request, res: Response): Promise<void> => {
  const googleKey = key();
  const placeId = String(req.query.placeId ?? "").trim();
  const sessionToken = String(req.query.sessionToken ?? "").trim();
  if (!googleKey) { res.status(503).json({ error: "GOOGLE_MAPS_API_KEY não configurada" }); return; }
  if (!placeId) { res.status(400).json({ error: "placeId é obrigatório" }); return; }

  try {
    const params = new URLSearchParams();
    if (sessionToken) params.set("sessionToken", sessionToken);
    const query = params.toString();
    const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}${query ? `?${query}` : ""}`, {
      headers: {
        "X-Goog-Api-Key": googleKey,
        "X-Goog-FieldMask": "id,formattedAddress,location",
      },
    });
    const payload = await response.json();
    if (!response.ok) {
      res.status(502).json({ error: "Google Place Details falhou", details: payload?.error?.message ?? "Google API error" });
      return;
    }

    const formattedAddress = String(payload?.formattedAddress ?? "").trim();
    const lat = Number(payload?.location?.latitude);
    const lon = Number(payload?.location?.longitude);
    if (!formattedAddress || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      res.status(502).json({ error: "Google não retornou uma localização válida para este lugar" });
      return;
    }
    if (!isArarasAddress(formattedAddress)) {
      res.status(403).json({ error: "Public search is available only for Araras, SP addresses" });
      return;
    }

    res.json({
      placeId: String(payload?.id ?? placeId),
      displayName: formattedAddress,
      lat,
      lon,
    });
  } catch {
    res.status(502).json({ error: "Não foi possível consultar os detalhes do lugar no Google" });
  }
});

router.get("/game/google/geocode", async (req: Request, res): Promise<void> => {
  const googleKey = key();
  const address = String(req.query.address ?? "").trim();
  if (!googleKey) { res.status(503).json({ error: "GOOGLE_MAPS_API_KEY não configurada" }); return; }
  if (!address) { res.status(400).json({ error: "address é obrigatório" }); return; }
  if (!isArarasAddress(address)) { res.status(403).json({ error: "Public search is available only for Araras, SP addresses" }); return; }
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
