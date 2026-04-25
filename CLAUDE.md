# Quotid

Voice-agent journaling app. Built as portfolio + interview prep for telli.com (YC AI voice-agent startup); stack deliberately mirrors theirs.

**Status: shipped to production 2026-04-25.** End-to-end demo live at `https://quotid.johnmoorman.com`.

## Production

- **App:** `https://quotid.johnmoorman.com` (Next.js)
- **Bot:** `https://v.quotid.johnmoorman.com` (Pipecat WSS public; POST `/calls` is Caddy-403'd, internal only)
- **Host:** AWS Lightsail us-east-1, `3.214.75.222`, Ubuntu 22.04
- **Compose stack:** `temporal` (start-dev mode) · `worker` (Python Temporal) · `bot` (Pipecat FastAPI) · `web` (Next.js standalone) · `caddy` (auto-TLS)
- **DB:** Neon Postgres dev branch via Prisma; dual-URL pattern (`DATABASE_URL` pooled / `DIRECT_URL` direct for migrations)

## Local dev

Cloudflared tunnel `quotid-voice` (token-based, run via apt-installed `cloudflared`) routes:
- `quodev.johnmoorman.com` → `http://localhost:3000`
- `quovoice.johnmoorman.com` → `http://localhost:8000`

Five processes (separate terminals):
```bash
~/.temporalio/bin/temporal server start-dev --ui-port 8233
cd workers/temporal-worker && uv run python -m quotid_worker.main
cd apps/pipecat-bot && uv run uvicorn quotid_bot.server:app --host 0.0.0.0 --port 8000 --workers 1
npm run dev --workspace=@quotid/web
cloudflared tunnel --no-autoupdate run --token <TOKEN>
```

`.env` at repo root is symlinked into `apps/web/.env` so Next.js picks it up. **Login passcode:** `quotid2026`.

## Deploy

```bash
ssh ubuntu@3.214.75.222
cd ~/quotid && git pull
sg docker -c "bash scripts/deploy.sh"
```

`scripts/deploy.sh` is idempotent — installs Docker if missing, validates `.env`, runs `docker compose up -d --build`.

## Stack invariants — DO NOT re-litigate

- **Prisma 6, not 7.** v7 moved datasource to `prisma.config.ts`; ecosystem hasn't caught up.
- **cuid(), not cuid(2).** `prisma-client-python` 0.15 bundles a Prisma 5.x engine that doesn't parse `cuid(2)`. v1 cuid is 25-char and collision-safe enough for MVP.
- **Deepgram Aura TTS, not Cartesia.** Cartesia trial ran out mid-build. The empty-subclass Modal swap point (`QuotidDeepgramTTSService`) is preserved.
- **OpenAI service import path:** `pipecat.services.openai.llm`, not `pipecat.services.openai`. Pipecat 1.0.0 made it a package without top-level re-exports.
- **`@temporalio/client` async completion:** `client.activity.complete({workflowId, activityId}, payload)` directly. There is no `getAsyncCompletionHandle`.
- **Forwarded headers everywhere.** Behind cloudflared (dev) or Caddy (prod), `req.url` reflects internal `localhost:3000`. proxy.ts, all auth routes, the watchdog, and the bot `/twiml` all read `x-forwarded-proto` + `x-forwarded-host`.
- **`on_client_disconnected` cancels the pipeline task.** Without it `runner.run()` hangs after WSS close and the outcome never posts to Temporal.
- **`/api/webhooks/` is in `proxy.ts` PUBLIC_PREFIXES.** Twilio status callbacks must not be redirected to /login.
- **`uvicorn --workers=1` (single worker)** — bot has an in-process correlation registry (`call_sid → workflow_id`); multi-worker would split it.
- **Caddy 403s public POST `/calls`** (decision #14). Worker hits the bot via `BOT_INTERNAL_URL=http://bot:8000` over the docker network.

## Commit style — enforced by PreToolUse hook

Subject-only. No body. No "feat:"/"fix:"/"docs:" prefix. No Co-Authored-By. No HEREDOC. Single `-m` flag. Tutorial-grade granularity (commit per logical change, not per task). The hook at `~/.claude/hooks/no-commit-body.sh` will physically block violations — don't try to circumvent.

## Common debug paths

| Symptom | Likely cause | Fix |
|---|---|---|
| Login redirects to wrong host | Forwarded-header handling broke | Check `req.headers.get("x-forwarded-host")` is reaching Next.js |
| Twilio status callback 403 | Signature verified against wrong URL | Watchdog must construct URL from forwarded headers |
| Workflow stuck `DIALING` | Bot crashed mid-call OR pipeline didn't terminate | Check `runner.run` exception path; verify `on_client_disconnected` registered |
| No journal entry after call | `store_entry` retries (3) exhausted on a Prisma error | `MissingRequiredValueError` → use `connect: {id}` for relations; `datetime` not `date` for entryDate; `prisma.Json(...)` wrapper for JSON fields |
| Bot won't reach worker | Wrong URL | Dev: `BOT_INTERNAL_URL=http://localhost:8000`. Prod: `http://bot:8000` (set in compose env override) |

## Repo layout

```
quotid/
├── apps/
│   ├── web/                    # Next.js 16, Tailwind, TanStack Query, Prisma client
│   └── pipecat-bot/            # Python 3.12 + uv, FastAPI, Pipecat 1.0.0
├── workers/
│   └── temporal-worker/        # Python 3.12 + uv, Temporal SDK, prisma-client-python
├── prisma/
│   └── schema.prisma           # Single source of truth for DB schema
├── compose.yaml                # Production stack (5 services)
├── Caddyfile                   # quotid.* / v.quotid.* with auto-TLS
├── scripts/
│   └── deploy.sh               # Idempotent deploy on Lightsail
└── docs/
    ├── architecture/           # Current design (LikeC4, OpenAPI, pipecat, temporal)
    ├── architecture/deprecated/ # Stale Mermaid C4 + old session handoff
    └── superpowers/plans/      # Day-3 execution plan (historical)
```

## Outstanding work

Ordered by interview-impact:

1. **Schedule toggle** (Slice 6 in original plan) — proves the autonomous nightly use case. Currently only "trigger call" works. Wire `Temporal Schedule.create({scheduleId: 'journal:{userId}', spec: {calendars: [{hour:21, minute:0}], timeZone: user.timezone}, ...})`.
2. **Recording playback** — `CallSession.recordingUrl` is captured but never surfaced. Add `<audio src={...}>` on entry detail page.
3. **Missed-call entries** — `handle_missed_call` activity sets `CallSession.status=NO_ANSWER/FAILED` but the UI only lists `JournalEntry`s. Show a "we tried but couldn't reach you" pill on the journal list.
4. **Edit journal entry** — `body` + `generatedBody` separation exists in the schema for this; wire an edit form that sets `isEdited=true`.
5. **In-progress banner** — when a CallSession is `DIALING` or `IN_PROGRESS`, show a "Call in progress…" banner on the journal page. Polls status via TanStack Query.

Deferred indefinitely:

- **Modal + WhisperX canonical transcript** — `transcription-interface.md` design exists; flag is `CANONICAL_TRANSCRIPT_ENABLED`, currently unset.
- **Sliding-window session refresh** — fixed 30-day TTL until first re-login (skipped for MVP simplicity).
- **Public Temporal dashboard** — port 8233 is internal-only. SSH tunnel: `ssh -L 8233:localhost:8233 ubuntu@3.214.75.222`.
- **Multi-user** — schema is multi-user-shaped but `prisma.user.findFirst()` in the login route + single seeded user means only one human currently uses the system.

## Pointers

- **Architecture (current):** `docs/architecture/likec4/quotid.c4` (preview: `npx likec4 serve docs/architecture/likec4`), `docs/architecture/pipecat-pipeline.md`, `docs/architecture/temporal-workflow.md`, `docs/architecture/api/` (OpenAPI 3.1 + Server Actions)
- **Data model:** `prisma/schema.prisma`
- **Design history:** `docs/architecture/deprecated/` (early Mermaid C4s, old session handoffs), `docs/superpowers/plans/2026-04-25-day3-scaffolding.md` (the execution contract)
- **Memory:** `~/.claude/projects/-home-john-repos-quotid/memory/`

## User context

John Moorman, week 9 of a 10-projects-in-10-weeks challenge. Currently in Frankfurt; phone number `+4917630321460` (the verified Twilio recipient — placeholder `+15555550100` won't work on trial). Twilio FROM number `+18122203743`.
