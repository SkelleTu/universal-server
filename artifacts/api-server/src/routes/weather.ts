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

function numberParam(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function googleKey(): string | null {
  const value = process.env.GOOGLE_MAPS_API_KEY?.trim();
  return value || null;
}

async function fetchGoogleWeather(lat: number, lng: number, key: string): Promise<Record<string, unknown> | null> {
  const url = new URL("https://weather.googleapis.com/v1/currentConditions:lookup");
  url.searchParams.set("key", key);
  url.searchParams.set("location.latitude", String(lat));
  url.searchParams.set("location.longitude", String(lng));

  const response = await fetch(url);
  if (!response.ok) return null;
  const payload = (await response.json()) as Record<string, unknown>;
  return {
    provider: "google-weather",
    observedAt: payload.currentTime ?? new Date().toISOString(),
    timeZone: payload.timeZone ?? null,
    isDaytime: payload.isDaytime ?? null,
    weatherCondition: payload.weatherCondition ?? null,
    temperature: payload.temperature ?? null,
    feelsLike: payload.feelsLikeTemperature ?? null,
    humidity: payload.relativeHumidity ?? null,
    wind: payload.wind ?? null,
    visibility: payload.visibility ?? null,
    cloudCover: payload.cloudCover ?? null,
    precipitation: payload.precipitation ?? null,
    pressure: payload.airPressure ?? null,
    history: payload.currentConditionsHistory ?? null,
  };
}

async function fetchOpenMeteoWeather(lat: number, lng: number): Promise<Record<string, unknown> | null> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lng));
  url.searchParams.set("current", [
    "temperature_2m",
    "relative_humidity_2m",
    "apparent_temperature",
    "precipitation",
    "rain",
    "showers",
    "snowfall",
    "weather_code",
    "cloud_cover",
    "wind_speed_10m",
    "wind_direction_10m",
    "wind_gusts_10m",
    "visibility",
    "shortwave_radiation",
    "is_day",
  ].join(","));
  url.searchParams.set("timezone", "UTC");

  const response = await fetch(url);
  if (!response.ok) return null;
  const payload = (await response.json()) as { current?: Record<string, unknown>; timezone?: string };
  if (!payload.current) return null;
  return {
    provider: "open-meteo",
    observedAt: payload.current.time ?? new Date().toISOString(),
    timeZone: payload.timezone ?? "UTC",
    data: payload.current,
  };
}

router.get("/game/weather/current", authenticate, async (req: AuthedRequest, res): Promise<void> => {
  const lat = numberParam(req.query.lat, -22.3572);
  const lng = numberParam(req.query.lng, -47.3841);

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: "lat/lng inválidos" });
    return;
  }

  let data: Record<string, unknown> | null = null;
  const key = googleKey();

  if (key) {
    data = await fetchGoogleWeather(lat, lng, key);
  }
  if (!data) {
    data = await fetchOpenMeteoWeather(lat, lng);
  }

  if (!data) {
    res.status(502).json({ error: "Não foi possível obter as condições meteorológicas atuais" });
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    location: { latitude: lat, longitude: lng },
    serverTime: new Date().toISOString(),
    data,
  });
});

export default router;
