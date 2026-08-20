# Clamour in the Darkness integration

The Universal Server is the persistent backend/gateway for **Clamour in the Darkness**.

## Runtime model

- The game client remains responsible for rendering, physics, animation, audio, camera and input.
- This server is responsible for persistent/shared state, API caching, player/world data and external-data coordination.
- Primary database: PGlite (embedded PostgreSQL).
- Secondary mirror: SQLite (`data/universal-server.db`).
- Database files are intentionally ignored by Git today. They are runtime state, not source code.

## Authentication

Game requests use the project API key in the `x-api-key` header. Never commit the key to GitHub or ship an unrestricted secret in source code.

## Clamour endpoints

All `/api/game/*` endpoints require `x-api-key`.

### `GET /api/game/status`

Returns server, database, game-version and publication-expiration status. The response is `200` when both databases are healthy and `503` when either is degraded.

### `GET /api/game/manifest`

Returns the integration contract, supported cache namespaces and persistence information.

### `GET /api/game/cache/:namespace/:cacheKey`

Reads a persistent cached item. A missing or expired item returns `404` with `hit: false`.

### `PUT /api/game/cache/:namespace/:cacheKey`

Upserts a cache item:

```json
{
  "data": { "provider": "google", "payload": {} },
  "expiresAt": null
}
```

Use `expiresAt: null` for durable game/world data. Use an ISO timestamp for renewable external-data caches such as weather.

### `DELETE /api/game/cache/:namespace/:cacheKey`

Deletes one cached item.

## Recommended namespaces

- `maps`
- `streetview`
- `places`
- `roads`
- `elevation`
- `weather`
- `world`
- `objects`
- `players`
- `clans`
- `events`

The server does not automatically call Google APIs. The Clamour integration layer should call a provider only on a cache miss, persist the result, and reuse the cached result afterward whenever the provider's terms permit it.

## Health and expiration detection

Public health endpoint:

`GET /api/healthz`

It reports PGlite health, SQLite health, uptime, server time and the configured `SERVER_EXPIRATION_AT`.

For the game, prefer `/api/game/status` because it also identifies the project and game version.

When running on Replit Free, update `SERVER_EXPIRATION_AT` whenever a new publication expiration date is known. The game can then show a clear infrastructure warning instead of confusing a backend outage with a game failure.

## Deployment

For the current Replit publication, configure:

- `GAME_VERSION`
- `SERVER_VERSION`
- `SERVER_EXPIRATION_AT`
- `CORS_ORIGINS`
- `JSON_BODY_LIMIT`

Never put Google Maps/Street View keys or the Universal Server project API key into this repository.
