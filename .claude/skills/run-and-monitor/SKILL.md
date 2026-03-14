---
name: run-and-monitor
description: Start the Tempo/Deal Brain development environment and monitor application logs. Use when the user asks to start the app, check logs, debug backend issues, or monitor running services.
allowed-tools: Bash, Read, Grep, Glob
---

# Run & Monitor Logs — Tempo Dev Environment

You are an agent responsible for starting the Tempo (Deal Brain) development environment and monitoring its logs. This skill teaches you how to operate the local dev stack.

## Architecture Overview

The app is a Bun monorepo with 4 process-compose processes and 6+ Docker services:

**Process-compose services** (app code, runs in foreground):
| Process | App | Port | Purpose |
|---------|-----|------|---------|
| api | apps/backend | 4173 | NestJS API server (tRPC + REST) |
| worker | apps/backend | — | BullMQ background job processor |
| web | apps/frontend | 5173 | Vite dev server (React SPA) |
| proxy | apps/proxy | 3000 | Cloudflare Workers local proxy (Wrangler) |

**Docker services** (infrastructure):
| Service | Port | Purpose |
|---------|------|---------|
| postgres (pgvector) | 54321 | Main database |
| electric | 30000 | ElectricSQL real-time sync |
| valkey | 6379 | Redis-compatible cache (BullMQ) |
| minio | 9000/9001 | Local S3 object storage |
| local-kms | 8081 | AWS KMS simulator |
| caddy | 3001 | HTTPS reverse proxy (self-signed TLS) |

**Access the app at `https://localhost:3001`** — Caddy provides HTTPS, proxies to Wrangler on port 3000, which routes to api/web/proxy.

## Starting the Environment

### Full startup (recommended)
```bash
just up
```
This runs: `bun i` → `docker compose up -d` → `process-compose` (foreground, blocks terminal).

**IMPORTANT:** `process-compose` runs in the foreground and shows all logs interleaved. You cannot run other commands in the same terminal. Use a separate terminal for other operations.

### Start only Docker services (if app processes run separately)
```bash
just docker-up
```

### Start individual services
```bash
bun run api      # NestJS backend only
bun run web      # Vite frontend only
bun run proxy    # Cloudflare Workers proxy only
```

### Install deps + run migrations only
```bash
just sync
```

## Checking Service Status

### Docker services
```bash
docker compose ps          # Show running containers and health
docker compose logs -f     # Tail all Docker service logs
docker compose logs -f postgres   # Tail specific service
docker compose logs -f electric
```

### Process-compose
When `process-compose` is running, all 4 app process logs stream to the terminal. Each process is color-coded with labels.

If process-compose is NOT running, start individual services and capture their output:
```bash
bun run api 2>&1 | tee /tmp/api.log &
bun run web 2>&1 | tee /tmp/web.log &
```

## Log System Details

### Backend (NestJS + Pino)
- **Logger:** `nestjs-pino` (Pino HTTP logger)
- **Dev level:** `debug` with `pino-pretty` transport (human-readable colored output)
- **Production level:** `info` with raw JSON
- **Redacted:** `req.headers.cookie`, `res.headers.cookie`
- **Pattern:** Services use `private readonly logger = new Logger(ClassName.name)` then `this.logger.log()`, `.warn()`, `.error()`

### Frontend (Vite)
- Standard Vite dev server console output
- HMR updates logged to terminal
- Browser console for client-side errors

### Error Tracking
- **Sentry:** Global exception filter captures unhandled errors (when `SENTRY_DSN` configured)
- **PostHog:** Event/exception tracking (when `POSTHOG_KEY` configured)
- **OpenTelemetry + Langfuse:** Distributed tracing for AI/LLM spans

### Key logging files
- `apps/backend/src/app.module.ts` — Logger module configuration
- `apps/backend/src/main.ts` — Bootstrap with logger setup
- `apps/backend/src/core/filters/all-exceptions.filter.ts` — Global error handler
- `apps/backend/src/core/instrumentation.ts` — Sentry + OpenTelemetry

## Extracting & Searching Logs

### From running process-compose
Process-compose outputs to stdout. To capture:
```bash
# Run with log capture
process-compose 2>&1 | tee /tmp/tempo-dev.log

# Then search logs
grep -i "error" /tmp/tempo-dev.log
grep "api" /tmp/tempo-dev.log    # Filter by process
```

### From Docker services
```bash
docker compose logs --since 5m postgres    # Last 5 minutes
docker compose logs --tail 100 electric    # Last 100 lines
```

### Database access
```bash
just psql          # Interactive psql session
just console       # NestJS REPL with full app context
```

## Common Debugging Tasks

### Check if services are healthy
```bash
docker compose ps
curl -k https://localhost:3001/   # Check Caddy/proxy
curl http://localhost:4173/       # Check API directly
curl http://localhost:5173/       # Check Vite directly
```

### Database reset
```bash
just db-reset    # Destroys all data, re-runs migrations
```

### Environment check
```bash
just env    # Shows local vs remote service connections
```

## Stopping Services

```bash
# Stop Docker services
just down

# Stop process-compose: Ctrl+C in its terminal
```

## Troubleshooting

- **Port conflicts:** Check `lsof -i :3001` (Caddy), `lsof -i :3000` (Wrangler), `lsof -i :4173` (API), `lsof -i :5173` (Vite)
- **Docker not starting:** Run `docker compose up -d --force-recreate`
- **Migrations failed:** Run `bun run db:migrate` from repo root
- **Stale deps:** Run `bun i` from repo root
- **Electric not syncing:** Check `docker compose logs electric` for connection errors to postgres
