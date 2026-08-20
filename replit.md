# Universal Server Dashboard

Dashboard for managing Universal Server projects, API keys, collections, and server health.

## Run & Operate

- `pnpm --filter @workspace/dashboard run dev` — run the dashboard (requires `PORT=23183 BASE_PATH=/`)
- `pnpm --filter @workspace/api-server run dev` — run the API server (requires `PORT=8080`)
- `pnpm run typecheck` — full typecheck across all packages
- `PORT=3000 BASE_PATH=/ pnpm --filter @workspace/dashboard run build` — build the publishable dashboard
- `pnpm --filter @workspace/api-server run build` — bundle the API server
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- The API uses embedded PGlite/SQLite storage by default; `DATABASE_URL` is only required by the optional Drizzle/Postgres library.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/dashboard` — React/Vite web app served at `/`
- `artifacts/api-server` — Express API served at `/api`; its production bundle can serve the dashboard as a SPA
- `artifacts/mockup-sandbox` — internal component preview server at `/__mockup`
- `lib/api-spec/openapi.yaml` — API contract source of truth
- `lib/db/src/schema` — Drizzle schema source
- `artifacts/*/.replit-artifact/artifact.toml` — artifact development and production configuration

## Architecture decisions

- The dashboard is the root web artifact; the API is mounted under `/api`.
- Production deployment is configured through the artifact manifests rather than a root run command.
- The API initializes embedded PGlite and SQLite mirrors before listening.

## Product

Users authenticate with a dashboard key, monitor server health and usage, create projects with API keys, and manage project collections.

## User preferences

- The imported project should be kept publishable without restructuring its pnpm workspace.

## Gotchas

- Use Node 24 and pnpm 10 as declared by the root package.
- Dashboard development requires both `PORT` and `BASE_PATH`.
- The full root build also includes the internal mockup sandbox; the publish path builds the dashboard and API artifacts directly.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
