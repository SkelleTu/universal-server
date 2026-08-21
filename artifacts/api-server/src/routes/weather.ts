import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { pgGetProjectByApiKey } from "../lib/pglite";

const router: IRouter = Router();
type AuthedRequest = Request & { project?: { id: number; name: string } };

type NormalizedWeather = {
  provider: string;
  observedAt: string;
  timeZone: string | null;
  conditionType: string;
  description: string;
  isDaytime: boolean;
  temperatureC: number | null;
  apparentTemperatureC: number | null;
  humidityPct: number | null;
  windKph: number | null;
  windDirectionDeg: number | null;
  windGustKph: number | null;
  visibilityKm: number | null;
  cloudCoverPct: number | null;
  rainMm: number | null;
  precipitationMm: number | null;
  weatherCode: number | null;
};

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

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectValue(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function toCelsius(value: unknown): number | null {
  const degrees = num(objectValue(value, "degrees"));
  if (degrees === null) return null;
  const unit = String(objectValue(value, "unit") ?? "CELSIUS").toUpperCase();
  return unit.includes("FAHRENHEIT") ? (degrees - 32) * (5 / 9) : degrees;
}

function toKph(value: unknown): number | null {
  const n = num(objectValue(value, "value"));
  if (n === null) return null;
  const unit = String(objectValue(value, "unit") ?? "KILOMETERS_PER_HOUR").toUpperCase();
  if (unit.includes("MILES")) return n * 1.609344;
  if (unit.includes("METERS")) return n * 3.6;
  return n;
}

function toKm(value: unknown): number | null {
  const n = num(objectValue(value, "distance")) ?? num(objectValue(value, "value"));
  if (n === null) return null;
  const unit = String(objectValue(value, "unit") ?? "KILOMETERS").toUpperCase();
  if (unit.includes("MILES")) return n * 1.609344;
  if (unit.includes("METERS")) return n / 1000;
  return n;
}

function googleDescription(value: unknown): string {
  const description = objectValue(value, "description");
  return String(objectValue(description, "text") ?? "Unknown");
}

async function fetchGoogleWeather(lat: number, lng: number, key: string): Promise<NormalizedWeather | null> {
  const url = new URL("https://weather.googleapis.com/v1/currentConditions:lookup");
  url.searchParams.set("key", key);
  url.searchParams.set("location.latitude", String(lat));
  url.searchParams.set("location.longitude", String(lng));

  const response = await fetch(url);
  if (!response.ok) return null;
  const payload = (await response.json()) as Record<string, unknown>;
  const condition = objectValue(payload, "weatherCondition");
  const wind = objectValue(payload, "wind");

  return {
    provider: "google-weather",
    observedAt: String(payload.currentTime ?? new Date().toISOString()),
    timeZone: String(objectValue(objectValue(payload, "timeZone"), "id") ?? "") || null,
    conditionType: String(objectValue(condition, "type") ?? "UNKNOWN"),
    description: googleDescription(condition),
    isDaytime: Boolean(payload.isDaytime),
    temperatureC: toCelsius(payload.temperature),
    apparentTemperatureC: toCelsius(payload.feelsLikeTemperature),
    humidityPct: num(payload.relativeHumidity),
    windKph: toKph(wind),
    windDirectionDeg: num(objectValue(objectValue(wind, "direction"), "degrees")),
    windGustKph: toKph(objectValue(wind, "gust")),
    visibilityKm: toKm(payload.visibility),
    cloudCoverPct: num(payload.cloudCover),
    rainMm: num(objectValue(objectValue(payload, "precipitation"), "qpf")) ?? num(objectValue(payload, "precipitation")),
    precipitationMm: num(objectValue(objectValue(payload, "precipitation"), "qpf")) ?? num(objectValue(payload, "precipitation")),
    weatherCode: null,
  };
}

function openMeteoDescription(code: number | null): { type: string; description: string } {
  if (code === null) return { type: "UNKNOWN", description: "Unknown" };
  if (code === 0) return { type: "CLEAR", description: "Clear sky" };
  if ([1, 2].includes(code)) return { type: "PARTLY_CLOUDY", description: "Partly cloudy" };
  if (code === 3) return { type: "OVERCAST", description: "Overcast" };
  if ([45, 48].includes(code)) return { type: "FOG", description: "Fog" };
  if ([51, 53, 55, 56, 57].includes(code)) return { type: "DRIZZLE", description: "Drizzle" };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { type: "RAIN", description: "Rain" };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { type: "SNOW", description: "Snow" };
  if ([95, 96, 99].includes(code)) return { type: "THUNDERSTORM", description: "Thunderstorm" };
  return { type: "UNKNOWN", description: "Unknown" };
}

async function fetchOpenMeteoWeather(lat: number, lng: number): Promise<NormalizedWeather | null> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lng));
  url.searchParams.set("current", [
    "temperature_2m",
    "relative_humidity_2m",
    "apparent_temperature",
    "precipitation",
    "rain",
    "weather_code",
    "cloud_cover",
    "wind_speed_10m",
    "wind_direction_10m",
    "wind_gusts_10m",
    "visibility",
    "is_day",
  ].join(","));
  url.searchParams.set("timezone", "UTC");

  const response = await fetch(url);
  if (!response.ok) return null;
  const payload = (await response.json()) as { current?: Record<string, unknown>; timezone?: string };
  const current = payload.current;
  if (!current) return null;
  const code = num(current.weather_code);
  const weather = openMeteoDescription(code);

  return {
    provider: "open-meteo",
    observedAt: String(current.time ?? new Date().toISOString()),
    timeZone: payload.timezone ?? "UTC",
    conditionType: weather.type,
    description: weather.description,
    isDaytime: Boolean(current.is_day),
    temperatureC: num(current.temperature_2m),
    apparentTemperatureC: num(current.apparent_temperature),
    humidityPct: num(current.relative_humidity_2m),
    windKph: num(current.wind_speed_10m),
    windDirectionDeg: num(current.wind_direction_10m),
    windGustKph: num(current.wind_gusts_10m),
    visibilityKm: num(current.visibility) === null ? null : (num(current.visibility)! / 1000),
    cloudCoverPct: num(current.cloud_cover),
    rainMm: num(current.rain),
    precipitationMm: num(current.precipitation),
    weatherCode: code,
  };
}

router.get("/game/weather/current", authenticate, async (req: AuthedRequest, res): Promise<void> => {
  const lat = numberParam(req.query.lat, -22.3572);
  const lng = numberParam(req.query.lng, -47.3841);

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: "lat/lng inválidos" });
    return;
  }

  let data: NormalizedWeather | null = null;
  const key = googleKey();
  if (key) data = await fetchGoogleWeather(lat, lng, key);
  if (!data) data = await fetchOpenMeteoWeather(lat, lng);

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
